import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDb } from "@/lib/server/db/client";
import { DEMO_CAPS } from "@/lib/server/demo/caps";
import { getEnv, parseEnv, type Env } from "@/lib/server/env";
import { ensureDemoConnection } from "@/lib/server/inbox/repo";
import { updateSettings } from "@/lib/server/services/settings";
import type { MailSource } from "@/lib/server/inbox/source/types";
import { runInboxCheck, type RunOptions } from "@/lib/server/inbox/sync/engine";
import { sweepNoResponse } from "@/lib/server/inbox/sweep";
import { inboxError } from "@/lib/server/inbox/sync/errors";
import {
  nextDueUserId,
  resetSchedulerForTests,
  runSchedulerTick,
  startInboxScheduler,
  stopInboxScheduler,
  type SchedulerDeps,
  type SignalHost,
  type StartResult,
} from "@/lib/server/inbox/sync/scheduler";
import { createUser, makeJob } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";
import { stubDemoMode } from "../demo/support";
import { connectionRow, demoUser, folderSource, NOW, restoreInboxEnv, stubInboxEnv } from "./support";

// The scheduler on the real database and the real engine (fixture mail): the due query, a tick,
// the engine's back-off as the scheduler sees it, a stop and a restart mid-sync, and the
// periodic sweep through the gate. The timer and the signals are tested in
// tests/unit/inbox/scheduler.test.ts.

const MINUTE = 60_000;

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

/**
 * A scheduler with the real queries, engine and sweep. `sync` runs runInboxCheck at the seed's
 * NOW (the fixture mail lands on the same days whenever the test runs), with `source` if given.
 * stopAllSyncs is a spy: the real one stops the engine for the rest of the test process.
 */
function start(
  opts: { source?: () => MailSource; deps?: Partial<SchedulerDeps>; env?: Env; expect?: StartResult } = {},
) {
  const lines: string[] = [];
  const sync = (userId: string, signal: AbortSignal) => {
    const run: RunOptions = { signal, now: () => NOW };
    if (opts.source) run.source = opts.source();
    return runInboxCheck(userId, run);
  };
  const result = startInboxScheduler({
    env: opts.env ?? getEnv(),
    signals: quietProcess(),
    deps: { sync, stopAllSyncs: vi.fn(), log: (line) => void lines.push(line), ...opts.deps },
  });
  expect(result).toBe(opts.expect ?? "started");
  return lines;
}

/** A connected demo connection with its sync columns set. */
async function connection(userId: string, set: { status?: string; nextSyncAt?: Date | null }) {
  await ensureDemoConnection(getDb(), userId);
  await testSql()`
    UPDATE inbox_connections SET status = ${set.status ?? "connected"}, next_sync_at = ${set.nextSyncAt ?? null}
    WHERE user_id = ${userId}`;
}

/** An applied job whose last activity is 40 days old: the sweep marks it. */
async function quietJob(userId: string, company = "Quiet Corp"): Promise<string> {
  const job = await makeJob(userId, { company, title: "Engineer", status: "applied" });
  await testSql()`UPDATE jobs SET last_activity_at = now() - interval '40 days' WHERE id = ${job.id}`;
  return job.id;
}

