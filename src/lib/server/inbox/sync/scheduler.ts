import "server-only";
import { getDb, type Db } from "@/lib/server/db/client";
import { purgeExpiredWorkspaces } from "@/lib/server/demo/workspaces";
import { getEnv, inboxTokenKeys, type Env } from "@/lib/server/env";
import { isErrorNamed } from "@/lib/server/errors";
import { deleteAllSeenBefore, LEDGER_DAYS } from "../repo";
import { SWEEP_EVERY_MS, sweepableUserIds, sweepNoResponse } from "../sweep";
import { runInboxCheck, stopAllSyncs } from "./engine";
import { errorCode } from "./ingest";

/**
 * The inbox scheduler (docs/plan/2-gmail-ingest.md, "Scheduler" and "No-response sweep").
 *
 *   startInboxScheduler(opts?)    called by register() in src/instrumentation.ts. Starts a
 *                                 TICK_MS timer and returns at once, without waiting for any work
 *                                 (register() must finish before the server takes requests).
 *                                 Returns what it did:
 *                                   "started"          every part of a tick (below)
 *                                   "maintenance_only" steps 3 and 4 only, no timed syncs:
 *                                                      INBOX_SCHEDULER=off, or no INBOX_TOKEN_KEY
 *                                                      and MAIL_SOURCE is not "fixture"; or the
 *                                                      public demo (DEMO_MODE=on): steps 3 to 5
 *                                   "build"            nothing: NEXT_PHASE is the production build
 *                                   "running"          nothing: a scheduler already runs in this
 *                                                      process (a flag on globalThis; also after a
 *                                                      stop)
 *                                 "Off stops syncing only" (owner, 2026-11-17): the sweep and the
 *                                 90-day clean-up /privacy promises run in every configuration.
 *                                 The start line in the log says which parts run. The Node
 *                                 runtime is register()'s check: this module is only imported
 *                                 there.
 *   stopInboxScheduler(reason?)   the stop flag: clears the timer, ends the current tick after the
 *                                 step it is on, aborts the runs the scheduler started and calls
 *                                 stopAllSyncs() (engine.ts: every run in the process, the
 *                                 manual ones too, stops between messages; later runs refuse).
 *                                 SIGTERM and SIGINT call it.
 *   runSchedulerTick()            a tick now (tests, the real-server check); joins one that runs
 *   isSchedulerRunning()          started and not stopped
 *   nextDueUserId(db, now, skip?, { demoOnly? })
 *                                 the "which connection is due" query
 *   resetSchedulerForTests()      stops and forgets the scheduler, removes its signal listeners
 *
 * A tick (steps 1 and 2 only when the timed syncs run; the stop and the signals are the same
 * either way):
 *   1. Connections with status "connected" and next_sync_at <= now, oldest due first, one after
 *      another through runInboxCheck(userId) (a manual "Check inbox" running for that user is
 *      joined, not doubled). The query is asked again before each one, so a connection synced
 *      meanwhile is not run twice; a connection already tried in this tick is skipped, so one
 *      that failed without moving next_sync_at waits for the next tick. So does one whose lease
 *      another process holds (`busy`: nothing done, nothing recorded), e.g. a process that died
 *      mid-sync, until its lease expires. With MAIL_SOURCE=fixture only demo connections are
 *      due: the demo mail is never synced into a Gmail connection, whose token, position,
 *      ledger and jobs stay as they are (Check inbox refuses it too, repo.ts
 *      ensureDemoConnection). With Gmail a demo connection is due as any other: it has no token,
 *      so it becomes needs_reconnect.
 *   2. After a run that finished completely: the no-response sweep for that user, as the check
 *      route does.
 *   3. The periodic sweep: every user the gate lets through (sweep.ts sweepableUserIds: never a
 *      user who has not connected an inbox) and not swept for SWEEP_EVERY_MS. The last sweep
 *      times live in memory: a new process sweeps every such user on its first tick, which keeps
 *      "at least every 6 hours" across restarts. Each tick forgets the times of users the gate no
 *      longer lets through (deleted users too: the demo makes and purges them all day), so the
 *      memory stays bounded; such a user is swept at once when it comes back.
 *      In the demo, a sweep that a workspace's status-event cap refuses (demo/caps.ts, a
 *      ConflictError) counts as done, without a warning: the workspace cannot take the change,
 *      and trying it every minute until the workspace expires would only repeat the warning.
 *   4. The ledger clean-up, every LEDGER_CLEANUP_EVERY_MS (and on a new process's first tick):
 *      rows older than LEDGER_DAYS of every user, whatever the connection's status ("retry" rows
 *      a run looked at in that time excepted; repo.ts deleteAllSeenBefore). The engine also
 *      cleans a user's ledger after each successful sync, but a disconnected mailbox, one that
 *      needs reconnecting, or one nobody checks while the timed syncs are off has none, and
 *      /privacy promises the 90 days.
 *   5. The public demo only (DEMO_MODE=on): the purge of expired workspaces
 *      (src/lib/server/demo/workspaces.ts purgeExpiredWorkspaces: demo users past their 24 hours,
 *      with all their rows), every PURGE_EVERY_MS (and on a new process's first tick).
 *      POST /auth/demo purges before each creation as well, in case the scheduler did not start.
 *      The timed syncs are always off in the demo (parseEnv refuses INBOX_SCHEDULER=on there, and
 *      this file checks demoMode too): the visitor's "Sync now" files the invented mail.
 *   Ticks never overlap: a timer that fires while one runs is skipped. Errors are caught per
 *   user (one user's failure does not stop the others) and logged as codes. One log line per
 *   tick, only when there was work: runs, failures, jobs marked, ledger rows deleted, a failed
 *   purge (the purge logs its own count: "demo: purged …").
 *
 * next_sync_at is the engine's business (repo.ts recordSyncSuccess / recordSyncFailure): the
 * finish time plus the interval from settings, read fresh each time; after failures the wait
 * doubles up to 60 minutes. A run that was stopped records nothing, so its connection stays due
 * and the next tick (after a restart: of the new process) resumes it.
 *
 * Shutdown. `next start` (16.4, server/lib/start-server.js) listens to SIGINT and SIGTERM: it
 * closes the HTTP server, waits for requests in flight, then calls process.exit(130 / 143). It
 * does not wait for background work. PM2 stops the app with SIGINT and kills it 10 seconds later.
 * This module adds its own listeners beside Next's (it never replaces or blocks them): the stop
 * flag ends runs between messages, so a "Check inbox" request waiting on a run answers at once
 * instead of holding server.close() for up to 20 seconds. Whatever a run had not committed when
 * the process exits is rolled back by PostgreSQL and repeated by the next run; its lease expires.
 * Without Next's listener (NEXT_MANUAL_SIG_HANDLE, a custom server) the scheduler's listener
 * would be the only one and would keep the process alive, so then it removes itself and raises
 * the signal again.
 *
 * Single instance: the deploy runs one process (PM2 fork mode, instances 1). The scheduler
 * assumes it: two processes would both tick, and only the lease on the connection row keeps
 * their runs apart.
 */

