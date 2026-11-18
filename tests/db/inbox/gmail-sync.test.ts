import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDb } from "@/lib/server/db/client";
import { resetEnvForTests } from "@/lib/server/env";
import { ConflictError } from "@/lib/server/errors";
import { saveConnection } from "@/lib/server/inbox/connection";
import { decryptToken } from "@/lib/server/inbox/oauth/token-crypto";
import { forgetAccessTokens } from "@/lib/server/inbox/oauth/google-tokens";
import { getInboxStatus } from "@/lib/server/inbox/status";
import { DRY_RUN_BUSY_MESSAGE, dryRunInboxCheck } from "@/lib/server/inbox/sync/dry-run";
import {
  isSyncing,
  resetSyncStopForTests,
  runInboxCheck,
  runSync,
  stopAllSyncs,
  type RunOptions,
} from "@/lib/server/inbox/sync/engine";
import { holdLease } from "@/lib/server/inbox/sync/lease";
import type { PacerOptions } from "@/lib/server/inbox/sync/pace";
import type { Email } from "@/lib/types";
import { describeDb, testSql } from "../../helpers/test-db";
import { restoreEnv, signedInEnv } from "../../unit/auth/env";
import { GMAIL_SCOPE, inboxEnv, KEY_HEX, REFRESH_TOKEN } from "../../unit/inbox/connect-fakes";
import { fakeGmail, googleError, tokenError, type FakeGmail, type MailboxMessage } from "../../unit/inbox/gmail-fakes";
import {
  connectionRow,
  DAY,
  demoUser,
  fixtureFiles,
  folderSource,
  gmailMessage,
  ledger,
  NOW,
  snapshot,
  stubBackfillDays,
  sync,
  WINDOWS,
} from "./support";

// Step 2.5 end to end: the sync engine with the real Gmail source (source/index.ts: the stored
// token decrypted, refreshed through Arctic, the Gmail client, the pacer) against a fake Gmail
// HTTP layer (tests/unit/inbox/gmail-fakes.ts fakeGmail) installed as the global fetch. The
// pacer's clock and waits are fake, so Retry-After and backoff cost no time. MAIL_SOURCE is ""
// (Gmail) here whatever the environment says; the demo jobs are db/seed's, the mail is the demo
// mail of fixtures/mail served as Gmail would.

const HOUR = 3_600_000;
const SECONDS = (d: Date) => String(Math.floor(d.getTime() / 1000));

/** The pacer's clock and waits: a wait moves the clock at once and is recorded. */
function fakePace(opts: { hangAtLeast?: number } = {}) {
  const clock = { t: NOW.getTime() };
  const sleeps: number[] = [];
  let hanging!: () => void;
  const hung = new Promise<void>((resolve) => (hanging = resolve));
  const pace: PacerOptions = {
    now: () => clock.t,
    random: () => 0.5,
    sleep: (ms, signal) => {
      if (signal?.aborted) return Promise.reject(new Error("aborted"));
      sleeps.push(ms);
      if (opts.hangAtLeast !== undefined && ms >= opts.hangAtLeast) {
        hanging();
        // Only the stop ends this wait.
        return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      clock.t += ms;
      return Promise.resolve();
    },
  };
  return { pace, sleeps, hung };
}

/** The demo mail of fixtures/mail as Gmail serves it at NOW (dates moved as the fixture source does), oldest first. */
async function demoMail(): Promise<MailboxMessage[]> {
  const source = folderSource();
  const files = await fixtureFiles();
  const list = await Promise.all(
    files.map(async ({ id, message }) => ({
      ...(await source.getMessage(id))!,
      _attachments: (message as MailboxMessage)._attachments,
    })),
  );
  return list.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
}

/** A user with the demo jobs and a Gmail connection (the stored token is REFRESH_TOKEN, encrypted). */
async function gmailUser(): Promise<{ userId: string; address: string }> {
  const { userId, address } = await demoUser();
  const [{ google_sub }] = await testSql()<{ google_sub: string }[]>`SELECT google_sub FROM users WHERE id = ${userId}`;
  await saveConnection(getDb(), userId, { googleSub: google_sub, emailAddress: address, refreshToken: REFRESH_TOKEN, grantedScopes: [GMAIL_SCOPE] });
  return { userId, address };
}

/** Every table's row count in the test schema. */
async function tableCounts(): Promise<Record<string, number>> {
  const tables = await testSql()<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
    ORDER BY table_name`;
  const counts: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [{ count }] = await testSql().unsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM "${table_name}"`);
    counts[table_name] = count;
  }
  return counts;
}

/** What each stored Gmail message did, by message id. */
async function outcomesOf(userId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await testSql()`
    SELECT e.gmail_message_id, e.outcome, e.review_reason, j.company, e.change_from, e.change_to
    FROM emails e LEFT JOIN jobs j ON j.id = e.job_id
    WHERE e.user_id = ${userId} AND e.gmail_message_id IS NOT NULL
    ORDER BY e.gmail_message_id`;
  return rows.map((r) => ({ ...r }));
}

const byOutcome = (emails: Email[]) => {
  const counts = { matched: 0, created: 0, review: 0 };
  for (const e of emails) counts[e.outcome as keyof typeof counts]++;
  return counts;
};

let gmail: FakeGmail;
let pace: ReturnType<typeof fakePace>;

/** One run at NOW through the registry, with the real Gmail source. */
const check = (userId: string, opts: RunOptions = {}) => runInboxCheck(userId, { now: () => NOW, pace: pace.pace, ...opts });