async function statusOf(jobId: string): Promise<string> {
  const [row] = await testSql()<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${jobId}`;
  return row.status;
}

/** What a sync left behind for one user, without ids and times. */
async function result(userId: string) {
  const sql = testSql();
  const [emails, jobs, ledger, events] = await Promise.all([
    sql`
      SELECT gmail_message_id, outcome, detected_status, change_from, change_to, review_reason
      FROM emails WHERE user_id = ${userId} AND gmail_message_id IS NOT NULL ORDER BY gmail_message_id`,
    sql`SELECT company, title, status FROM jobs WHERE user_id = ${userId} ORDER BY company, title, status`,
    sql`SELECT gmail_message_id, result FROM inbox_seen_messages WHERE user_id = ${userId} ORDER BY gmail_message_id`,
    sql`SELECT from_status, to_status, source FROM job_status_events WHERE user_id = ${userId} ORDER BY from_status, to_status, source`,
  ]);
  return { emails: [...emails], jobs: [...jobs], ledger: [...ledger], events: [...events] };
}

describeDb("the inbox scheduler", () => {
  beforeEach(stubInboxEnv);
  afterEach(() => {
    resetSchedulerForTests();
    restoreInboxEnv();
  });

  it("the due query: connected, next_sync_at reached, oldest first, leaving out the ones tried", async () => {
    const now = new Date();
    const [a, b, future, unscheduled, reconnect, disconnected] = await Promise.all(
      Array.from({ length: 6 }, () => createUser()),
    );
    await connection(a, { nextSyncAt: new Date(now.getTime() - 10 * MINUTE) });
    await connection(b, { nextSyncAt: new Date(now.getTime() - 20 * MINUTE) });
    await connection(future, { nextSyncAt: new Date(now.getTime() + MINUTE) });
    await connection(unscheduled, { nextSyncAt: null });
    await connection(reconnect, { status: "needs_reconnect", nextSyncAt: new Date(now.getTime() - 30 * MINUTE) });
    await connection(disconnected, { status: "disconnected", nextSyncAt: new Date(now.getTime() - 30 * MINUTE) });

    const db = getDb();
    expect(await nextDueUserId(db, now)).toBe(b);
    expect(await nextDueUserId(db, now, [b])).toBe(a);
    expect(await nextDueUserId(db, now, [b, a])).toBeNull();
    expect(await nextDueUserId(db, new Date(now.getTime() + MINUTE), [b, a])).toBe(future);

    // With MAIL_SOURCE=fixture only demo connections: the demo mail never goes into a Gmail
    // connection's position. With Gmail, a demo one is due too (it then needs a reconnect).
    await testSql()`UPDATE inbox_connections SET demo = false WHERE user_id = ${b}`;
    expect(await nextDueUserId(db, now, [], { demoOnly: true })).toBe(a);
    expect(await nextDueUserId(db, now, [a], { demoOnly: true })).toBeNull();
    expect(await nextDueUserId(db, now, [], { demoOnly: false })).toBe(b);
  });

  it("a tick syncs a due connection, sweeps after it, and the next sync is due one interval after it finished", async () => {
    const { userId } = await demoUser();
    const quiet = await quietJob(userId);
    const lines = start();

    await runSchedulerTick();

    const row = await connectionRow(userId);
    expect(row).toMatchObject({ backfill_state: "done", consecutive_failures: 0, last_error_code: null, lease_owner: null });
    expect(row.next_sync_at.getTime() - row.last_sync_ok_at.getTime()).toBe(15 * MINUTE);
    expect((await result(userId)).ledger).toHaveLength(14);
    expect(await statusOf(quiet)).toBe("no_response");
    expect(lines.at(-1)).toMatch(/^inbox: scheduler: synced 1, marked [1-9]\d* no response$/);

    expect(await nextDueUserId(getDb(), new Date())).toBeNull();
    expect(await nextDueUserId(getDb(), new Date(row.next_sync_at.getTime() + 1))).toBe(userId);
  });

  it("after a failure the connection waits as the engine wrote it: twice the interval, then 60 minutes at most", async () => {
    const userId = await createUser();
    await connection(userId, { nextSyncAt: new Date(Date.now() - MINUTE) });
    const failing = (): MailSource => ({ ...folderSource(), getProfile: () => Promise.reject(inboxError("google_unavailable")) });
    const lines = start({ source: failing });

    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await runSchedulerTick();
      const row = await connectionRow(userId);
      expect(row).toMatchObject({ last_error_code: "google_unavailable", consecutive_failures: i + 1 });
      waits.push((row.next_sync_at.getTime() - row.last_error_at.getTime()) / MINUTE);
      // Not due before then, due after (+1 ms: the column keeps microseconds, Date does not).
      expect(await nextDueUserId(getDb(), new Date(row.next_sync_at.getTime() - 1000))).toBeNull();
      expect(await nextDueUserId(getDb(), new Date(row.next_sync_at.getTime() + 1))).toBe(userId);
      await testSql()`UPDATE inbox_connections SET next_sync_at = now() - interval '1 second' WHERE user_id = ${userId}`;
    }
    expect(waits).toEqual([30, 60, 60]);
    expect(lines.at(-1)).toBe("inbox: scheduler: failed 1 (google_unavailable)");
  });

  it("a run stopped mid-sync records nothing and stays due; a new process resumes it once the old lease expires", async () => {
    // The same mail synced in one go, for comparison.
    const reference = await demoUser();
    await runInboxCheck(reference.userId, { source: folderSource(), now: () => NOW });

    const { userId } = await demoUser();
    const base = folderSource();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let fetching!: () => void;
    const fetched = new Promise<void>((resolve) => (fetching = resolve));
    const slow: MailSource = {
      ...base,
      getMessage: async (id) => {
        fetching();
        await gate;
        return base.getMessage(id);
      },
    };
    let lines = start({ source: () => slow });
    const tick = runSchedulerTick();
    await fetched;
    expect(await connectionRow(userId)).toMatchObject({ backfill_state: "running", history_id: expect.any(String) });

    stopInboxScheduler("SIGTERM");
    release();
    await tick;
    const stopped = await connectionRow(userId);
    expect(stopped).toMatchObject({ backfill_state: "running", last_error_code: null, consecutive_failures: 0, lease_owner: null });
    expect(stopped.next_sync_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(lines).toEqual([
      "inbox: scheduler started, every 60 s: timed syncs, the no-response sweep and the ledger clean-up",
      "inbox: scheduler stopped (SIGTERM), during a tick",
      "inbox: scheduler: failed 1 (stopped)",
    ]);

    // A process that died mid-sync leaves its lease behind: the new one finds it busy and waits.
    await testSql()`
      UPDATE inbox_connections SET lease_owner = 'process-that-died', lease_until = now() + interval '3 minutes'
      WHERE user_id = ${userId}`;
    const before = await result(userId);
    resetSchedulerForTests();
    lines = start();
    await runSchedulerTick();
    expect(lines.at(-1)).toBe("inbox: scheduler: busy 1 (lease held elsewhere)");
    expect(await result(userId)).toEqual(before);
    expect((await connectionRow(userId)).next_sync_at.getTime()).toBe(stopped.next_sync_at.getTime());

    await testSql()`UPDATE inbox_connections SET lease_until = now() - interval '1 second' WHERE user_id = ${userId}`;
    await runSchedulerTick();
    expect(lines.at(-1)).toMatch(/^inbox: scheduler: synced 1/);
    expect(await connectionRow(userId)).toMatchObject({ backfill_state: "done", lease_owner: null });
    const resumed = await result(userId);
    expect(resumed.ledger).toHaveLength(14);
    expect(resumed).toEqual(await result(reference.userId));
  });

  it("a shorter interval in Settings moves the scheduled run forward; a longer one waits for it", async () => {
    const userId = await createUser();
    await ensureDemoConnection(getDb(), userId);
    await testSql()`
      UPDATE inbox_connections
      SET last_sync_ok_at = now() - interval '10 minutes', next_sync_at = now() + interval '50 minutes'
      WHERE user_id = ${userId}`;
    const minutesAway = async () => {
      const [row] = await testSql()<{ m: number }[]>`
        SELECT round(extract(epoch FROM next_sync_at - now()) / 60)::int AS m FROM inbox_connections
        WHERE user_id = ${userId}`;
      return row.m;
    };
    await updateSettings(userId, { inbox: { intervalMinutes: 120 } });
    expect(await minutesAway()).toBe(50);
    await updateSettings(userId, { inbox: { intervalMinutes: 15 } });
    expect(await minutesAway()).toBe(5);
    await updateSettings(userId, { inbox: { intervalMinutes: 5 } });
    expect(await minutesAway()).toBe(-5);
  });

  it("deletes old ledger rows of every user, whatever the connection's status, recent retry rows excepted", async () => {
    const day = 86_400_000;
    const ago = (days: number) => new Date(Date.now() - days * day);
    const connected = await createUser();
    const reconnect = await createUser();
    const disconnected = await createUser();
    await connection(connected, { nextSyncAt: null });
    await connection(reconnect, { status: "needs_reconnect" });
    await connection(disconnected, { status: "disconnected" });
    const users = [connected, reconnect, disconnected];
    for (const userId of users) {
      for (const [id, result, internalDate, seenAt] of [
        ["old-ignored", "ignored", ago(91), ago(91)],
        ["old-failed", "failed", ago(100), ago(2)],
        ["old-unread", "skipped", null, ago(91)],
        ["old-retry", "retry", ago(120), ago(1)], // a run still tries it
        ["stale-retry", "retry", ago(120), ago(95)], // no run has looked at it for 90 days
        ["recent", "stored", ago(10), ago(10)],
      ] as const) {
        await testSql()`
          INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result, internal_date, seen_at)
          VALUES (${userId}, ${id}, ${result}, ${internalDate}, ${seenAt})`;
      }
    }
    const left = async () =>
      Object.fromEntries(
        await Promise.all(
          users.map(async (userId) => {
            const rows = await testSql()<{ id: string }[]>`
              SELECT gmail_message_id AS id FROM inbox_seen_messages WHERE user_id = ${userId} ORDER BY gmail_message_id`;
            return [userId, rows.map((r) => r.id)];
          }),
        ),
      );
    const lines = start();

    await runSchedulerTick();

    expect(await left()).toEqual(Object.fromEntries(users.map((u) => [u, ["old-retry", "recent"]])));
    expect(lines.at(-1)).toBe("inbox: scheduler: deleted 12 old ledger rows");

    // Not again before 6 hours have passed.
    await testSql()`
      INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result, internal_date)
      VALUES (${disconnected}, 'old-again', 'ignored', ${ago(95)})`;
    await runSchedulerTick();
    expect((await left())[disconnected]).toEqual(["old-again", "old-retry", "recent"]);
  });

  // Owner, 2026-11-17: "off stops syncing only"; and nobody is swept before a first scan. Without
  // a key this is production after the merge: no connection anywhere, so nobody is swept.
  it.each([
    ["INBOX_SCHEDULER=off", parseEnv({ MAIL_SOURCE: "fixture", INBOX_SCHEDULER: "off" })],
    ["no INBOX_TOKEN_KEY", parseEnv({})],
  ])("with %s it syncs nothing, but sweeps and cleans the ledger", async (_, env) => {
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
    const manual = await createUser();
    const due = await createUser();
    const disconnected = await createUser();
    await connection(due, { nextSyncAt: new Date(Date.now() - MINUTE) });
    await connection(disconnected, { status: "disconnected" });
    const jobs = { manual: await quietJob(manual), due: await quietJob(due), disconnected: await quietJob(disconnected) };
    await testSql()`
      INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result, internal_date, seen_at)
      VALUES (${disconnected}, 'old', 'ignored', ${ago(91)}, ${ago(91)}), (${disconnected}, 'recent', 'stored', ${ago(5)}, ${ago(5)})`;
    const sync = vi.fn();
    const lines = start({ env, expect: "maintenance_only", deps: { sync } });

    await runSchedulerTick();

    expect(sync).not.toHaveBeenCalled();
    expect(await connectionRow(due)).toMatchObject({ backfill_state: "pending", history_id: null, last_sync_ok_at: null });
    expect((await result(due)).ledger).toEqual([]);
    expect({
      manual: await statusOf(jobs.manual),
      due: await statusOf(jobs.due),
      disconnected: await statusOf(jobs.disconnected),
    }).toEqual({ manual: "applied", due: "applied", disconnected: "no_response" });
    expect((await result(disconnected)).ledger).toEqual([{ gmail_message_id: "recent", result: "stored" }]);
    expect(lines.at(-1)).toBe("inbox: scheduler: marked 1 no response, deleted 1 old ledger rows");
  });

  it("the periodic sweep marks only users the gate lets through", async () => {
    const now = new Date();
    const manual = await createUser(); // never connected: not before a first scan has run
    const disconnected = await createUser(); // stopped reading mail: tracked by hand
    const reconnect = await createUser();
    const behind = await createUser();
    const fresh = await createUser();
    await connection(disconnected, { status: "disconnected" });
    await connection(reconnect, { status: "needs_reconnect" });
    for (const [userId, lastOk] of [
      [behind, new Date(now.getTime() - 2 * 60 * MINUTE)],
      [fresh, new Date(now.getTime() - 5 * MINUTE)],
    ] as const) {
      await connection(userId, { nextSyncAt: new Date(now.getTime() + 10 * MINUTE) });
      await testSql()`
        UPDATE inbox_connections SET backfill_state = 'done', history_id = '100015', last_sync_ok_at = ${lastOk}
        WHERE user_id = ${userId}`;
    }
    const jobs = {
      manual: await quietJob(manual),
      disconnected: await quietJob(disconnected),
      reconnect: await quietJob(reconnect),
      behind: await quietJob(behind),
      fresh: await quietJob(fresh),
    };
    const lines = start();

    await runSchedulerTick();
    expect({
      manual: await statusOf(jobs.manual),
      disconnected: await statusOf(jobs.disconnected),
      reconnect: await statusOf(jobs.reconnect),
      behind: await statusOf(jobs.behind),
      fresh: await statusOf(jobs.fresh),
    }).toEqual({ manual: "applied", disconnected: "no_response", reconnect: "applied", behind: "applied", fresh: "no_response" });
    expect(lines.at(-1)).toBe("inbox: scheduler: marked 2 no response");
    // Nothing is due, and the swept users wait 6 hours: the next tick says nothing.
    await runSchedulerTick();
    expect(lines.at(-1)).toBe("inbox: scheduler: marked 2 no response");
    expect(lines).toHaveLength(2);
  });

  it("in demo mode, purges the expired demo workspaces and nothing else", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const env = parseEnv({ DEMO_MODE: "on", APP_URL: "https://demo.example.com" });
    const owner = await createUser(); // not a demo user, however old
    const [expired, live] = await Promise.all([25, 23].map(async (hours) => {
      const [row] = await testSql()<{ id: string }[]>`
        INSERT INTO users (google_sub, email, name, created_at)
        VALUES ('demo:' || gen_random_uuid(), 'alex.' || ${hours}::int || '@demo.invalid', 'Alex Demo',
                now() - make_interval(hours => ${hours}::int))
        RETURNING id`;
      return row.id;
    }));
    await testSql()`UPDATE users SET created_at = now() - interval '400 days' WHERE id = ${owner}`;
    start({ env, expect: "maintenance_only", deps: { sync: vi.fn() } });

    await runSchedulerTick();
    const ids = (await testSql()<{ id: string }[]>`SELECT id FROM users`).map((r) => r.id);
    expect(ids.sort()).toEqual([owner, live].sort());
    expect(ids).not.toContain(expired);
    expect(info).toHaveBeenCalledWith("demo: purged 1 expired workspace");
  });

  it("in demo mode, a workspace at the status-event cap is swept without a warning, then left for 6 hours", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    stubDemoMode(true); // the cap (demo/caps.ts) reads getEnv()
    const user = await createUser();
    await connection(user, { status: "disconnected" }); // the gate lets it through
    const jobId = await quietJob(user);
    await testSql()`
      INSERT INTO job_status_events (user_id, job_id, from_status, to_status, source)
      SELECT ${user}, ${jobId}, 'saved', 'applied', 'manual'
      FROM generate_series(1, ${DEMO_CAPS.statusEvents - 1}::int)`;
    const sweep = vi.fn(async (userId: string, now: Date) => (await sweepNoResponse(userId, { now })).length);
    const lines = start({ env: getEnv(), expect: "maintenance_only", deps: { sync: vi.fn(), sweep } });

    await runSchedulerTick();
    await expect(sweep.mock.results[0].value).rejects.toThrow("at most 500 status changes");
    await runSchedulerTick();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(await statusOf(jobId)).toBe("applied");
    // The start line only: no warning.
    expect(lines).toHaveLength(1);
  });
});