/** How often the scheduler looks for due connections. */
export const TICK_MS = 60_000;
/** How often the scheduler deletes old ledger rows of every user. */
export const LEDGER_CLEANUP_EVERY_MS = 6 * 3_600_000;
/** How often the scheduler purges the public demo's expired workspaces (demo mode only). */
export const PURGE_EVERY_MS = 5 * 60_000;

const DAY = 86_400_000;

const SIGNALS = ["SIGTERM", "SIGINT"] as const;
type StopSignal = (typeof SIGNALS)[number];

export type StartResult = "started" | "maintenance_only" | "build" | "running";

/** What a tick calls; defaults below, replaced in tests. */
export interface SchedulerDeps {
  /** The user of the oldest due connection, leaving out `skip`; null when none is due. */
  nextDue(now: Date, skip: readonly string[]): Promise<string | null>;
  /**
   * One sync of the user's inbox (runInboxCheck); `signal` is the scheduler's stop. `busy`: another
   * process holds the connection's lease, nothing was done or recorded.
   */
  sync(userId: string, signal: AbortSignal): Promise<{ complete: boolean; busy?: boolean }>;
  /** The users the periodic sweep may run for (the gate). */
  sweepable(now: Date): Promise<string[]>;
  /** The no-response sweep for one user: how many jobs it marked. */
  sweep(userId: string, now: Date): Promise<number>;
  /** Deletes every user's ledger rows older than LEDGER_DAYS before `now`: how many. */
  cleanLedger(now: Date): Promise<number>;
  /** The public demo: deletes the workspaces expired at `now` (and logs it): how many. */
  purgeWorkspaces(now: Date): Promise<number>;
  stopAllSyncs(): void;
  now(): Date;
  log(line: string, level?: "info" | "warn"): void;
}