describeDb("Gmail sync, end to end", () => {
  beforeEach(() => {
    vi.stubEnv("INBOX_BACKFILL_DAYS", "30");
    signedInEnv();
    inboxEnv({ mailSource: "" });
    resetEnvForTests();
    gmail = fakeGmail({ pageSize: 4 });
    vi.stubGlobal("fetch", gmail.fetch);
    pace = fakePace();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetSyncStopForTests();
    restoreEnv();
  });

  it("first scan: lists the window, fetches every message once and stores what the fixture source stores", async () => {
    const { userId } = await gmailUser();
    gmail.deliver(...(await demoMail()));
    const position = gmail.historyId();

    const result = await check(userId);

    expect(result).toMatchObject({ mode: "full_scan", busy: false, scanned: 14, ignored: 3, skipped: 0, retry: 0, failed: 0, complete: true });
    expect(result.stored).toHaveLength(11);
    expect(byOutcome(result.stored)).toEqual({ matched: 8, created: 1, review: 2 });
    // The position is the profile's, stored before listing; the scan is done.
    expect(await connectionRow(userId)).toMatchObject({
      history_id: position,
      backfill_state: "done",
      backfill_total: 14,
      backfill_done: 14,
      last_error_code: null,
      lease_owner: null,
      lease_until: null,
    });
    // The requests: one refresh with the stored token, the profile, every page of the listing
    // with the first-scan query, each listed message once (the sent reply is not listed).
    expect(gmail.requests.filter((r) => r.endpoint === "token").map((r) => r.credential)).toEqual([REFRESH_TOKEN]);
    expect(gmail.count("profile")).toBe(1);
    const lists = gmail.requests.filter((r) => r.endpoint === "messages.list");
    expect(lists).toHaveLength(4);
    for (const r of lists) {
      expect(r.url.searchParams.get("q")).toBe(`after:${SECONDS(new Date(NOW.getTime() - 30 * DAY))} -in:sent -in:drafts -in:chats`);
      expect(r.url.searchParams.get("maxResults")).toBe("500");
    }
    expect(gmail.count("messages.get")).toBe(14);
    expect(gmail.count("messages.get", "19a6d2c4e8f1a008")).toBe(0);
    expect(gmail.count("attachments.get")).toBeGreaterThan(0);
    expect(gmail.count("history.list")).toBe(0);
    for (const r of gmail.requests.filter((r) => r.endpoint !== "token")) expect(r.credential).toBe("Bearer ya29.fake-access-1");

    // Exactly what the same mail does through the fixture source.
    const other = await demoUser();
    await sync(other.userId, folderSource());
    expect(await outcomesOf(userId)).toEqual(await outcomesOf(other.userId));
  });

  it.each(WINDOWS)("the first scan reaches back INBOX_BACKFILL_DAYS (%i days): mail just inside is read, mail just outside never fetched", async (days) => {
    stubBackfillDays(days);
    const { userId } = await gmailUser();
    const start = new Date(NOW.getTime() - days * DAY);
    const from = "Sam <sam@friends.example>";
    const inside = gmailMessage({ from, subject: "Inside", body: "Bike ride at nine?", at: new Date(start.getTime() + HOUR) });
    const outside = gmailMessage({ from, subject: "Outside", body: "Bike ride at ten?", at: new Date(start.getTime() - HOUR) });
    gmail.deliver(outside, inside);

    const result = await check(userId);

    expect(result).toMatchObject({ mode: "full_scan", scanned: 1, ignored: 1, complete: true });
    expect(gmail.requests.find((r) => r.endpoint === "messages.list")!.url.searchParams.get("q")).toBe(
      `after:${SECONDS(start)} -in:sent -in:drafts -in:chats`,
    );
    expect(gmail.count("messages.get", inside.id)).toBe(1);
    expect(gmail.count("messages.get", outside.id)).toBe(0);
    expect(await connectionRow(userId)).toMatchObject({ backfill_state: "done", backfill_after: start, backfill_total: 1 });
  });

  it("incremental sync from the history, then a second sync adds nothing", async () => {
    const { userId } = await gmailUser();
    gmail.deliver(...(await demoMail()));
    await check(userId);
    const at = new Date(NOW.getTime() - 2 * HOUR);
    const invite = gmailMessage({
      from: "Driftwood Audio Careers <careers@driftwoodaudio.example>",
      subject: "Interview invitation",
      body: "Thanks for applying. We would like to invite you to an interview for the role next week.",
      at,
    });
    const unrelated = gmailMessage({ from: "Sam <sam@friends.example>", subject: "Saturday", body: "Bike ride at nine?", at });
    const sent = gmailMessage({ from: "Me <owner@example.com>", subject: "Re: Saturday", body: "Yes!", at, labels: ["SENT"] });
    const draft = gmailMessage({ from: "Me <owner@example.com>", subject: "draft", body: "…", at, labels: ["DRAFT"] });
    gmail.deliver(invite, unrelated, sent, draft);
    const before = gmail.requests.length;

    const result = await check(userId);

    expect(result).toMatchObject({ mode: "incremental", scanned: 2, ignored: 1, complete: true });
    expect(result.stored.map((e) => [e.subject, e.outcome])).toEqual([["Interview invitation", "matched"]]);
    expect((await connectionRow(userId)).history_id).toBe(gmail.historyId());
    const requests = gmail.requests.slice(before);
    expect(requests.map((r) => r.endpoint).sort()).toEqual(["history.list", "messages.get", "messages.get"]);
    expect(requests[0].url.searchParams.get("historyTypes")).toBe("messageAdded");
    // Sent mail and drafts are left out by their history labels: never fetched.
    expect(gmail.count("messages.get", sent.id) + gmail.count("messages.get", draft.id)).toBe(0);

    const after = await snapshot(userId);
    const again = await check(userId);
    expect(again).toMatchObject({ mode: "incremental", scanned: 0, stored: [], complete: true });
    expect(await snapshot(userId)).toEqual(after);
    expect(gmail.requests.slice(before + 3).map((r) => r.endpoint)).toEqual(["history.list"]);
    // The access token is the connection's: one refresh for all three runs.
    expect(gmail.count("token")).toBe(1);
  });

  it("an expired position scans again from a day before the last sync, without duplicates", async () => {
    const { userId } = await gmailUser();
    gmail.deliver(...(await demoMail()));
    await check(userId);
    const stored = (await outcomesOf(userId)).length;
    const lastOk = new Date(NOW.getTime() - 2 * DAY);
    await testSql()`UPDATE inbox_connections SET last_sync_ok_at = ${lastOk} WHERE user_id = ${userId}`;
    const late = gmailMessage({
      from: "Driftwood Audio Careers <careers@driftwoodaudio.example>",
      subject: "Interview invitation",
      body: "Thanks for applying. We would like to invite you to an interview for the role next week.",
      at: new Date(NOW.getTime() - HOUR),
    });
    gmail.deliver(late);
    gmail.expireHistory();
    const windowStart = new Date(lastOk.getTime() - DAY);
    const recent = (await demoMail()).filter((m) => Number(m.internalDate) > windowStart.getTime() && !m.labelIds?.includes("SENT"));
    expect(recent.length).toBeGreaterThan(0);

    // The dry run sees the same: a re-scan of that window, all but the new message done.
    const dry = await dryRunInboxCheck(userId, { now: () => NOW, pace: pace.pace });
    expect(dry).toMatchObject({ mode: "full_scan", after: windowStart.toISOString(), listed: recent.length + 1, alreadyDone: recent.length, fetched: 1 });

    const result = await check(userId);

    expect(result).toMatchObject({ mode: "full_scan", scanned: 1, complete: true });
    expect(result.stored.map((e) => e.subject)).toEqual(["Interview invitation"]);
    expect(gmail.requests.filter((r) => r.endpoint === "messages.list").at(-1)!.url.searchParams.get("q")).toMatch(
      new RegExp(`^after:${SECONDS(windowStart)} `),
    );
    expect(await connectionRow(userId)).toMatchObject({ history_id: gmail.historyId(), backfill_state: "done", backfill_after: windowStart });
    const rows = await outcomesOf(userId);
    expect(rows).toHaveLength(stored + 1);
    expect(new Set(rows.map((r) => r.gmail_message_id)).size).toBe(rows.length);
    // And the incremental sync continues from the new position.
    expect(await check(userId)).toMatchObject({ mode: "incremental", scanned: 0, complete: true });
  });

  it("waits out a 429's Retry-After and goes on", async () => {
    const { userId } = await gmailUser();
    const mail = await demoMail();
    gmail.deliver(...mail);
    const target = mail[3].id;
    let refused = false;
    gmail.intercept = (req) => {
      if (req.endpoint !== "messages.get" || req.id !== target || refused) return undefined;
      refused = true;
      return googleError(429, "rateLimitExceeded", { "retry-after": "7" });
    };

    const result = await check(userId);

    expect(result).toMatchObject({ scanned: 14, complete: true });
    expect(result.stored).toHaveLength(11);
    expect(gmail.count("messages.get", target)).toBe(2);
    expect(pace.sleeps).toContain(7_000);
    expect(await connectionRow(userId)).toMatchObject({ last_error_code: null, consecutive_failures: 0 });
  });

  it("invalid_grant marks the connection needs_reconnect, and the inbox is not checked again", async () => {
    const { userId } = await gmailUser();
    gmail.deliver(...(await demoMail()));
    gmail.intercept = (req) => (req.endpoint === "token" ? tokenError("invalid_grant") : undefined);

    await expect(check(userId)).rejects.toMatchObject({ kind: "needs_reconnect", code: "token_revoked" });

    expect(gmail.requests.map((r) => r.endpoint)).toEqual(["token"]);
    expect(await connectionRow(userId)).toMatchObject({ status: "needs_reconnect", last_error_code: "token_revoked", lease_owner: null });
    expect(await getInboxStatus(getDb(), userId)).toMatchObject({ state: "needs_reconnect", syncing: false });
    await expect(check(userId)).rejects.toBeInstanceOf(ConflictError);
    expect(gmail.requests).toHaveLength(1);
  });

  it("a 401 straight after a refresh marks the connection needs_reconnect", async () => {
    const { userId } = await gmailUser();
    gmail.intercept = (req) => (req.endpoint === "token" ? undefined : googleError(401, "authError"));

    await expect(check(userId)).rejects.toMatchObject({ kind: "needs_reconnect", code: "token_rejected" });

    // The first token was refused, a refreshed one too.
    expect(gmail.requests.map((r) => r.endpoint)).toEqual(["token", "profile", "token", "profile"]);
    expect(await connectionRow(userId)).toMatchObject({ status: "needs_reconnect", last_error_code: "token_rejected" });
  });

  it("a message Gmail keeps failing on is given up after three runs, and the position moves on", async () => {
    const { userId } = await gmailUser();
    await check(userId); // an empty mailbox: the position is set
    const start = (await connectionRow(userId)).history_id;
    const at = new Date(NOW.getTime() - HOUR);
    const fine = gmailMessage({ from: "Sam <sam@friends.example>", subject: "Saturday", body: "Bike ride at nine?", at });
    const broken = gmailMessage({ from: "Kim <kim@friends.example>", subject: "Photos", body: "Here they are.", at });
    gmail.deliver(fine, broken);
    gmail.intercept = (req) => (req.endpoint === "messages.get" && req.id === broken.id ? googleError(500, "backendError") : undefined);

    // Gmail still answers otherwise (the probe), so the failure is the message's: one attempt.
    const first = await check(userId);
    expect(first).toMatchObject({ mode: "incremental", scanned: 2, ignored: 1, retry: 1, failed: 0, complete: false });
    expect((await connectionRow(userId)).history_id).toBe(start);
    expect((await ledger(userId)).get(broken.id)).toMatchObject({ result: "retry", attempts: 1 });
    expect(gmail.count("messages.get", broken.id)).toBe(7); // the pacer's attempts

    expect(await check(userId)).toMatchObject({ scanned: 1, retry: 1, complete: false });
    const third = await check(userId);
    expect(third).toMatchObject({ scanned: 1, retry: 0, failed: 1, complete: true });
    expect((await ledger(userId)).get(broken.id)).toMatchObject({ result: "failed", attempts: 3 });
    expect(await connectionRow(userId)).toMatchObject({ history_id: gmail.historyId(), last_error_code: null, consecutive_failures: 0 });

    const fetched = gmail.count("messages.get", broken.id);
    expect(await check(userId)).toMatchObject({ scanned: 0, complete: true });
    expect(gmail.count("messages.get", broken.id)).toBe(fetched);
  });

  it("an outage ends the run without blaming any message, and the next run waits (longer when Google says so)", async () => {
    const { userId } = await gmailUser();
    await check(userId);
    const start = (await connectionRow(userId)).history_id;
    const at = new Date(NOW.getTime() - HOUR);
    const a = gmailMessage({ from: "Sam <sam@friends.example>", subject: "Saturday", body: "Bike ride at nine?", at });
    const b = gmailMessage({ from: "Kim <kim@friends.example>", subject: "Photos", body: "Here they are.", at });
    gmail.deliver(a, b);
    gmail.intercept = (req) => (req.endpoint === "messages.get" || req.endpoint === "profile" ? googleError(503, "backendError") : undefined);
    const started = Date.now();

    await expect(check(userId)).rejects.toMatchObject({ kind: "temporary", code: "google_unavailable" });

    expect((await ledger(userId)).size).toBe(0);
    let row = await connectionRow(userId);
    expect(row).toMatchObject({ history_id: start, last_error_code: "google_unavailable", consecutive_failures: 1, lease_owner: null });
    // 15 minutes × 2 after one failure.
    expect(row.next_sync_at.getTime() - started).toBeGreaterThan(29 * 60_000);
    expect(row.next_sync_at.getTime() - started).toBeLessThan(31 * 60_000);

    // A daily limit: Retry-After two hours, more than the backoff.
    gmail.intercept = (req) => (req.endpoint === "history.list" ? googleError(429, "dailyLimitExceeded", { "retry-after": "7200" }) : undefined);
    await expect(check(userId)).rejects.toMatchObject({ code: "rate_limited" });
    row = await connectionRow(userId);
    expect(row).toMatchObject({ last_error_code: "rate_limited", consecutive_failures: 2 });
    expect(row.next_sync_at.getTime() - started).toBeGreaterThan(2 * HOUR - 60_000);

    gmail.intercept = null;
    expect(await check(userId)).toMatchObject({ scanned: 2, complete: true });
  });

  it("a token endpoint that answers garbage mid-run blames no message: the run ends, nothing is marked failed, the position waits", async () => {
    const { userId } = await gmailUser();
    await check(userId); // an empty mailbox: the position is set
    const start = (await connectionRow(userId)).history_id;
    const at = new Date(NOW.getTime() - HOUR);
    const mail = Array.from({ length: 8 }, (_, i) =>
      gmailMessage({ from: "Sam <sam@friends.example>", subject: `Note ${i}`, body: "See you soon.", at: new Date(at.getTime() + i * 60_000) }),
    );
    gmail.deliver(...mail);
    // The hourly access token runs out right after the listing, while Google's token endpoint
    // answers an HTML page: each message's request refreshes the token first, and that fails.
    let broken = false;
    gmail.intercept = (req) => {
      if (req.endpoint === "token" && broken) {
        return new Response("<html>Sorry, unusual traffic</html>", { status: 403, headers: { "content-type": "text/html" } });
      }
      if (req.endpoint === "history.list") {
        forgetAccessTokens(userId);
        broken = true;
      }
      return undefined;
    };

    for (let run = 1; run <= 3; run++) {
      broken = false;
      await expect(check(userId), `run ${run}`).rejects.toMatchObject({ kind: "temporary", code: "token_refresh_failed" });
      expect((await ledger(userId)).size, `run ${run}`).toBe(0);
      expect((await connectionRow(userId)).history_id).toBe(start);
    }
    expect(await connectionRow(userId)).toMatchObject({ last_error_code: "token_refresh_failed", consecutive_failures: 3 });
    // Not the message's fault, so no probe either: the only profile request is the first scan's.
    expect(gmail.count("profile")).toBe(1);

    gmail.intercept = null;
    expect(await check(userId)).toMatchObject({ complete: true, retry: 0, failed: 0 });
    expect([...(await ledger(userId)).values()].map((r) => r.result)).toEqual(Array(8).fill("ignored"));
    expect((await connectionRow(userId)).history_id).toBe(gmail.historyId());
  });

  it("a probe that Google answers with a long Retry-After ends the run with it, so the next run waits that long", async () => {
    const { userId } = await gmailUser();
    await check(userId);
    const message = gmailMessage({ from: "Kim <kim@friends.example>", subject: "Photos", body: "Here they are.", at: new Date(NOW.getTime() - HOUR) });
    gmail.deliver(message);
    gmail.intercept = (req) =>
      req.endpoint === "messages.get"
        ? googleError(503, "backendError")
        : req.endpoint === "profile"
          ? googleError(429, "rateLimitExceeded", { "retry-after": "3600" })
          : undefined;
    const started = Date.now();

    await expect(check(userId)).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 3_600_000 });

    expect((await ledger(userId)).size).toBe(0);
    const row = await connectionRow(userId);
    expect(row).toMatchObject({ last_error_code: "rate_limited", consecutive_failures: 1 });
    expect(row.next_sync_at.getTime() - started).toBeGreaterThan(HOUR - 60_000);
  });

  it("a run on the old grant that fails after a Reconnect leaves the new connection alone", async () => {
    const { userId, address } = await gmailUser();
    const [{ google_sub }] = await testSql()<{ google_sub: string }[]>`SELECT google_sub FROM users WHERE id = ${userId}`;
    const reconnected = Promise.withResolvers<void>();
    let first = true;
    gmail.intercept = async (req) => {
      if (req.endpoint !== "token" || !first) return undefined;
      first = false;
      // While Google works on the old token's refresh, the owner reconnects (a new token).
      await saveConnection(getDb(), userId, { googleSub: google_sub, emailAddress: address, refreshToken: "1//0the-new-one", grantedScopes: [GMAIL_SCOPE] });
      reconnected.resolve();
      return tokenError("invalid_grant");
    };

    await expect(check(userId)).rejects.toMatchObject({ kind: "needs_reconnect", code: "token_revoked" });
    await reconnected.promise;

    const row = await connectionRow(userId);
    expect(row).toMatchObject({ status: "connected", last_error_code: null, consecutive_failures: 0 });
    expect(decryptToken(row.refresh_token_enc, userId, { current: Buffer.from(KEY_HEX, "hex") }).token).toBe("1//0the-new-one");
    // The next run uses the new token.
    expect(await check(userId)).toMatchObject({ mode: "full_scan", complete: true });
    expect(gmail.requests.filter((r) => r.endpoint === "token").map((r) => r.credential)).toEqual([REFRESH_TOKEN, "1//0the-new-one"]);
  });

  it.each([
    ["a large mailbox whose history ids are far above the demo's", 9_000_000],
    ["a small mailbox whose history ids are below the demo's", 5_000],
  ])("Connect after the demo mail in the same database starts with the full first scan: %s", async (_name, firstHistoryId) => {
    // Development: a "Check inbox" with MAIL_SOURCE=fixture, then Connect with Gmail.
    const { userId, address } = await demoUser();
    await sync(userId, folderSource());
    expect(await connectionRow(userId)).toMatchObject({ demo: true, history_id: "100015", backfill_state: "done" });
    const [{ google_sub }] = await testSql()<{ google_sub: string }[]>`SELECT google_sub FROM users WHERE id = ${userId}`;
    await saveConnection(getDb(), userId, { googleSub: google_sub, emailAddress: address, refreshToken: REFRESH_TOKEN, grantedScopes: [GMAIL_SCOPE] });
    expect(await connectionRow(userId)).toMatchObject({
      demo: false,
      history_id: null,
      backfill_state: "pending",
      backfill_after: null,
      backfill_total: null,
      backfill_done: 0,
      last_sync_ok_at: null,
    });

    gmail = fakeGmail({ firstHistoryId });
    vi.stubGlobal("fetch", gmail.fetch);
    const mail = Array.from({ length: 5 }, (_, i) =>
      gmailMessage({ from: "Sam <sam@friends.example>", subject: `Note ${i}`, body: "See you soon.", at: new Date(NOW.getTime() - (3 + i * 5) * DAY) }),
    );
    gmail.deliver(...mail);
    gmail.expireHistory(firstHistoryId); // a position from before the mailbox's own history is gone

    const result = await check(userId);

    expect(result).toMatchObject({ mode: "full_scan", scanned: 5, ignored: 5, complete: true });
    expect(gmail.count("history.list")).toBe(0);
    expect(gmail.requests.find((r) => r.endpoint === "messages.list")!.url.searchParams.get("q")).toMatch(
      new RegExp(`^after:${SECONDS(new Date(NOW.getTime() - 30 * DAY))} `),
    );
    expect(await connectionRow(userId)).toMatchObject({ demo: false, history_id: gmail.historyId(), backfill_state: "done" });
  });

  it("a Reconnect drops the connection's access token: the next run refreshes with the new stored token", async () => {
    const { userId, address } = await gmailUser();
    await check(userId);
    await check(userId);
    expect(gmail.count("token")).toBe(1);
    const [{ google_sub }] = await testSql()<{ google_sub: string }[]>`SELECT google_sub FROM users WHERE id = ${userId}`;
    await saveConnection(getDb(), userId, { googleSub: google_sub, emailAddress: address, refreshToken: "1//0another-invented-token", grantedScopes: [GMAIL_SCOPE] });

    await check(userId);

    expect(gmail.requests.filter((r) => r.endpoint === "token").map((r) => r.credential)).toEqual([REFRESH_TOKEN, "1//0another-invented-token"]);
    expect(gmail.requests.at(-1)!.credential).toBe("Bearer ya29.fake-access-2");
  });

  it.each(WINDOWS)("a scan interrupted and resumed after a Reconnect 10 days later reaches back no further than INBOX_BACKFILL_DAYS (%i days)", async (days) => {
    stubBackfillDays(days);
    const { userId, address } = await gmailUser();
    const later = new Date(NOW.getTime() + 10 * DAY);
    const from = "Sam <sam@friends.example>";
    // Inside the first window (NOW − days) but not inside the resumed one (later − days).
    const early = gmailMessage({ from, subject: "Old plans", body: "Bike ride at nine?", at: new Date(NOW.getTime() - (days - 5) * DAY) });
    const recent = gmailMessage({ from, subject: "New plans", body: "Bike ride at ten?", at: new Date(NOW.getTime() - 5 * DAY) });
    gmail.deliver(early, recent);

    // The first scan is cut short: Gmail refuses the access, the inbox needs reconnecting.
    gmail.intercept = (req) => (req.endpoint === "messages.get" ? googleError(401, "authError") : undefined);
    await expect(check(userId)).rejects.toMatchObject({ kind: "needs_reconnect" });
    const position = (await connectionRow(userId)).history_id;
    expect(await connectionRow(userId)).toMatchObject({
      status: "needs_reconnect",
      backfill_state: "running",
      backfill_after: new Date(NOW.getTime() - days * DAY),
    });
    expect(await ledger(userId)).toEqual(new Map());
    const earlyFetches = gmail.count("messages.get", early.id);

    // Ten days later the owner reconnects; the scan resumes from the stored position.
    gmail.intercept = null;
    const [{ google_sub }] = await testSql()<{ google_sub: string }[]>`SELECT google_sub FROM users WHERE id = ${userId}`;
    await saveConnection(getDb(), userId, { googleSub: google_sub, emailAddress: address, refreshToken: REFRESH_TOKEN, grantedScopes: [GMAIL_SCOPE] });
    const windowStart = new Date(later.getTime() - days * DAY);

    // The dry run lists the same window.
    const dry = await dryRunInboxCheck(userId, { now: () => later, pace: pace.pace });
    expect(dry).toMatchObject({ mode: "full_scan", after: windowStart.toISOString(), listed: 1, fetched: 1 });

    const result = await check(userId, { now: () => later });

    expect(result).toMatchObject({ mode: "full_scan", scanned: 1, ignored: 1, complete: true });
    expect(gmail.requests.filter((r) => r.endpoint === "messages.list").at(-1)!.url.searchParams.get("q")).toMatch(
      new RegExp(`^after:${SECONDS(windowStart)} `),
    );
    expect([...(await ledger(userId)).keys()]).toEqual([recent.id]);
    expect(gmail.count("messages.get", early.id)).toBe(earlyFetches); // only the first run's refused requests
    // Resumed, not restarted: the position from before the interruption is kept.
    expect(await connectionRow(userId)).toMatchObject({ history_id: position, backfill_state: "done" });
  });
});

