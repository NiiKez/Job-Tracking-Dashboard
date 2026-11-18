import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDb } from "@/lib/server/db/client";
import { getEnv } from "@/lib/server/env";
import type * as Repo from "@/lib/server/inbox/repo";
import { deleteAllSeenBefore, ensureDemoConnection, LEDGER_DAYS } from "@/lib/server/inbox/repo";
import type { GmailMessage, MailSource } from "@/lib/server/inbox/source/types";
import { sweepableUserIds, sweepNoResponse } from "@/lib/server/inbox/sweep";
import { runInboxCheck, type SyncResult } from "@/lib/server/inbox/sync/engine";
import { inboxError } from "@/lib/server/inbox/sync/errors";
import { resetSchedulerForTests, runSchedulerTick, startInboxScheduler, type SignalHost } from "@/lib/server/inbox/sync/scheduler";
import { listAllJobs } from "@/lib/server/services/jobs";
import { createUser, makeJob } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";
import {
  connectionRow,
  DAY,
  gmailMessage,
  ledger,
  messageSource,
  NOW,
  restoreInboxEnv,
  snapshot,
  stubBackfillDays,
  stubInboxEnv,
  sync,
  WINDOWS,
} from "./support";

// Reading mail again after the ledger forgot it. This deployment scans 180 days
// (INBOX_BACKFILL_DAYS), the ledger keeps 90 (repo.ts LEDGER_DAYS), so a resumed first scan, or a
// re-scan after an expired position, lists mail from 90 to 180 days ago whose ledger rows are
// gone. Stored mail must then be skipped by the guard in sync/ingest.ts (an email with this Gmail
// id exists: hasEmailForMessage, backed by emails_user_id_gmail_message_id_key), ignored mail is
// classified again, and the scan must still finish: an unfinished first scan holds up the
// no-response sweep.

// The guard asks hasEmailForMessage. Wrapped here, unchanged, so the tests can show that the guard
// is what skips the mail read again: every answer is recorded as [message id, found].
const guard = vi.hoisted(() => ({ answers: [] as Array<[string, boolean]> }));
vi.mock("@/lib/server/inbox/repo", async (importOriginal) => {
  const repo = await importOriginal<typeof Repo>();
  return {
    ...repo,
    hasEmailForMessage: async (...args: Parameters<typeof repo.hasEmailForMessage>) => {
      const found = await repo.hasEmailForMessage(...args);
      guard.answers.push([args[2], found]);
      return found;
    },
  };
});

const HOUR = 3_600_000;
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);

/** An interview invitation from Acme Robotics: matched to the Acme job, applied -> interview. */
const acmeInvite = (daysAgo: number) =>
  gmailMessage({
    from: "Jane Hart <jane@acmerobotics.example>",
    subject: "Interview for Platform Engineer",
    body: "We would like to invite you to an interview.",
    at: at(daysAgo),
  });

/** An agency recruiter's invitation that names no company: held for review. */
const agencyInvite = (daysAgo: number) =>
  gmailMessage({
    from: "Noah Stone <noah@talentbridge.example>",
    subject: "Next round",
    body: "We would like to invite you to an interview for the role.",
    at: at(daysAgo),
  });

/** Mail that is not about a job: ignored. */
const chatter = (daysAgo: number, subject = "Saturday") =>
  gmailMessage({ from: "Sam <sam@friends.example>", subject, body: "Bike ride at nine?", at: at(daysAgo) });

/** A user with the default rules, a demo connection and an applied job at Acme Robotics from 170 days before NOW. */
async function acmeUser(): Promise<{ userId: string; jobId: string }> {
  const userId = await createUser({ rules: true });
  await ensureDemoConnection(getDb(), userId);
  const job = await makeJob(userId, { company: "Acme Robotics", title: "Platform Engineer", status: "applied" });
  await testSql()`
    UPDATE jobs SET created_at = ${at(170)}, applied_at = ${at(170)}, updated_at = ${at(170)}, last_activity_at = ${at(170)}
    WHERE id = ${job.id}`;
  await testSql()`UPDATE job_status_events SET at = ${at(170)} WHERE job_id = ${job.id}`;
  return { userId, jobId: job.id };
}

/**
 * `messages` as a mailbox whose `flaky` message cannot be read the first time (too large: an
 * attempt, so the scan stays open). `fetched` lists every message served, in order.
 */
