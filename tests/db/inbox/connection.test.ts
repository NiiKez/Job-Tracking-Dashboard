import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDb } from "@/lib/server/db/client";
import {
  clearConnection,
  getRefreshToken,
  hasLiveConnection,
  markNeedsReconnect,
  normalizeScopes,
  saveConnection,
  type ConnectionGrant,
} from "@/lib/server/inbox/connection";
import { decryptToken, encryptToken, tokenKeyId } from "@/lib/server/inbox/oauth/token-crypto";
import { ensureDemoConnection } from "@/lib/server/inbox/repo";
import { getInboxStatus } from "@/lib/server/inbox/status";
import { MailSourceError } from "@/lib/server/inbox/sync/errors";
import { createUser, makeEmail } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";
import { restoreEnv, setEnv, signedInEnv } from "../../unit/auth/env";
import { GMAIL_SCOPE, inboxEnv, KEY_HEX, OLD_KEY_HEX, REFRESH_TOKEN } from "../../unit/inbox/connect-fakes";

// inbox_connections' token and status columns (src/lib/server/inbox/connection.ts) and the
// Settings view of them (src/lib/server/inbox/status.ts), on the real database.

const syncing = new Set<string>();
vi.mock("@/lib/server/inbox/sync/engine", () => ({
  abortSync: vi.fn(),
  isSyncing: (userId: string) => syncing.has(userId),
}));

const KEY = Buffer.from(KEY_HEX, "hex");
const OLD_KEY = Buffer.from(OLD_KEY_HEX, "hex");

const grant = (userId: string, overrides: Partial<ConnectionGrant> = {}): ConnectionGrant => ({
  googleSub: `sub-of-${userId}`,
  emailAddress: " Person@Example.com ",
  refreshToken: REFRESH_TOKEN,
  grantedScopes: ["openid", GMAIL_SCOPE, "openid"],
  ...overrides,
});

interface Row {
  status: string;
  google_sub: string;
  email_address: string;
  refresh_token_enc: string | null;
  granted_scopes: string[];
  history_id: string | null;
  backfill_state: string;
  backfill_done: number;
  next_sync_at: Date | null;
  last_error_code: string | null;
  last_error_at: Date | null;
  consecutive_failures: number;
}

async function row(userId: string): Promise<Row | undefined> {
  const [r] = await testSql()<Row[]>`
    SELECT status, google_sub, email_address, refresh_token_enc, granted_scopes, history_id, backfill_state,
      backfill_done, next_sync_at, last_error_code, last_error_at, consecutive_failures
    FROM inbox_connections WHERE user_id = ${userId}`;
  return r;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MailSourceError);
  expect((err as Error).message).not.toContain(REFRESH_TOKEN);
  return (err as MailSourceError).code;
}

