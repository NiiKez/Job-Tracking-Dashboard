import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST as checkInbox } from "@/app/api/inbox/check/route";
import { POST as scanAgainRoute } from "@/app/api/inbox/scan-again/route";
import { DEFAULT_RULES } from "@/lib/domain/defaults";
import { normalize } from "@/lib/domain/normalize";
import { getDb, withTx } from "@/lib/server/db/client";
import { saveConnection } from "@/lib/server/inbox/connection";
import { DEMO_ON_GMAIL_MESSAGE, ensureDemoConnection } from "@/lib/server/inbox/repo";
import { SYNC_RUNNING_MESSAGE } from "@/lib/server/inbox/scan-again";
import { isSyncing, runInboxCheck } from "@/lib/server/inbox/sync/engine";
import { listEmails } from "@/lib/server/services/emails";
import { listAllJobs } from "@/lib/server/services/jobs";
import type { InboxCheckResult } from "@/lib/types";
import { seedUser } from "../../db/seed/seed";
import { describeDb, testSql } from "../helpers/test-db";
import { restoreEnv, signedInEnv } from "../unit/auth/env";
import { GMAIL_SCOPE, inboxEnv, REFRESH_TOKEN } from "../unit/inbox/connect-fakes";
import { ctx, OWNER, request, signedIn } from "./helpers";

// POST /api/inbox/scan-again on the real database, in demo mode (MAIL_SOURCE=fixture: the demo
// mail in fixtures/mail): the scan is reset and started, mail already stored is not read twice,
// mail that was passed over is classified again with the rules of now, and the refusals change
// nothing. The reset itself is repo.ts resetScan.

// connection() needs a request scope; called directly, handlers only need it to resolve.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

const post = (cookie: string | null) =>
  scanAgainRoute(request("/api/inbox/scan-again", { method: "POST", cookie, body: "{}" }), ctx());
const check = (cookie: string) => checkInbox(request("/api/inbox/check", { method: "POST", cookie }), ctx());