describeDb("the sync lease", () => {
  beforeEach(() => {
    vi.stubEnv("INBOX_BACKFILL_DAYS", "30");
    signedInEnv();
    inboxEnv({ mailSource: "" });
    resetEnvForTests();
    gmail = fakeGmail();
    vi.stubGlobal("fetch", gmail.fetch);
    pace = fakePace();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetSyncStopForTests();
    restoreEnv();
  });

  it("a lease held by another process keeps a run out; Settings shows the inbox as syncing", async () => {
    const { userId } = await gmailUser();
    gmail.deliver(...(await demoMail()));
    await testSql()`
      UPDATE inbox_connections SET lease_owner = '4242.another-process', lease_until = now() + interval '3 minutes'
      WHERE user_id = ${userId}`;
    const before = await connectionRow(userId);

    const result = await check(userId);

    expect(result).toMatchObject({ busy: true, scanned: 0, stored: [], complete: false });
    expect(gmail.requests).toHaveLength(0);
    expect(await connectionRow(userId)).toEqual(before);
    expect(isSyncing(userId)).toBe(false);
    expect((await getInboxStatus(getDb(), userId)).syncing).toBe(true);
    await expect(dryRunInboxCheck(userId, { now: () => NOW, pace: pace.pace })).rejects.toThrow(DRY_RUN_BUSY_MESSAGE);
    expect(gmail.requests).toHaveLength(0);
  });

  it("an expired lease (a crashed process) is taken over; the run holds it while it runs and releases it", async () => {
    const { userId } = await gmailUser();
    gmail.deliver(...(await demoMail()));
    await testSql()`
      UPDATE inbox_connections SET lease_owner = '4242.crashed-process', lease_until = now() - interval '1 second'
      WHERE user_id = ${userId}`;
    const held: Array<{ owner: string | null; live: boolean }> = [];
    gmail.intercept = async (req) => {
      if (req.endpoint === "profile") {
        const [row] = await testSql()<{ lease_owner: string | null; live: boolean }[]>`
          SELECT lease_owner, lease_until > now() + interval '2 minutes' AS live FROM inbox_connections WHERE user_id = ${userId}`;
        held.push({ owner: row.lease_owner, live: row.live });
      }
      return undefined;
    };

    const result = await check(userId);

    expect(result).toMatchObject({ busy: false, scanned: 14, complete: true });
    expect(held).toEqual([{ owner: expect.stringMatching(new RegExp(`^${process.pid}\\.[0-9a-f-]{36}$`)), live: true }]);
    expect(await connectionRow(userId)).toMatchObject({ lease_owner: null, lease_until: null });
    expect((await getInboxStatus(getDb(), userId)).syncing).toBe(false);
  });

  it("a run whose lease was taken over stops at once, records nothing and leaves the new holder's lease alone", async () => {
    const { userId } = await gmailUser();
    await check(userId); // an empty mailbox: the position is set
    const start = (await connectionRow(userId)).history_id;
    const at = new Date(NOW.getTime() - HOUR);
    const mail = Array.from({ length: 3 }, (_, i) =>
      gmailMessage({ from: "Sam <sam@friends.example>", subject: `Note ${i}`, body: "See you soon.", at: new Date(at.getTime() + i * 60_000) }),
    );
    gmail.deliver(...mail);
    // Only the lease's renewal timer is faked: this process "stalled" past the lease, another
    // process took it over, and the next renewal finds that out.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const reached = Promise.withResolvers<void>();
      gmail.intercept = (req) => {
        if (req.endpoint !== "messages.get" || req.id !== mail[1].id) return undefined;
        reached.resolve();
        return new Promise<Response>(() => {}); // only the stop ends this request
      };
      const run = check(userId);
      await reached.promise;
      await testSql()`
        UPDATE inbox_connections SET lease_owner = '4242.another-process', lease_until = now() + interval '3 minutes'
        WHERE user_id = ${userId}`;
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(run).rejects.toMatchObject({ kind: "temporary", code: "stopped" });
      expect(isSyncing(userId)).toBe(false);
      expect(await connectionRow(userId)).toMatchObject({
        history_id: start,
        last_error_code: null,
        consecutive_failures: 0,
        lease_owner: "4242.another-process",
      });
      // Stopped before any message of the batch was written: none is blamed.
      expect((await ledger(userId)).size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is renewed while held, reports a takeover once, and never releases another's lease", async () => {
    const { userId } = await gmailUser();
    const onLost = vi.fn();
    const lease = (await holdLease(getDb(), userId, { renewMs: 20, onLost }))!;
    expect(lease).not.toBeNull();
    expect(await holdLease(getDb(), userId)).toBeNull();
    const until = async () => (await connectionRow(userId)).lease_until.getTime() as number;
    const first = await until();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await until()).toBeGreaterThan(first);

    await testSql()`UPDATE inbox_connections SET lease_owner = 'thief' WHERE user_id = ${userId}`;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(onLost).toHaveBeenCalledTimes(1);
    await lease.release();
    expect((await connectionRow(userId)).lease_owner).toBe("thief");
  });
});