/** Where SIGTERM and SIGINT come from: `process`, or a stand-in in tests. */
export interface SignalHost {
  readonly pid: number;
  on(signal: StopSignal, listener: (signal: StopSignal) => void): unknown;
  removeListener(signal: StopSignal, listener: (signal: StopSignal) => void): unknown;
  listenerCount(signal: StopSignal): number;
  kill(pid: number, signal: StopSignal): unknown;
}

export interface StartOptions {
  deps?: Partial<SchedulerDeps>;
  signals?: SignalHost;
  /** The environment (tests). Default: getEnv(). */
  env?: Env;
}

interface Scheduler {
  deps: SchedulerDeps;
  /** The timed syncs run (steps 1 and 2); false: maintenance only. */
  syncs: boolean;
  /**
   * The public demo (DEMO_MODE=on): the purge runs (step 5), and a sweep the status-event cap
   * refuses counts as done (step 3).
   */
  demo: boolean;
  signals: SignalHost;
  onSignal: (signal: StopSignal) => void;
  timer: ReturnType<typeof setInterval> | null;
  /** Aborted by the stop: the signal of the runs this scheduler starts. */
  controller: AbortController;
  stopped: boolean;
  tick: Promise<void> | null;
  /** Last sweep per user (ms since the epoch), for SWEEP_EVERY_MS. */
  lastSweep: Map<string, number>;
  /** Last ledger clean-up (ms since the epoch), for LEDGER_CLEANUP_EVERY_MS; null: none yet. */
  lastLedgerCleanup: number | null;
  /** Last purge of expired demo workspaces (ms since the epoch), for PURGE_EVERY_MS; null: none yet. */
  lastPurge: number | null;
}

// On globalThis: the flag that says a scheduler runs, seen by every copy of this module (Next
// bundles instrumentation separately; development reloads modules).
const g = globalThis as unknown as { __jobTrackerInboxScheduler?: Scheduler };

function defaultDeps(env: Env): SchedulerDeps {
  const demoOnly = env.mailSource === "fixture";
  return {
    nextDue: (now, skip) => nextDueUserId(getDb(), now, skip, { demoOnly }),
    sync: (userId, signal) => runInboxCheck(userId, { signal }),
    sweepable: (now) => sweepableUserIds(getDb(), now),
    sweep: async (userId, now) => (await sweepNoResponse(userId, { now })).length,
    cleanLedger: (now) => deleteAllSeenBefore(getDb(), new Date(now.getTime() - LEDGER_DAYS * DAY)),
    purgeWorkspaces: (now) => purgeExpiredWorkspaces(getDb(), now),
    stopAllSyncs,
    now: () => new Date(),
    log: (line, level = "info") => (level === "warn" ? console.warn(line) : console.info(line)),
  };
}