function failingOnce(messages: GmailMessage[], flaky: GmailMessage) {
  const base = messageSource(messages);
  const fetched: string[] = [];
  let failed = false;
  const source: MailSource = {
    ...base,
    getMessage: async (id) => {
      if (id === flaky.id && !failed) {
        failed = true;
        throw inboxError("response_too_large");
      }
      fetched.push(id);
      return base.getMessage(id);
    },
  };
  return { source, fetched };
}

/** The Acme job, with its history as [from, to, source]. */
async function acmeJob(userId: string) {
  const [job] = (await listAllJobs(getDb(), userId)).filter((j) => j.company === "Acme Robotics");
  return { ...job, events: job.history.map((e) => [e.from, e.to, e.source]) };
}

/** The user's emails from Gmail, by message id. */
async function gmailEmails(userId: string) {
  return testSql()<Array<{ gmail_message_id: string; outcome: string; review_reason: string | null }>>`
    SELECT gmail_message_id, outcome, review_reason FROM emails
    WHERE user_id = ${userId} AND gmail_message_id IS NOT NULL ORDER BY gmail_message_id`;
}

/** The ledger rows that still count against a message: to retry, or given up. */
async function failedRows(userId: string) {
  return [...(await ledger(userId)).values()].filter((r) => r.result === "retry" || r.result === "failed" || r.attempts > 0);
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

/** An applied job at Quiet Corp with no activity for 40 days: the sweep marks it once it may run. */
async function quietJob(userId: string): Promise<string> {
  const job = await makeJob(userId, { company: "Quiet Corp", title: "Engineer", status: "applied" });
  await testSql()`UPDATE jobs SET created_at = ${at(60)}, last_activity_at = ${at(40)} WHERE id = ${job.id}`;
  return job.id;
}

async function statusOf(jobId: string): Promise<string> {
  const [row] = await testSql()<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${jobId}`;
  return row.status;
}

/** What a scan left behind for one user, without ids and times. */
async function outcome(userId: string) {
  const sql = testSql();
  const [emails, jobs, seen, events] = await Promise.all([
    sql`
      SELECT gmail_message_id, outcome, detected_status, change_from, change_to, review_reason
      FROM emails WHERE user_id = ${userId} AND gmail_message_id IS NOT NULL ORDER BY gmail_message_id`,
    sql`SELECT company, title, status FROM jobs WHERE user_id = ${userId} ORDER BY company, title`,
    sql`SELECT gmail_message_id, result FROM inbox_seen_messages WHERE user_id = ${userId} ORDER BY gmail_message_id`,
    sql`SELECT from_status, to_status, source FROM job_status_events WHERE user_id = ${userId} ORDER BY from_status, to_status, source`,
  ]);
  return { emails: [...emails], jobs: [...jobs], ledger: [...seen], events: [...events] };
}

describeDb("reading mail again after the 90-day ledger clean-up (180-day scans)", () => {
  beforeEach(() => {
    stubInboxEnv();
    stubBackfillDays(180);
    guard.answers.length = 0;
  });
  afterEach(() => {
    resetSchedulerForTests();
    restoreInboxEnv();
  });

  it("stored mail: a resumed first scan lists mail stored 120 days ago again, after the clean-up removed its ledger rows, and the guard skips it", async () => {
    const { userId, jobId } = await acmeUser();
    const matched = acmeInvite(120);
    const review = agencyInvite(121);
    const recent = chatter(10);
    const mailbox = failingOnce([matched, review, recent], recent);

    // The first scan reads the whole window and stores the old mail; the recent message is left
    // to retry, so the scan stays open.
    const first = await sync(userId, mailbox.source);
    expect(first).toMatchObject({ mode: "full_scan", scanned: 3, ignored: 0, retry: 1, failed: 0, complete: false });
    expect(first.stored.map((e) => [e.subject, e.outcome, e.reviewReason])).toEqual([
      ["Next round", "review", "unknown_job"],
      ["Interview for Platform Engineer", "matched", null],
    ]);
    expect(await connectionRow(userId)).toMatchObject({
      backfill_state: "running",
      backfill_after: at(180),
      backfill_total: 3,
      backfill_done: 3,
    });
    // The run's own clean-up (deleteSeenBefore, LEDGER_DAYS) removed the rows of the old mail;
    // the retry row stays, since a run looked at it.
    expect([...(await ledger(userId)).keys()]).toEqual([recent.id]);
    const before = await snapshot(userId);
    const job = await acmeJob(userId);
    expect(job).toMatchObject({ id: jobId, status: "interview", emailCount: 1 });
    guard.answers.length = 0;

    const resumed = await sync(userId, mailbox.source);

    // Listed and fetched again (no ledger row), then skipped by the guard: nothing stored, nothing failed.
    expect(resumed).toMatchObject({ mode: "full_scan", scanned: 3, stored: [], ignored: 1, skipped: 0, retry: 0, failed: 0, complete: true });
    expect(mailbox.fetched).toEqual([review.id, matched.id, review.id, matched.id, recent.id]);
    expect(guard.answers).toEqual([
      [review.id, true],
      [matched.id, true],
      [recent.id, false],
    ]);
    // One email each, the job as it was (no second status event), nothing else changed.
    const emails = await gmailEmails(userId);
    expect(emails).toHaveLength(2);
    expect(Object.fromEntries(emails.map((e) => [e.gmail_message_id, [e.outcome, e.review_reason]]))).toEqual({
      [matched.id]: ["matched", null],
      [review.id]: ["review", "unknown_job"],
    });
    expect(await acmeJob(userId)).toEqual(job);
    expect(job.events).toEqual([
      [null, "applied", "paste"],
      ["applied", "interview", "email"],
    ]);
    expect({ ...(await snapshot(userId)), ledger: [] }).toEqual({ ...before, ledger: [] });
    // No attempt counted against the old mail (its rows, written "stored", went in this run's
    // clean-up again); only the recent message's one failed fetch. No failure on the connection.
    expect(await failedRows(userId)).toEqual([expect.objectContaining({ gmail_message_id: recent.id, result: "ignored", attempts: 1 })]);
    expect(await connectionRow(userId)).toMatchObject({
      backfill_state: "done",
      backfill_total: 3,
      backfill_done: 3,
      last_error_code: null,
      consecutive_failures: 0,
    });
  });

  it("ignored mail: a resumed first scan reads mail ignored 120 days ago again and ignores it again, without a failed attempt", async () => {
    const { userId, jobId } = await acmeUser();
    const old = chatter(120, "Saturday");
    const recent = chatter(10, "Photos");
    const mailbox = failingOnce([old, recent], recent);

    expect(await sync(userId, mailbox.source)).toMatchObject({ scanned: 2, stored: [], ignored: 1, retry: 1, complete: false });
    expect([...(await ledger(userId)).keys()]).toEqual([recent.id]);
    const before = await snapshot(userId);
    guard.answers.length = 0;

    const resumed = await sync(userId, mailbox.source);

    expect(resumed).toMatchObject({ mode: "full_scan", scanned: 2, stored: [], ignored: 2, skipped: 0, retry: 0, failed: 0, complete: true });
    // Fetched again and classified again (the guard found no email), ignored again.
    expect(mailbox.fetched).toEqual([old.id, old.id, recent.id]);
    expect(guard.answers).toEqual([
      [old.id, false],
      [recent.id, false],
    ]);
    expect({ ...(await snapshot(userId)), ledger: [] }).toEqual({ ...before, ledger: [] });
    expect(await gmailEmails(userId)).toEqual([]);
    expect(await acmeJob(userId)).toMatchObject({ id: jobId, status: "applied", emailCount: 0 });
    expect(await failedRows(userId)).toEqual([expect.objectContaining({ gmail_message_id: recent.id, result: "ignored", attempts: 1 })]);
    expect(await connectionRow(userId)).toMatchObject({ backfill_state: "done", last_error_code: null, consecutive_failures: 0 });
  });

  it("a re-scan after the position expired months later reads the mail stored and ignored then again, and changes nothing", async () => {
    const { userId, jobId } = await acmeUser();
    const matched = acmeInvite(120);
    const ignored = chatter(119.5);
    const lastSync = new Date(at(119.5).getTime() + HOUR);
    // The first scan (an empty mailbox) before the mail arrived, then the incremental sync that
    // read it. Its clean-up keeps the rows: 90 days back from then.
    await sync(userId, messageSource([]), { now: () => at(121) });
    const read = await sync(userId, messageSource([matched, ignored]), { now: () => lastSync });
    expect(read).toMatchObject({ mode: "incremental", scanned: 2, ignored: 1, complete: true });
    expect(read.stored.map((e) => [e.subject, e.outcome])).toEqual([["Interview for Platform Engineer", "matched"]]);
    // Then no successful sync for four months (the inbox needed reconnecting, say), while the
    // scheduler's clean-up (every 6 hours, for every user) removed the rows.
    await testSql()`UPDATE inbox_connections SET last_sync_ok_at = ${lastSync} WHERE user_id = ${userId}`;
    expect((await ledger(userId)).size).toBe(2);
    expect(await deleteAllSeenBefore(getDb(), new Date(NOW.getTime() - LEDGER_DAYS * DAY))).toBe(2);
    const before = await snapshot(userId);
    const job = await acmeJob(userId);
    guard.answers.length = 0;

    // Gmail no longer knows the position: a re-scan from a day before the last success.
    const rescan = await sync(userId, messageSource([matched, ignored], { historyExpired: true }));

    expect(rescan).toMatchObject({ mode: "full_scan", scanned: 2, stored: [], ignored: 1, retry: 0, failed: 0, complete: true });
    expect(guard.answers).toEqual([
      [matched.id, true],
      [ignored.id, false],
    ]);
    expect(await connectionRow(userId)).toMatchObject({
      backfill_state: "done",
      backfill_after: new Date(lastSync.getTime() - DAY),
      backfill_total: 2,
      backfill_done: 2,
      last_error_code: null,
      consecutive_failures: 0,
    });
    expect({ ...(await snapshot(userId)), ledger: [] }).toEqual({ ...before, ledger: [] });
    expect(await gmailEmails(userId)).toEqual([{ gmail_message_id: matched.id, outcome: "matched", review_reason: null }]);
    expect(await acmeJob(userId)).toEqual(job);
    expect(job).toMatchObject({ id: jobId, status: "interview" });
    expect(job.events).toHaveLength(2);
    expect(await failedRows(userId)).toEqual([]);
  });

  it.each(WINDOWS)(
    "a re-scan after an expired position reaches back to a day before the last success, at most INBOX_BACKFILL_DAYS (%i days)",
    async (days) => {
      stubBackfillDays(days);
      const userId = await createUser({ rules: true });
      await ensureDemoConnection(getDb(), userId);
      const lastSync = at(100);
      await testSql()`
        UPDATE inbox_connections SET history_id = '100000', backfill_state = 'done', last_sync_ok_at = ${lastSync}
        WHERE user_id = ${userId}`;
      // 50 days old: inside the 101 days back to the last success, outside a 30-day window.
      const message = chatter(50);

      const rescan = await sync(userId, messageSource([message], { historyExpired: true }));

      const reaches = days >= 101;
      expect(rescan).toMatchObject({ mode: "full_scan", scanned: reaches ? 1 : 0, complete: true });
      expect(await connectionRow(userId)).toMatchObject({
        backfill_state: "done",
        backfill_after: reaches ? new Date(lastSync.getTime() - DAY) : at(days),
      });
      expect((await ledger(userId)).has(message.id)).toBe(reaches);
    },
  );

  it("a first scan interrupted midway is resumed over the whole 180 days and finishes; until then the no-response sweep waits", async () => {
    const { userId, jobId } = await acmeUser();
    const quiet = await quietJob(userId);
    // One unrelated message every 10 days from 175 to 5 days ago, two about jobs (150 and 120
    // days old), and one just outside the window: 20 listed, 11 of them older than 90 days.
    const notes = Array.from({ length: 18 }, (_, i) => chatter(175 - 10 * i, `Note ${i}`));
    const review = agencyInvite(150);
    const matched = acmeInvite(120);
    const outside = chatter(181, "Too old");
    const newest = notes.at(-1)!;
    const listed = [...notes, review, matched];
    const messages = [outside, ...listed];

    // Gmail answers `fetchesLeft` message fetches, then is down (the engine's probe, getProfile,
    // fails too); `tooLarge` makes the newest message's next fetch fail as an attempt.
    const base = messageSource(messages);
    let fetchesLeft = 14;
    let tooLarge = false;
    const fetched: string[] = [];
    const source: MailSource = {
      ...base,
      getProfile: async () => {
        if (fetchesLeft <= 0) throw inboxError("google_unavailable");
        return base.getProfile();
      },
      getMessage: async (id) => {
        if (fetchesLeft <= 0) throw inboxError("google_unavailable");
        fetchesLeft--;
        if (id === newest.id && tooLarge) {
          tooLarge = false;
          throw inboxError("response_too_large");
        }
        fetched.push(id);
        return base.getMessage(id);
      },
    };

    // The scheduler with the real queries, engine, sweep and clean-up, everything at NOW.
    const lines: string[] = [];
    const runs: SyncResult[] = [];
    expect(
      startInboxScheduler({
        env: getEnv(),
        signals: quietProcess(),
        deps: {
          now: () => NOW,
          sync: async (id, signal) => {
            const result = await runInboxCheck(id, { source, now: () => NOW, signal });
            runs.push(result);
            return result;
          },
          stopAllSyncs: vi.fn(),
          log: (line) => void lines.push(line),
        },
      }),
    ).toBe("started");
    const tick = async () => {
      // Due at NOW (the engine schedules the next run by the database's clock).
      await testSql()`UPDATE inbox_connections SET next_sync_at = ${NOW} WHERE user_id = ${userId}`;
      await runSchedulerTick();
      return lines.at(-1);
    };

    // 1. Gmail goes down after 14 fetches: those 14 messages, the oldest, are stored or ignored,
    //    then the run ends. The tick's clean-up (a new process cleans on its first tick) then
    //    removes the rows of the 11 of them older than 90 days.
    expect(await tick()).toBe("inbox: scheduler: failed 1 (google_unavailable), deleted 11 old ledger rows");
    expect(await connectionRow(userId)).toMatchObject({
      backfill_state: "running",
      backfill_after: at(180),
      backfill_total: 20,
      backfill_done: 14,
      last_sync_ok_at: null,
      last_error_code: "google_unavailable",
    });
    expect((await ledger(userId)).size).toBe(3);
    expect(await statusOf(quiet)).toBe("applied");
    expect(await sweepableUserIds(getDb(), NOW)).not.toContain(userId);

    // 2. Gmail is back; the newest message cannot be read this time. The run looks at everything
    //    the ledger does not have: the 11 old ones again (the guard finds the two stored) and the
    //    6 never fetched. It succeeds but is not complete, so no sweep follows it, and the gate
    //    keeps the user out: the last sync is fresh, only backfill_state is not "done".
    fetchesLeft = Infinity;
    tooLarge = true;
    guard.answers.length = 0;
    expect(await tick()).toBe("inbox: scheduler: synced 1 (1 not complete)");
    expect(runs.at(-1)).toMatchObject({ mode: "full_scan", scanned: 17, stored: [], ignored: 14, retry: 1, failed: 0, complete: false });
    expect(guard.answers.filter(([, found]) => found).map(([id]) => id).sort()).toEqual([matched.id, review.id].sort());
    const open = await connectionRow(userId);
    expect(open).toMatchObject({ status: "connected", backfill_state: "running", backfill_total: 20, backfill_done: 20, last_error_code: null });
    // The database's clock, after NOW: well within two sync intervals.
    expect(open.last_sync_ok_at.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
    expect(await sweepableUserIds(getDb(), NOW)).not.toContain(userId);
    expect(await statusOf(quiet)).toBe("applied");

    // 3. The next run retries the newest message and finishes the scan. It reads the 11 old ones
    //    once more: the clean-up after run 2 removed their rows again. Then the sweep runs.
    guard.answers.length = 0;
    expect(await tick()).toBe("inbox: scheduler: synced 1, marked 1 no response");
    expect(runs.at(-1)).toMatchObject({ scanned: 12, stored: [], ignored: 10, retry: 0, failed: 0, complete: true });
    expect(guard.answers.filter(([, found]) => found).map(([id]) => id).sort()).toEqual([matched.id, review.id].sort());
    expect(await connectionRow(userId)).toMatchObject({
      backfill_state: "done",
      backfill_after: at(180),
      backfill_total: 20,
      backfill_done: 20,
      last_error_code: null,
      consecutive_failures: 0,
    });
    expect(await sweepableUserIds(getDb(), NOW)).toContain(userId);
    expect(await statusOf(quiet)).toBe("no_response");
    expect(await failedRows(userId)).toEqual([expect.objectContaining({ gmail_message_id: newest.id, result: "ignored", attempts: 1 })]);

    // The whole window was read, nothing outside it, and the result is that of one uninterrupted
    // scan of the same mailbox (then swept).
    expect(new Set(fetched)).toEqual(new Set(listed.map((m) => m.id)));
    expect(fetched).not.toContain(outside.id);
    expect(await acmeJob(userId)).toMatchObject({ id: jobId, status: "interview", emailCount: 1 });
    const reference = await acmeUser();
    await quietJob(reference.userId);
    expect(await sync(reference.userId, messageSource(messages))).toMatchObject({ scanned: 20, complete: true });
    await sweepNoResponse(reference.userId, { now: NOW });
    expect(await outcome(userId)).toEqual(await outcome(reference.userId));
  });
});