describeDb("the dry run", () => {
  beforeEach(() => {
    vi.stubEnv("INBOX_BACKFILL_DAYS", "30");
    signedInEnv();
    inboxEnv({ mailSource: "" });
    resetEnvForTests();
    gmail = fakeGmail({ pageSize: 4 });
    vi.stubGlobal("fetch", gmail.fetch);
    pace = fakePace();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetSyncStopForTests();
    restoreEnv();
  });

  const dry = (userId: string, opts: { limit?: number } = {}) => dryRunInboxCheck(userId, { now: () => NOW, pace: pace.pace, ...opts });

  it("fetches and classifies what the first scan would, writes nothing, and predicts the real run", async () => {
    const { userId } = await gmailUser();
    gmail.deliver(...(await demoMail()));
    const counts = await tableCounts();
    const row = await connectionRow(userId);
    const before = await snapshot(userId);

    const result = await dry(userId);

    expect(await tableCounts()).toEqual(counts);
    expect(await connectionRow(userId)).toEqual(row);
    expect(await snapshot(userId)).toEqual(before);
    expect(result).toMatchObject({
      dryRun: true,
      mode: "full_scan",
      after: new Date(NOW.getTime() - 30 * DAY).toISOString(),
      listed: 14,
      alreadyDone: 0,
      fetchLimit: 200,
      fetched: 14,
      notFetched: 0,
      skipped: { label: 0, ownAddress: 0, gone: 0 },
      ignored: 3,
      outcomes: { matched: 8, created: 1, review: 2 },
      reviewReasons: { status_mismatch: 1, unknown_job: 1 },
      failed: {},
    });
    expect(result.sample).toHaveLength(14);
    expect(result.sample.slice(0, 11).every((s) => s.outcome !== "ignored")).toBe(true);
    expect(result.sample.slice(11).every((s) => s.outcome === "ignored" && s.company === null && s.status === null)).toBe(true);
    expect(result.sample).toContainEqual(
      expect.objectContaining({ outcome: "created", company: "Driftwood Audio", status: "applied", reviewReason: null }),
    );
    expect(result.sample).toContainEqual(expect.objectContaining({ outcome: "review", reviewReason: "status_mismatch", company: "Kelpie Analytics" }));
    expect(result.notes.join(" ")).toMatch(/at most 200 messages/);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);

    // The real run does what the dry run said.
    const real = await check(userId);
    expect(byOutcome(real.stored)).toEqual(result.outcomes);
    expect(real.ignored).toBe(result.ignored);
    // Afterwards the dry run looks at the history: nothing new.
    expect(await dry(userId)).toMatchObject({ mode: "incremental", listed: 0, fetched: 0 });
  });

  it("fetches at most `limit` messages and says how many it left out; subjects are cut to 80 characters", async () => {
    const { userId } = await gmailUser();
    const mail = await demoMail();
    const from = "Sam <sam@friends.example>";
    // Outside the 30-day window: not listed.
    const old = gmailMessage({ from, subject: "Old news", body: "Bike ride at nine?", at: new Date(NOW.getTime() - 40 * DAY) });
    // The oldest in the window, so among the five fetched.
    const chatter = gmailMessage({
      from,
      subject: `Weekend plans ${"and more ".repeat(30)}`,
      body: "Bike ride at nine?",
      at: new Date(Number(mail[0].internalDate) - HOUR),
    });
    gmail.deliver(old, chatter, ...mail);

    const result = await dry(userId, { limit: 5 });

    expect(result).toMatchObject({ listed: 15, fetchLimit: 5, fetched: 5, notFetched: 10 });
    expect(gmail.count("messages.get")).toBe(5);
    expect(gmail.count("messages.get", old.id)).toBe(0);
    const cut = result.sample.find((s) => s.subject.startsWith("Weekend plans"))!;
    expect([...cut.subject]).toHaveLength(80);
    expect(cut.subject.endsWith("…")).toBe(true);
    expect(result.notes.join(" ")).toMatch(/at most 5 messages; 10 more were listed but not fetched/);
  });
});