/** See the contract at the top of this file. */
export function startInboxScheduler(opts: StartOptions = {}): StartResult {
  // register() returns before this during the build; checked again, since nothing else may run then.
  if (process.env.NEXT_PHASE === "phase-production-build") return "build";
  if (g.__jobTrackerInboxScheduler) return "running";
  const env = opts.env ?? getEnv();
  const deps: SchedulerDeps = { ...defaultDeps(env), ...opts.deps };
  // Why the timed syncs are off, or null when they run. checkEnv() has named the variable; the
  // start line says what it means for the inbox. The demo first: its INBOX_SCHEDULER is unset
  // (off by default there), and the reason is the demo, not the variable.
  const syncsOff = env.demoMode
    ? "demo mode: visitors sync by hand"
    : !env.inboxSchedulerEnabled
      ? "INBOX_SCHEDULER is off"
      : env.mailSource !== "fixture" && !inboxTokenKeys(env)
        ? "Gmail is not set up"
        : null;

  const signals = opts.signals ?? process;
  const s: Scheduler = {
    deps,
    syncs: syncsOff === null,
    demo: env.demoMode,
    signals,
    onSignal: (signal) => onStopSignal(s, signal),
    timer: null,
    controller: new AbortController(),
    stopped: false,
    tick: null,
    lastSweep: new Map(),
    lastLedgerCleanup: null,
    lastPurge: null,
  };
  g.__jobTrackerInboxScheduler = s;
  s.timer = setInterval(() => void startTick(s), TICK_MS);
  // The timer alone must not keep the process alive (a stop, tests, scripts).
  s.timer.unref();
  for (const signal of SIGNALS) signals.on(signal, s.onSignal);
  const every = `inbox: scheduler started, every ${TICK_MS / 1000} s`;
  if (s.demo) {
    deps.log(
      `${every}: no timed syncs (${syncsOff}), only the no-response sweep, the ledger clean-up and the purge of expired demo workspaces (every ${PURGE_EVERY_MS / 60_000} min)`,
    );
    return "maintenance_only";
  }
  if (syncsOff) {
    deps.log(`${every}: no timed syncs (${syncsOff}), only the no-response sweep and the ledger clean-up`);
    return "maintenance_only";
  }
  deps.log(`${every}: timed syncs, the no-response sweep and the ledger clean-up`);
  return "started";
}

/** See the contract at the top of this file. */
export function stopInboxScheduler(reason = "stop"): void {
  const s = g.__jobTrackerInboxScheduler;
  if (s) stop(s, reason);
}

export function isSchedulerRunning(): boolean {
  const s = g.__jobTrackerInboxScheduler;
  return !!s && !s.stopped;
}

/** A tick now, or the one running; resolves at once when no scheduler runs. */
export function runSchedulerTick(): Promise<void> {
  const s = g.__jobTrackerInboxScheduler;
  return (s && startTick(s)) ?? Promise.resolve();
}

/** Stops and forgets the scheduler and removes its signal listeners (tests). */
export function resetSchedulerForTests(): void {
  const s = g.__jobTrackerInboxScheduler;
  if (!s) return;
  if (!s.stopped) {
    s.stopped = true;
    if (s.timer) clearInterval(s.timer);
    s.controller.abort();
  }
  removeSignalListeners(s);
  delete g.__jobTrackerInboxScheduler;
}

/** See the contract at the top of this file. `demoOnly`: MAIL_SOURCE=fixture. */
export async function nextDueUserId(
  db: Db,
  now: Date,
  skip: readonly string[] = [],
  opts: { demoOnly?: boolean } = {},
): Promise<string | null> {
  // The index on (status, next_sync_at) answers this; NULL next_sync_at is never due.
  const [row] = await db<Array<{ user_id: string }>>`
    SELECT user_id FROM inbox_connections
    WHERE status = 'connected' AND next_sync_at <= ${now}
      AND NOT (user_id = ANY(${[...skip]}::uuid[]))
      AND (demo OR NOT ${opts.demoOnly ?? false}::boolean)
    ORDER BY next_sync_at, user_id
    LIMIT 1`;
  return row?.user_id ?? null;
}