describeDb("the inbox connection", () => {
  beforeEach(() => {
    signedInEnv();
    inboxEnv();
    syncing.clear();
  });
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  /* ------------------------------------------------------- connect */

  it("stores a connection: encrypted token, normalized address and scopes, a sync requested", async () => {
    const user = await createUser();
    await saveConnection(getDb(), user, grant(user));
    const r = (await row(user))!;
    expect(r).toMatchObject({
      status: "connected",
      google_sub: `sub-of-${user}`,
      email_address: "person@example.com",
      granted_scopes: [GMAIL_SCOPE, "openid"],
      history_id: null,
      backfill_state: "pending",
      last_error_code: null,
      consecutive_failures: 0,
    });
    expect(Math.abs(r.next_sync_at!.getTime() - Date.now())).toBeLessThan(60_000);
    // Never the plaintext; it decrypts only for this user.
    expect(r.refresh_token_enc).not.toContain(REFRESH_TOKEN);
    expect(r.refresh_token_enc).toMatch(new RegExp(`^v1\\.${tokenKeyId(KEY)}\\.`));
    expect(decryptToken(r.refresh_token_enc!, user, { current: KEY }).token).toBe(REFRESH_TOKEN);
    expect(() => decryptToken(r.refresh_token_enc!, "00000000-0000-4000-8000-000000000000", { current: KEY })).toThrow();
  });

  it("reconnects: new token, errors cleared, and the sync position, scan, ledger and linked mail kept", async () => {
    const user = await createUser();
    const sql = testSql();
    await saveConnection(getDb(), user, grant(user));
    await sql`
      UPDATE inbox_connections SET status = 'needs_reconnect', history_id = '987654', backfill_state = 'done',
        backfill_done = 42, last_error_code = 'token_revoked', last_error_at = now(), consecutive_failures = 3,
        next_sync_at = NULL
      WHERE user_id = ${user}`;
    await sql`INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result) VALUES (${user}, 'm1', 'ignored')`;
    const emailId = await makeEmail(user, { subject: "Your application" });
    await sql`UPDATE emails SET gmail_message_id = 'm2' WHERE id = ${emailId}`;
    const before = (await row(user))!.refresh_token_enc;

    await saveConnection(getDb(), user, grant(user, { refreshToken: "1//0a-newer-token", emailAddress: "person@example.com" }));
    const r = (await row(user))!;
    expect(r).toMatchObject({
      status: "connected",
      history_id: "987654",
      backfill_state: "done",
      backfill_done: 42,
      last_error_code: null,
      last_error_at: null,
      consecutive_failures: 0,
    });
    expect(r.next_sync_at).not.toBeNull();
    expect(r.refresh_token_enc).not.toBe(before);
    expect(decryptToken(r.refresh_token_enc!, user, { current: KEY }).token).toBe("1//0a-newer-token");
    const [{ seen }] = await sql<{ seen: number }[]>`SELECT count(*)::int AS seen FROM inbox_seen_messages WHERE user_id = ${user}`;
    expect(seen).toBe(1);
    const [{ mail }] = await sql<{ mail: number }[]>`SELECT count(*)::int AS mail FROM emails WHERE gmail_message_id = 'm2'`;
    expect(mail).toBe(1);
  });

  it("a Connect on the demo connection starts over: the demo's position, scan and last check are reset", async () => {
    // Development: the demo inbox (MAIL_SOURCE=fixture) was checked, then Gmail is connected.
    const user = await createUser();
    const sql = testSql();
    await ensureDemoConnection(getDb(), user);
    await sql`
      UPDATE inbox_connections SET history_id = '100015', backfill_state = 'done', backfill_after = now() - interval '30 days',
        backfill_total = 14, backfill_done = 14, last_sync_ok_at = now(), last_error_code = 'rate_limited',
        last_error_at = now(), consecutive_failures = 1
      WHERE user_id = ${user}`;
    await sql`INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result) VALUES (${user}, 'm1', 'ignored')`;

    await saveConnection(getDb(), user, grant(user));

    const [r] = await sql`SELECT * FROM inbox_connections WHERE user_id = ${user}`;
    expect(r).toMatchObject({
      status: "connected",
      demo: false,
      email_address: "person@example.com",
      history_id: null,
      backfill_state: "pending",
      backfill_after: null,
      backfill_total: null,
      backfill_done: 0,
      last_sync_ok_at: null,
      last_error_code: null,
      last_error_at: null,
      consecutive_failures: 0,
    });
    expect(decryptToken(r.refresh_token_enc, user, { current: KEY }).token).toBe(REFRESH_TOKEN);
    const [{ seen }] = await sql<{ seen: number }[]>`SELECT count(*)::int AS seen FROM inbox_seen_messages WHERE user_id = ${user}`;
    expect(seen).toBe(1);
    // Not shown as scanned or checked before Gmail was.
    expect(await getInboxStatus(getDb(), user)).toMatchObject({ state: "connected", lastCheckedAt: null, lastError: null });
  });

  it("refuses to store without a key, a malformed address or an empty token", async () => {
    const user = await createUser();
    inboxEnv({ key: "" });
    await expect(saveConnection(getDb(), user, grant(user))).rejects.toMatchObject({ name: "TokenCryptoError", problem: "no_key" });
    inboxEnv();
    await expect(saveConnection(getDb(), user, grant(user, { emailAddress: "nobody" }))).rejects.toBeInstanceOf(TypeError);
    await expect(saveConnection(getDb(), user, grant(user, { googleSub: "" }))).rejects.toBeInstanceOf(TypeError);
    await expect(saveConnection(getDb(), user, grant(user, { refreshToken: "" }))).rejects.toBeInstanceOf(TypeError);
    expect(await row(user)).toBeUndefined();
  });

  it("normalizes scopes", () => {
    expect(normalizeScopes(["b a", "a", "", "  c  "])).toEqual(["a", "b", "c"]);
    expect(normalizeScopes(["x".repeat(513)])).toEqual([]);
    expect(normalizeScopes([Array.from({ length: 40 }, (_, i) => `s${String(i).padStart(2, "0")}`).join(" ")])).toHaveLength(32);
  });

  /* ---------------------------------------------------- disconnect */

  it("disconnects: answers the removed token, keeps the row, idempotent", async () => {
    const user = await createUser();
    await saveConnection(getDb(), user, grant(user));
    await testSql()`UPDATE inbox_connections SET history_id = '555' WHERE user_id = ${user}`;
    const stored = (await row(user))!.refresh_token_enc;

    expect(await clearConnection(getDb(), user)).toBe(stored);
    expect(await row(user)).toMatchObject({ status: "disconnected", refresh_token_enc: null, history_id: "555" });
    expect(await clearConnection(getDb(), user)).toBeNull();
    expect(await row(user)).toMatchObject({ status: "disconnected" });

    const nobody = await createUser();
    expect(await clearConnection(getDb(), nobody)).toBeNull();
    expect(await row(nobody)).toBeUndefined();
  });

  /* ------------------------------------------------ needs reconnect */

  it("marks only a connected row as needs_reconnect, with the code", async () => {
    const user = await createUser();
    await saveConnection(getDb(), user, grant(user));
    expect(await markNeedsReconnect(getDb(), user, "token_revoked")).toBe(true);
    const r = (await row(user))!;
    expect(r).toMatchObject({ status: "needs_reconnect", last_error_code: "token_revoked" });
    expect(r.last_error_at).not.toBeNull();
    expect(r.refresh_token_enc).not.toBeNull();
    expect(await markNeedsReconnect(getDb(), user, "token_rejected")).toBe(false);
    expect((await row(user))!.last_error_code).toBe("token_revoked");

    // A sync that fails on the revoked token after a Disconnect leaves it disconnected.
    await clearConnection(getDb(), user);
    expect(await markNeedsReconnect(getDb(), user, "token_revoked")).toBe(false);
    expect((await row(user))!.status).toBe("disconnected");
    expect(await markNeedsReconnect(getDb(), await createUser(), "token_revoked")).toBe(false);
  });

  it("with the token a run read, marks only while that token is still stored (a Reconnect meanwhile wins)", async () => {
    const user = await createUser();
    await saveConnection(getDb(), user, grant(user));
    const old = (await row(user))!.refresh_token_enc;
    await saveConnection(getDb(), user, grant(user, { refreshToken: "1//0a-newer-token" }));
    const fresh = (await row(user))!.refresh_token_enc;

    expect(await markNeedsReconnect(getDb(), user, "token_revoked", { token: old })).toBe(false);
    expect(await row(user)).toMatchObject({ status: "connected", last_error_code: null, refresh_token_enc: fresh });
    expect(await markNeedsReconnect(getDb(), user, "token_revoked", { token: fresh })).toBe(true);
    expect(await row(user)).toMatchObject({ status: "needs_reconnect", last_error_code: "token_revoked" });

    // A demo connection has no token: null compares equal to none.
    const demo = await createUser();
    await ensureDemoConnection(getDb(), demo);
    expect(await markNeedsReconnect(getDb(), demo, "token_unreadable", { token: old })).toBe(false);
    expect(await markNeedsReconnect(getDb(), demo, "token_unreadable", { token: null })).toBe(true);
  });

  /* ------------------------------------------------ getRefreshToken */

  it("hands the engine the decrypted token", async () => {
    const user = await createUser();
    await saveConnection(getDb(), user, grant(user));
    expect(await getRefreshToken(user)).toBe(REFRESH_TOKEN);
    // needs_reconnect still has its token (the engine is not meant to run then, but may finish).
    await markNeedsReconnect(getDb(), user, "token_rejected");
    expect(await getRefreshToken(user, getDb())).toBe(REFRESH_TOKEN);
  });

  it("re-encrypts a row written with the previous key, and leaves a newer token alone", async () => {
    const user = await createUser();
    const sql = testSql();
    const old = encryptToken(REFRESH_TOKEN, user, { current: OLD_KEY });
    await sql`
      INSERT INTO inbox_connections (user_id, google_sub, email_address, status, refresh_token_enc)
      VALUES (${user}, 'sub-x', 'person@example.com', 'connected', ${old})`;

    // Without the previous key the row is unreadable.
    expect(await codeOf(getRefreshToken(user))).toBe("token_unreadable");

    inboxEnv({ previousKey: OLD_KEY_HEX });
    expect(await getRefreshToken(user)).toBe(REFRESH_TOKEN);
    const rotated = (await row(user))!.refresh_token_enc!;
    expect(rotated.split(".")[1]).toBe(tokenKeyId(KEY));
    expect(decryptToken(rotated, user, { current: KEY }).token).toBe(REFRESH_TOKEN);
    // Once rotated, the previous key is no longer needed.
    inboxEnv();
    expect(await getRefreshToken(user)).toBe(REFRESH_TOKEN);
  });

  it("logs and goes on when the re-encryption cannot be written", async () => {
    const user = await createUser();
    const old = encryptToken(REFRESH_TOKEN, user, { current: OLD_KEY });
    await testSql()`
      INSERT INTO inbox_connections (user_id, google_sub, email_address, status, refresh_token_enc)
      VALUES (${user}, 'sub-x', 'person@example.com', 'connected', ${old})`;
    inboxEnv({ previousKey: OLD_KEY_HEX });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A Db whose second query (the UPDATE) fails.
    let calls = 0;
    const flaky = ((...args: Parameters<ReturnType<typeof testSql>>) => {
      calls++;
      if (calls === 2) return Promise.reject(new Error("connection lost"));
      return testSql()(...args);
    }) as unknown as ReturnType<typeof testSql>;
    expect(await getRefreshToken(user, flaky)).toBe(REFRESH_TOKEN);
    expect(warn.mock.calls.flat().join(" ")).toContain("re-encrypting the stored token failed");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(REFRESH_TOKEN);
    expect((await row(user))!.refresh_token_enc).toBe(old);
  });

  it("fails with stable codes: no key, no token, a broken token, no connection", async () => {
    const user = await createUser();
    await saveConnection(getDb(), user, grant(user));

    inboxEnv({ key: "" });
    expect(await codeOf(getRefreshToken(user))).toBe("token_key_missing");
    inboxEnv({ key: OLD_KEY_HEX });
    expect(await codeOf(getRefreshToken(user))).toBe("token_unreadable");
    inboxEnv();

    // Copied to another user's row: the user id is the associated data, so it does not decrypt.
    const other = await createUser();
    const stored = (await row(user))!.refresh_token_enc;
    await testSql()`
      INSERT INTO inbox_connections (user_id, google_sub, email_address, status, refresh_token_enc)
      VALUES (${other}, 'sub-y', 'other@example.com', 'connected', ${stored})`;
    expect(await codeOf(getRefreshToken(other))).toBe("token_unreadable");

    // A demo connection has no token.
    await testSql()`UPDATE inbox_connections SET refresh_token_enc = NULL WHERE user_id = ${other}`;
    expect(await codeOf(getRefreshToken(other))).toBe("token_unreadable");

    await clearConnection(getDb(), user);
    expect(await codeOf(getRefreshToken(user))).toBe("stopped");
    expect(await codeOf(getRefreshToken(await createUser()))).toBe("stopped");
  });

  it("finds another user's live connection of a Google account", async () => {
    const a = await createUser();
    const b = await createUser();
    await saveConnection(getDb(), a, grant(a, { googleSub: "shared-sub" }));
    expect(await hasLiveConnection(getDb(), "shared-sub", b)).toBe(true);
    expect(await hasLiveConnection(getDb(), "shared-sub", a)).toBe(false);
    await markNeedsReconnect(getDb(), a, "token_revoked");
    expect(await hasLiveConnection(getDb(), "shared-sub", b)).toBe(true);
    await clearConnection(getDb(), a);
    expect(await hasLiveConnection(getDb(), "shared-sub", b)).toBe(false);
  });

  /* --------------------------------------------------- the status */

  const NOT_CONNECTED = {
    address: null,
    connected: false,
    state: "not_connected",
    syncing: false,
    backfill: null,
    lastCheckedAt: null,
    lastError: null,
    configured: true,
    demo: false,
  };

  it("shows a user without a connection as not connected; configured and demo from the environment", async () => {
    const user = await createUser();
    expect(await getInboxStatus(getDb(), user)).toEqual(NOT_CONNECTED);
    inboxEnv({ key: "" });
    expect(await getInboxStatus(getDb(), user)).toEqual({ ...NOT_CONNECTED, configured: false });
    setEnv({});
    inboxEnv();
    expect(await getInboxStatus(getDb(), user)).toEqual({ ...NOT_CONNECTED, configured: false });
    inboxEnv({ key: "", mailSource: "fixture" });
    expect(await getInboxStatus(getDb(), user)).toEqual({ ...NOT_CONNECTED, configured: true, demo: true });
  });

  it("shows a connection: address, syncing, scan progress, last check and last error", async () => {
    const user = await createUser();
    const sql = testSql();
    await saveConnection(getDb(), user, grant(user));
    expect(await getInboxStatus(getDb(), user)).toEqual({
      ...NOT_CONNECTED,
      address: "person@example.com",
      connected: true,
      state: "connected",
    });

    // About to start the first scan.
    syncing.add(user);
    expect(await getInboxStatus(getDb(), user)).toMatchObject({ syncing: true, backfill: { done: 0, total: null } });

    // Scanning: progress, also between two runs.
    await sql`UPDATE inbox_connections SET backfill_state = 'running', backfill_total = 120, backfill_done = 30 WHERE user_id = ${user}`;
    expect((await getInboxStatus(getDb(), user)).backfill).toEqual({ done: 30, total: 120 });
    syncing.clear();
    expect(await getInboxStatus(getDb(), user)).toMatchObject({ syncing: false, backfill: { done: 30, total: 120 } });

    // Done; a failure shows the fixed text for its code.
    const at = new Date("2026-11-16T10:00:00.000Z");
    await sql`
      UPDATE inbox_connections SET backfill_state = 'done', last_sync_ok_at = ${at},
        last_error_code = 'rate_limited', last_error_at = ${at}
      WHERE user_id = ${user}`;
    const status = await getInboxStatus(getDb(), user);
    expect(status).toMatchObject({ backfill: null, lastCheckedAt: at.toISOString() });
    expect(status.lastError).toEqual({
      code: "rate_limited",
      message: "Gmail asked this app to slow down. It will try again shortly.",
      at: at.toISOString(),
    });
    await sql`UPDATE inbox_connections SET last_error_code = 'something_new' WHERE user_id = ${user}`;
    expect((await getInboxStatus(getDb(), user)).lastError?.message).toBe("Something went wrong while checking Gmail.");
  });

  it("shows needs_reconnect with its reason, and a disconnected mailbox as not connected", async () => {
    const user = await createUser();
    await saveConnection(getDb(), user, grant(user));
    await markNeedsReconnect(getDb(), user, "token_revoked");
    syncing.add(user);
    const status = await getInboxStatus(getDb(), user);
    expect(status).toMatchObject({ state: "needs_reconnect", connected: false, syncing: false, address: "person@example.com" });
    expect(status.lastError?.code).toBe("token_revoked");
    expect(status.lastError?.message).toMatch(/Reconnect Gmail/);

    await clearConnection(getDb(), user);
    expect(await getInboxStatus(getDb(), user)).toEqual({ ...NOT_CONNECTED, address: "person@example.com" });
  });
});