describeDb("stopAllSyncs", () => {
  beforeEach(() => {
    vi.stubEnv("INBOX_BACKFILL_DAYS", "30");
    signedInEnv();
    inboxEnv({ mailSource: "" });
    resetEnvForTests();
    gmail = fakeGmail();
    vi.stubGlobal("fetch", gmail.fetch);
    pace = fakePace();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetSyncStopForTests();
    restoreEnv();
  });

  it("ends a run between messages, records no failure, releases the lease, and refuses later runs", async () => {
    const { userId } = await gmailUser();
    // 30 unrelated messages, oldest first: the first batch of 25 is ingested before the stop.
    const mail = Array.from({ length: 30 }, (_, i) =>
      gmailMessage({ from: "Sam <sam@friends.example>", subject: `Note ${i}`, body: "See you soon.", at: new Date(NOW.getTime() - (40 - i) * HOUR) }),
    );
    gmail.deliver(...mail);
    let reached!: () => void;
    const atSecondBatch = new Promise<void>((resolve) => (reached = resolve));
    gmail.intercept = (req) => {
      if (req.endpoint !== "messages.get" || req.id !== mail[26].id) return undefined;
      reached();
      return new Promise<Response>(() => {}); // Gmail is slow; only the stop ends this request
    };

    const run = check(userId);
    await atSecondBatch;
    expect(isSyncing(userId)).toBe(true);
    stopAllSyncs();

    await expect(run).rejects.toMatchObject({ kind: "temporary", code: "stopped" });
    expect(isSyncing(userId)).toBe(false);
    const seen = await ledger(userId);
    expect(seen.size).toBe(25);
    expect([...seen.keys()].sort()).toEqual(mail.slice(0, 25).map((m) => m.id).sort());
    expect(await connectionRow(userId)).toMatchObject({
      last_error_code: null,
      consecutive_failures: 0,
      backfill_state: "running",
      lease_owner: null,
      lease_until: null,
    });

    // Later runs, joined or not, and dry runs: refused as stopped, nothing recorded.
    const requests = gmail.requests.length;
    await expect(check(userId)).rejects.toMatchObject({ code: "stopped" });
    await expect(runSync(userId, { now: () => NOW, pace: pace.pace })).rejects.toMatchObject({ code: "stopped" });
    await expect(dryRunInboxCheck(userId, { now: () => NOW, pace: pace.pace })).rejects.toMatchObject({ code: "stopped" });
    expect(gmail.requests).toHaveLength(requests);
    expect((await connectionRow(userId)).last_error_code).toBeNull();

    // After a restart (the flag reset), the scan finishes where it stopped.
    resetSyncStopForTests();
    gmail.intercept = null;
    expect(await check(userId)).toMatchObject({ mode: "full_scan", scanned: 5, complete: true });
    expect((await ledger(userId)).size).toBe(30);
  });

  it("ends a pacer wait at once (a long Retry-After)", async () => {
    const { userId } = await gmailUser();
    gmail.deliver(...(await demoMail()));
    pace = fakePace({ hangAtLeast: 30_000 });
    gmail.intercept = (req) => (req.endpoint === "messages.get" ? googleError(429, "rateLimitExceeded", { "retry-after": "30" }) : undefined);

    const run = check(userId);
    await pace.hung;
    stopAllSyncs();

    await expect(run).rejects.toMatchObject({ code: "stopped" });
    expect(await connectionRow(userId)).toMatchObject({ last_error_code: null, consecutive_failures: 0, lease_owner: null });
    expect((await ledger(userId)).size).toBe(0);
  });
});