/* ------------------------------------------------------------------ stop */

function stop(s: Scheduler, reason: string): void {
  if (s.stopped) return;
  s.stopped = true;
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  s.controller.abort();
  try {
    s.deps.stopAllSyncs();
  } catch (err) {
    s.deps.log(`inbox: stopping the syncs failed (${errorCode(err)})`, "warn");
  }
  s.deps.log(`inbox: scheduler stopped (${reason})${s.tick ? ", during a tick" : ""}`);
}

function onStopSignal(s: Scheduler, signal: StopSignal): void {
  stop(s, signal);
  // Next.js has its own listener, which closes the server and exits. When this one is alone,
  // staying subscribed would swallow the signal: unsubscribe and raise it again, so its default
  // action ends the process.
  if (s.signals.listenerCount(signal) <= 1) {
    removeSignalListeners(s);
    s.signals.kill(s.signals.pid, signal);
  }
}

function removeSignalListeners(s: Scheduler): void {
  for (const signal of SIGNALS) s.signals.removeListener(signal, s.onSignal);
}

/* ------------------------------------------------------------------ tick */

/** Starts a tick unless one runs (then that one) or the scheduler stopped (then nothing). */
function startTick(s: Scheduler): Promise<void> | null {
  if (s.tick) return s.tick;
  if (s.stopped) return null;
  // tick() catches its own errors; the catch only keeps a failing log call from becoming an
  // unhandled rejection.
  s.tick = tick(s)
    .catch(() => {})
    .finally(() => {
      s.tick = null;
    });
  return s.tick;
}

interface TickCounts {
  complete: number;
  incomplete: number;
  /** Runs that found the lease held elsewhere (retried on the next tick: nothing was recorded). */
  busy: number;
  /** Error codes of the runs that failed. */
  failed: string[];
  marked: number;
  /** Error codes of the sweeps that failed. */
  sweepFailed: string[];
  /** The tick itself failed (the due query, the gate query). */
  error: string | null;
  /** Ledger rows the clean-up deleted. */
  ledgerDeleted: number;
  /** The ledger clean-up failed (tried again on the next tick). */
  cleanupFailed: string | null;
  /** The demo's purge failed (tried again on the next tick). */
  purgeFailed: string | null;
}

async function tick(s: Scheduler): Promise<void> {
  const { deps } = s;
  const counts: TickCounts = {
    complete: 0,
    incomplete: 0,
    busy: 0,
    failed: [],
    marked: 0,
    sweepFailed: [],
    error: null,
    ledgerDeleted: 0,
    cleanupFailed: null,
    purgeFailed: null,
  };
  try {
    const tried: string[] = [];
    while (s.syncs && !s.stopped) {
      const userId = await deps.nextDue(deps.now(), tried);
      if (!userId) break;
      tried.push(userId);
      let result: { complete: boolean; busy?: boolean };
      try {
        result = await deps.sync(userId, s.controller.signal);
      } catch (err) {
        counts.failed.push(errorCode(err));
        continue;
      }
      if (result.busy) counts.busy++;
      else if (result.complete) counts.complete++;
      else counts.incomplete++;
      if (result.complete && !result.busy && !s.stopped) await sweep(s, userId, counts);
    }

    if (!s.stopped) {
      const now = deps.now().getTime();
      const users = await deps.sweepable(new Date(now));
      // Only the users let through now keep their time (step 3 at the top of this file).
      const current = new Set(users);
      for (const userId of s.lastSweep.keys()) if (!current.has(userId)) s.lastSweep.delete(userId);
      for (const userId of users) {
        if (s.stopped) break;
        const last = s.lastSweep.get(userId);
        if (last !== undefined && now - last < SWEEP_EVERY_MS) continue;
        await sweep(s, userId, counts);
      }
    }
  } catch (err) {
    counts.error = errorCode(err);
  }
  // Apart from the steps above: a failing due or gate query must not hold the clean-ups up.
  if (!s.stopped) await cleanLedger(s, counts);
  if (s.demo && !s.stopped) await purgeWorkspaces(s, counts);
  const line = summary(counts);
  const warn =
    counts.failed.length || counts.sweepFailed.length || counts.error || counts.cleanupFailed || counts.purgeFailed;
  if (line) deps.log(line, warn ? "warn" : "info");
}

