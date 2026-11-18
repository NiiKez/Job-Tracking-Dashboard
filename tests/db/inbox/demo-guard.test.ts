import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDb, withTx } from "@/lib/server/db/client";
import { getEnv } from "@/lib/server/env";
import { ConflictError } from "@/lib/server/errors";
import { clearConnection, saveConnection } from "@/lib/server/inbox/connection";
import { decryptToken } from "@/lib/server/inbox/oauth/token-crypto";
import { DEMO_ON_GMAIL_MESSAGE, ensureDemoConnection } from "@/lib/server/inbox/repo";
import { isSyncing, runInboxCheck, runSync } from "@/lib/server/inbox/sync/engine";
import { resetSchedulerForTests, runSchedulerTick, startInboxScheduler, type SignalHost } from "@/lib/server/inbox/sync/scheduler";
import { seedUser } from "../../../db/seed/seed";
import { createUser } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";
import { fakeGoogle, GMAIL_SCOPE, KEY_HEX, REFRESH_TOKEN, type FakeGoogle } from "../../unit/inbox/connect-fakes";
import { connectionRow, demoUser, folderSource, NOW, restoreInboxEnv, snapshot, stubInboxEnv } from "./support";

// Demo mode (MAIL_SOURCE=fixture) never takes over a Gmail connection: not through "Check inbox"
// (repo.ts ensureDemoConnection, the route's first step), not on the scheduler's timer, and not
// in the engine itself (the last check, under the lease). A server started with fixture mail by
// mistake would otherwise drop the real token without revoking it, reset the sync position and
// write invented mail into the real jobs. The route's 409: tests/handlers/inbox-check.test.ts;
// demo mode's Connect: tests/handlers/inbox-connect.test.ts.

const KEY = Buffer.from(KEY_HEX, "hex");

type GmailStatus = "connected" | "needs_reconnect" | "disconnected";

/** A user with the demo jobs and a Gmail connection that has synced for a while, then `status`. */
async function gmailUser(status: GmailStatus): Promise<string> {
  const userId = await createUser({ rules: true });
  await withTx((tx) => seedUser(tx, userId, NOW.getTime()));
  const sql = testSql();
  const [user] = await sql<{ email: string; google_sub: string }[]>`SELECT email, google_sub FROM users WHERE id = ${userId}`;
  await saveConnection(getDb(), userId, {
    googleSub: user.google_sub,
    emailAddress: user.email,
    refreshToken: REFRESH_TOKEN,
    grantedScopes: [GMAIL_SCOPE],
  });
  await sql`
    UPDATE inbox_connections SET history_id = '9000123', backfill_state = 'done', backfill_after = now() - interval '30 days',
      backfill_total = 40, backfill_done = 40, last_sync_ok_at = now() - interval '1 hour',
      next_sync_at = now() - interval '1 minute'
    WHERE user_id = ${userId}`;
  if (status === "needs_reconnect") {
    await sql`
      UPDATE inbox_connections SET status = 'needs_reconnect', last_error_code = 'token_revoked', last_error_at = now()
      WHERE user_id = ${userId}`;
  }
  // As Disconnect leaves it: no token, the position and the ledger kept.
  if (status === "disconnected") await clearConnection(getDb(), userId);
  await sql`INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result) VALUES (${userId}, '18c0ffee', 'ignored')`;
  return userId;
}

/** Everything a takeover could change: the connection row, the jobs, emails, ledger and history. */
async function state(userId: string) {
  return { row: await connectionRow(userId), data: await snapshot(userId) };
}

/** A stand-in for `process`, so no real signal listener is added. */
function quietProcess(): SignalHost {
  const emitter = new EventEmitter();
  return {
    pid: 0,
    on: (signal, listener) => emitter.on(signal, listener),
    removeListener: (signal, listener) => emitter.removeListener(signal, listener),
    listenerCount: (signal) => emitter.listenerCount(signal),
    kill: () => true,
  };
}