async function answer<T>(res: Response, status: number): Promise<T> {
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

/** The user's ledger, connection scan columns, emails and jobs: "nothing changed" comparisons. */
async function state(userId: string) {
  const [ledger, [connection], emails, jobs] = await Promise.all([
    testSql()`
      SELECT gmail_message_id, result FROM inbox_seen_messages WHERE user_id = ${userId} ORDER BY gmail_message_id`,
    testSql()`
      SELECT backfill_state, backfill_after, backfill_total, backfill_done, history_id
      FROM inbox_connections WHERE user_id = ${userId}`,
    listEmails(getDb(), userId),
    listAllJobs(getDb(), userId),
  ]);
  return { ledger: [...ledger], connection, emails, jobs };
}

describeDb("POST /api/inbox/scan-again", () => {
  let cookie: string;
  let userId: string;

  beforeEach(async () => {
    signedInEnv();
    vi.stubEnv("INBOX_BACKFILL_DAYS", "30");
    inboxEnv({ mailSource: "fixture" });
    const session = await signedIn();
    cookie = session.cookie;
    userId = session.user.id;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreEnv();
  });

  it("401 signed out", async () => {
    expect(await answer(await post(null), 401)).toEqual({ error: "Not signed in" });
  });

  it("409 while no inbox is connected, and creates no connection", async () => {
    expect(await answer(await post(cookie), 409)).toEqual({ error: "Connect Gmail in Settings first." });
    const [{ count }] = await testSql()<{ count: number }[]>`SELECT count(*)::int AS count FROM inbox_connections`;
    expect(count).toBe(0);
  });

  it("scans again: the ledger forgets what was not stored, and nothing is stored twice", async () => {
    await withTx((tx) => seedUser(tx, userId));
    const first = await answer<InboxCheckResult>(await check(cookie), 200);
    expect(first).toMatchObject({ state: "done", scanned: 14 });
    const before = await state(userId);
    const stored = before.ledger.filter((r) => r.result === "stored").length;
    expect(stored).toBe(first.processed.length);
    expect(before.connection.backfill_state).toBe("done");

    const res = await answer<{ ok: true; forgotten: number }>(await post(cookie), 200);
    expect(res).toEqual({ ok: true, forgotten: 14 - stored });
    // Started before the answer; the scan state was reset first.
    expect(isSyncing(userId)).toBe(true);
    const result = await runInboxCheck(userId);
    expect(result).toMatchObject({ complete: true, scanned: 14 - stored, stored: [] });

    // Every message read once more, nothing new filed, the scan finished.
    expect(await state(userId)).toEqual({ ...before, connection: { ...before.connection, backfill_after: expect.any(Date) } });
    const again = await answer<InboxCheckResult>(await check(cookie), 200);
    expect(again).toMatchObject({ state: "done", scanned: 0, processed: [] });
  });

  it("files the mail a scan passed over once the keywords know its words", async () => {
    await withTx((tx) => seedUser(tx, userId));
    // The first scan runs without keywords: mail that only a phrase ties to a job is passed over.
    await testSql()`DELETE FROM keyword_rules WHERE user_id = ${userId}`;
    await answer<InboxCheckResult>(await check(cookie), 200);
    const before = await state(userId);
    const ignored = before.ledger.filter((r) => r.result === "ignored").map((r) => r.gmail_message_id);
    expect(ignored.length).toBeGreaterThan(0);

    for (const rule of DEFAULT_RULES) {
      await testSql()`
        INSERT INTO keyword_rules (user_id, status, phrase, phrase_norm, language)
        VALUES (${userId}, ${rule.status}, ${rule.phrase}, ${normalize(rule.phrase)}, ${rule.language})`;
    }
    await answer(await post(cookie), 200);
    const result = await runInboxCheck(userId);
    expect(result.complete).toBe(true);

    const after = await state(userId);
    // Some of the passed-over mail is job mail now; what was stored before is untouched.
    const filed = after.emails.filter((e) => !before.emails.some((b) => b.id === e.id));
    expect(filed.length).toBeGreaterThan(0);
    expect(after.emails.filter((e) => before.emails.some((b) => b.id === e.id))).toEqual(before.emails);
    const resultOf = new Map(after.ledger.map((r) => [r.gmail_message_id, r.result]));
    expect(ignored.filter((id) => resultOf.get(id) === "stored")).toHaveLength(filed.length);
  });

  it("409 while a sync holds the lease, and changes nothing", async () => {
    await withTx((tx) => seedUser(tx, userId));
    await answer<InboxCheckResult>(await check(cookie), 200);
    await testSql()`
      UPDATE inbox_connections SET lease_owner = '4242.another-process', lease_until = now() + interval '3 minutes'
      WHERE user_id = ${userId}`;
    const before = await state(userId);

    expect(await answer(await post(cookie), 409)).toEqual({ error: SYNC_RUNNING_MESSAGE });
    expect(await state(userId)).toEqual(before);
    expect(isSyncing(userId)).toBe(false);
  });

  it("409 when Gmail needs a reconnect", async () => {
    await testSql()`
      INSERT INTO inbox_connections (user_id, google_sub, email_address, status, last_error_code)
      VALUES (${userId}, ${OWNER.sub}, ${OWNER.email}, 'needs_reconnect', 'token_revoked')`;
    expect(await answer(await post(cookie), 409)).toEqual({
      error: "Gmail needs to be reconnected. Reconnect it in Settings.",
    });
  });

  it("409 in demo mode on a Gmail connection: demo mail never goes into it", async () => {
    await saveConnection(getDb(), userId, {
      googleSub: OWNER.sub,
      emailAddress: OWNER.email,
      refreshToken: REFRESH_TOKEN,
      grantedScopes: [GMAIL_SCOPE],
    });
    await testSql()`UPDATE inbox_connections SET history_id = '9000123', backfill_state = 'done' WHERE user_id = ${userId}`;
    const before = await state(userId);

    expect(await answer(await post(cookie), 409)).toEqual({ error: DEMO_ON_GMAIL_MESSAGE });
    expect(await state(userId)).toEqual(before);
    expect(isSyncing(userId)).toBe(false);
  });

  it("a demo connection that is set up but never synced scans from the start", async () => {
    await ensureDemoConnection(getDb(), userId);
    expect(await answer(await post(cookie), 200)).toEqual({ ok: true, forgotten: 0 });
    expect(await runInboxCheck(userId)).toMatchObject({ complete: true, scanned: 14 });
  });
});