/** Step 4 of a tick, when LEDGER_CLEANUP_EVERY_MS have passed since the last one. */
async function cleanLedger(s: Scheduler, counts: TickCounts): Promise<void> {
  const now = s.deps.now();
  if (s.lastLedgerCleanup !== null && now.getTime() - s.lastLedgerCleanup < LEDGER_CLEANUP_EVERY_MS) return;
  try {
    counts.ledgerDeleted += await s.deps.cleanLedger(now);
    s.lastLedgerCleanup = now.getTime();
  } catch (err) {
    counts.cleanupFailed = errorCode(err);
  }
}

/** Step 5 of a tick (demo mode), when PURGE_EVERY_MS have passed since the last one. */
async function purgeWorkspaces(s: Scheduler, counts: TickCounts): Promise<void> {
  const now = s.deps.now();
  if (s.lastPurge !== null && now.getTime() - s.lastPurge < PURGE_EVERY_MS) return;
  try {
    // purgeExpiredWorkspaces logs how many it deleted; the tick's line adds only a failure.
    await s.deps.purgeWorkspaces(now);
    s.lastPurge = now.getTime();
  } catch (err) {
    counts.purgeFailed = errorCode(err);
  }
}

async function sweep(s: Scheduler, userId: string, counts: TickCounts): Promise<void> {
  const now = s.deps.now();
  try {
    counts.marked += await s.deps.sweep(userId, now);
    s.lastSweep.set(userId, now.getTime());
  } catch (err) {
    // The demo's status-event cap (step 3 at the top of this file), the only ConflictError a sweep
    // can throw today. Still only in the demo, so that in the real app every failure is logged.
    if (s.demo && isErrorNamed(err, "ConflictError")) s.lastSweep.set(userId, now.getTime());
    else counts.sweepFailed.push(errorCode(err));
  }
}

/** The tick's log line, or null when there was nothing to say. Counts and codes only. */
function summary(c: TickCounts): string | null {
  const parts: string[] = [];
  const synced = c.complete + c.incomplete;
  if (synced) parts.push(`synced ${synced}${c.incomplete ? ` (${c.incomplete} not complete)` : ""}`);
  if (c.busy) parts.push(`busy ${c.busy} (lease held elsewhere)`);
  if (c.failed.length) parts.push(`failed ${c.failed.length} (${codes(c.failed)})`);
  if (c.marked) parts.push(`marked ${c.marked} no response`);
  if (c.sweepFailed.length) parts.push(`sweep failed ${c.sweepFailed.length} (${codes(c.sweepFailed)})`);
  if (c.ledgerDeleted) parts.push(`deleted ${c.ledgerDeleted} old ledger rows`);
  if (c.cleanupFailed) parts.push(`ledger clean-up failed (${c.cleanupFailed})`);
  if (c.purgeFailed) parts.push(`demo workspace purge failed (${c.purgeFailed})`);
  if (c.error) parts.push(`tick failed (${c.error})`);
  return parts.length ? `inbox: scheduler: ${parts.join(", ")}` : null;
}

/** "a, b x2": each code once, in first order, with its count when above one. */
function codes(list: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const code of list) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts].map(([code, n]) => (n > 1 ? `${code} x${n}` : code)).join(", ");
}