describeDb("demo mode and a Gmail connection", () => {
  let google: FakeGoogle;

  beforeEach(() => {
    stubInboxEnv(); // MAIL_SOURCE=fixture
    vi.stubEnv("INBOX_TOKEN_KEY", KEY_HEX);
    // Every request to Google is recorded: a revocation would show up here.
    google = fakeGoogle();
  });
  afterEach(() => {
    resetSchedulerForTests();
    vi.unstubAllGlobals();
    restoreInboxEnv();
  });

  it.each<GmailStatus>(["connected", "needs_reconnect", "disconnected"])(
    "ensureDemoConnection refuses a %s Gmail connection and changes nothing",
    async (status) => {
      const userId = await gmailUser(status);
      const before = await state(userId);

      const refused = ensureDemoConnection(getDb(), userId);
      await expect(refused).rejects.toBeInstanceOf(ConflictError);
      await expect(refused).rejects.toThrow(DEMO_ON_GMAIL_MESSAGE);

      const after = await state(userId);
      expect(after).toEqual(before);
      expect(after.row).toMatchObject({ demo: false, status, history_id: "9000123", backfill_state: "done" });
      expect(after.data.ledger).toHaveLength(1);
      expect(after.data.jobs.length).toBeGreaterThan(0);
      if (status === "disconnected") {
        expect(after.row.refresh_token_enc).toBeNull();
      } else {
        // The stored token is the same grant's, still readable: nothing dropped, nothing revoked.
        expect(decryptToken(after.row.refresh_token_enc, userId, { current: KEY }).token).toBe(REFRESH_TOKEN);
      }
      expect(google.urls).toEqual([]);
    },
  );

  it("refuses any Gmail row, also one that never synced and holds no token", async () => {
    const userId = await createUser();
    await testSql()`
      INSERT INTO inbox_connections (user_id, google_sub, email_address, status)
      SELECT id, google_sub, email, 'disconnected' FROM users WHERE id = ${userId}`;
    const before = await connectionRow(userId);
    await expect(ensureDemoConnection(getDb(), userId)).rejects.toThrow(DEMO_ON_GMAIL_MESSAGE);
    expect(await connectionRow(userId)).toEqual(before);
  });

  it("keeps the demo flows: creates the demo connection, re-connects one, leaves a connected one alone", async () => {
    const userId = await createUser();
    await ensureDemoConnection(getDb(), userId);
    expect(await connectionRow(userId)).toMatchObject({ demo: true, status: "connected", refresh_token_enc: null });

    await testSql()`
      UPDATE inbox_connections SET status = 'needs_reconnect', history_id = '100005', last_error_code = 'token_unreadable'
      WHERE user_id = ${userId}`;
    await ensureDemoConnection(getDb(), userId);
    const reconnected = await connectionRow(userId);
    expect(reconnected).toMatchObject({ demo: true, status: "connected", history_id: "100005", last_error_code: null });

    await ensureDemoConnection(getDb(), userId);
    expect(await connectionRow(userId)).toEqual(reconnected);
    expect(google.urls).toEqual([]);
  });

  it("the engine refuses fixture mail on a Gmail connection, however the run was started, and records nothing", async () => {
    // The engine runs only on a connected row (else the usual 409), so that is the one to guard.
    const userId = await gmailUser("connected");
    const before = await state(userId);

    // The default source (MAIL_SOURCE=fixture: the demo mail), through the registry.
    const viaRegistry = runInboxCheck(userId, { now: () => NOW });
    await expect(viaRegistry).rejects.toBeInstanceOf(ConflictError);
    await expect(viaRegistry).rejects.toThrow(DEMO_ON_GMAIL_MESSAGE);
    // A source handed in (tests, scripts): the mode decides, not the source.
    await expect(runSync(userId, { source: folderSource(), now: () => NOW })).rejects.toThrow(DEMO_ON_GMAIL_MESSAGE);

    expect(isSyncing(userId)).toBe(false);
    // The whole row: no error recorded, no position or scan, and the lease released.
    expect(await state(userId)).toEqual(before);
    expect(google.urls).toEqual([]);
  });

  it("the engine still syncs the demo connection with fixture mail", async () => {
    const { userId } = await demoUser();
    expect(await runInboxCheck(userId, { now: () => NOW })).toMatchObject({ mode: "full_scan", scanned: 14, complete: true });
  });

  it("the scheduler syncs the due demo connection only, never fixture mail into a due Gmail connection", async () => {
    const gmail = await gmailUser("connected");
    const { userId: demo } = await demoUser();
    const before = await state(gmail);
    const synced: string[] = [];
    const lines: string[] = [];
    startInboxScheduler({
      env: getEnv(),
      signals: quietProcess(),
      deps: {
        sync: (userId, signal) => {
          synced.push(userId);
          return runInboxCheck(userId, { signal, now: () => NOW });
        },
        // The sweep and the clean-up run with any mail source; left out to compare the data.
        sweepable: async () => [],
        cleanLedger: async () => 0,
        stopAllSyncs: vi.fn(),
        log: (line) => void lines.push(line),
      },
    });

    await runSchedulerTick();

    expect(synced).toEqual([demo]);
    expect(lines.at(-1)).toBe("inbox: scheduler: synced 1");
    expect(await state(gmail)).toEqual(before);
    expect(google.urls).toEqual([]);
  });
});
