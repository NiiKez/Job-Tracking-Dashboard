import "server-only";
import { getDb, type Db } from "@/lib/server/db/client";
import { getEnv } from "@/lib/server/env";
import { ConflictError } from "@/lib/server/errors";
import type { Email } from "@/lib/types";
import { markNeedsReconnect } from "../connection";
import type { ParsedMessage } from "../parse/gmail-message";
import {
  DEMO_ON_GMAIL_MESSAGE,
  deleteSeenBefore,
  finishBackfill,
  finishedMessageIds,
  getSyncState,
  LEDGER_DAYS,
  recordSyncFailure,
  recordSyncSuccess,
  setBackfillProgress,
  setHistoryId,
  startFullScan,
  type SyncStateRow,
} from "../repo";
import { createMailSource } from "../source";
import type { MailSource } from "../source/types";
import { inboxError, isMailSourceError } from "./errors";
import {
  errorCode,
  fetchMessage,
  ingestParsed,
  isGmailId,
  recordFailure,
  skipGone,
  type IngestContext,
  type IngestOutcome,
} from "./ingest";
import { holdLease, type HeldLease } from "./lease";
import type { PacerOptions } from "./pace";

/**
 * The sync engine (docs/plan/2-gmail-ingest.md, "Sync"): one run over a MailSource for one user.
 *
 *   runInboxCheck(userId, opts?)  starts a run, or joins the one running for this user in this
 *                                 process (one shared promise per user). Resolves with what the
 *                                 run did (`busy` when another process holds the lease: nothing
 *                                 was done, nothing recorded); rejects with ConflictError when
 *                                 the inbox is not connected (or, with MAIL_SOURCE=fixture, is a
 *                                 Gmail connection), or with the error that ended the run (a
 *                                 MailSourceError for anything from the mail source).
 *   isSyncing(userId)             a run of this user is in progress in this process
 *   abortSync(userId)             stops that run between messages (Disconnect); it rejects with
 *                                 MailSourceError("temporary", "stopped")
 *   stopAllSyncs()                shutdown (the scheduler, on SIGTERM): a process-wide stop flag,
 *                                 and every running run (and dry run) aborted: it ends between
 *                                 messages, and the pacer's waits and Gmail requests end at once.
 *                                 Later runs reject with "stopped". Nothing is recorded as a
 *                                 failure; the leases are released.
 *   runProgress(userId)           the running run's messages looked at so far, or null
 *   runSync(userId, opts?)        one run without the registry (tests); the lease still applies
 *   settleWithin(promise, ms)     waits at most `ms` for a promise (the check route's 20 seconds)
 *
 * A run:
 *   - Takes the lease on the connection row (sync/lease.ts): renewed every 30 seconds, released
 *     in `finally`, expired 3 minutes after a crash. Held elsewhere: the run does nothing and
 *     resolves `busy`. Lost while running (taken over after this process stalled): the run stops.
 *     The connection is read again once the lease is held, so a run that just ended elsewhere
 *     is continued from where it left the position.
 *   - With MAIL_SOURCE=fixture, a connection that is not the demo one (`demo` false: a Gmail
 *     mailbox, connected now or before) is refused once the lease is held, with
 *     ConflictError(DEMO_ON_GMAIL_MESSAGE), before the source is created and with nothing
 *     recorded: the demo mail never reaches its position, ledger or jobs, whoever started the
 *     run (Check inbox and the scheduler already keep away from it; this is the last check).
 *   - No sync position yet (or no scan window): the first scan. getProfile, then the position
 *     (its history id) and the window (now − INBOX_BACKFILL_DAYS) are stored BEFORE listing, so
 *     mail arriving meanwhile is picked up by the incremental sync afterwards. A scan that did not
 *     finish (a stop, a failure, a message to retry) is resumed by the next run with the same
 *     window, cut to INBOX_BACKFILL_DAYS before now (a scan resumed after a Reconnect days later
 *     reaches back no further than a new one; nextListing): list again, drop what the ledger
 *     finished, process the rest. backfill_total and backfill_done stay current; the scan is done
 *     when every listed message was ingested or skipped for good.
 *   - Otherwise: listAddedSince(position). The position moves to the returned history id only
 *     when every message of the run was ingested or skipped for good ("failed" counts: given up).
 *   - Expired position (history_expired, Gmail's 404): the first-scan procedure again, with the
 *     window starting a day before the last successful sync, at most INBOX_BACKFILL_DAYS back
 *     (rescanAfter). The new position is stored first; the ledger skips what was done before.
 *   - Messages are fetched in batches (FETCH_BATCH, FETCH_CONCURRENCY at a time) and ingested
 *     oldest first within a batch; the first scan's list is reversed, since Gmail answers newest
 *     first in practice. Correctness does not depend on the order: the pipeline's stale-mail rule
 *     handles mail older than a job's latest email-driven change.
 *   - Per message (sync/ingest.ts): one transaction; a failure rolls it back and is recorded as
 *     an attempt ("retry", "failed" at the third run), and the run goes on. A failed fetch:
 *       - certainly about the message (MESSAGE_FAULTS: too large to read): an attempt;
 *       - an error that may be the message's own or may be anyone's (MAYBE_MESSAGE_FAULTS: a 5xx,
 *         a timeout, an answer that cannot be read, ... still failing after the pacer's retries;
 *         or not a MailSourceError at all: a parser bug, or the database while the access token
 *         was refreshed inside the request): one getProfile (1 quota unit) asks whether Google
 *         answers at all. It does: an attempt, so one message Gmail cannot serve is given up after
 *         three runs instead of holding the position forever. It does not: as below, ending with
 *         the probe's error when that one is not temporary or asks for a longer wait
 *         (Retry-After), else with the message's;
 *       - anything else (a rate limit, Google down, the token or its refresh failing, a stop):
 *         the run ends once the rest of the batch is ingested, without blaming the message.
 *     So an outage, or Google's token endpoint failing, never marks mail failed.
 *   - The stop signal (abortSync, stopAllSyncs, opts.signal, a lost lease) is checked between
 *     messages; the Gmail source's waits and requests end with it too.
 *   - The outcome is recorded on the connection: last_sync_ok_at and the failure count reset, or
 *     last_error_code, the failure count + 1 and next_sync_at backed off (never before Google's
 *     Retry-After). A "stopped" run records nothing. A needs_reconnect error also marks the
 *     connection needs_reconnect (connection.ts), so the scheduler skips it, but only while the
 *     stored token is the one the run started with (compare-and-set): when the owner reconnected
 *     meanwhile, the old grant's failure says nothing about the new one, and nothing is recorded.
 *     Ledger rows older than LEDGER_DAYS ("retry" rows a run looked at in that time excepted)
 *     are deleted after a successful run; the scheduler also deletes them every 6 hours for
 *     every user (sync/scheduler.ts).
 *
 * For sync/dry-run.ts (same listing, same stop and lease rules, nothing written):
 *   stoppableRun(signal), connectedState(state), nextListing(state, now), rescanAfter(lastSyncOkAt,
 *   now), uniqueIds, mapLimit, FETCH_BATCH, FETCH_CONCURRENCY.
 *
 * Logs carry message ids, counts and codes only.
 */

/** Messages fetched before they are ingested, oldest first. */
export const FETCH_BATCH = 25;
/** Fetches at a time (the Gmail source's pacer allows three). */
export const FETCH_CONCURRENCY = 3;
/** How long "Check inbox" waits for a run before it answers "running". */
export const CHECK_WAIT_MS = 20_000;
/** Source errors that are certainly about the one message fetched, not about Google or the token. */
const MESSAGE_FAULTS: ReadonlySet<string> = new Set(["response_too_large"]);
/**
 * Temporary source errors that can be about the one message fetched (Gmail failing on that
 * message only) or about Google as a whole: a probe decides (see the contract above). Errors that
 * are not MailSourceErrors are probed too. Never token_refresh_failed: the token endpoint is not
 * the message (oauth/google-tokens.ts).
 */
const MAYBE_MESSAGE_FAULTS: ReadonlySet<string> = new Set([
  "google_unavailable",
  "timeout",
  "network",
  "bad_request",
  "gmail_forbidden",
  "not_found",
  "bad_response",
]);

const DAY = 86_400_000;
/** History ids are decimal numbers (uint64); anything else from the source is a bad answer. */
const HISTORY_ID = /^\d{1,30}$/;

export const NOT_CONNECTED_MESSAGE = "Connect Gmail in Settings first.";
export const NEEDS_RECONNECT_MESSAGE = "Gmail needs to be reconnected. Reconnect it in Settings.";

export interface RunOptions {
  /** The mail source (tests). Default: createMailSource for the connection. */
  source?: MailSource;
  /** The clock (tests). Default: the system clock. */
  now?: () => Date;
  /** Stops the run between messages, like abortSync. */
  signal?: AbortSignal;
  /** Test seam: the Gmail pacer's options (its clock and waits), for the default source. */
  pace?: PacerOptions;
}

export interface SyncResult {
  finishedAt: Date;
  mode: "full_scan" | "incremental";
  /**
   * Another process holds the connection's lease: this run did nothing and recorded nothing
   * (the other run records its own outcome). Everything else is zero, `complete` false.
   */
  busy: boolean;
  /** Messages looked at in this run (job related or not). */
  scanned: number;
  /** Job-related mail stored in this run, as linked. */
  stored: Email[];
  ignored: number;
  skipped: number;
  /** Failed in this run and left to retry. */
  retry: number;
  /** Failed for the third time in this run: given up. */
  failed: number;
  /** Every message was ingested or skipped for good: the position (or the scan) moved on. */
  complete: boolean;
}

/* ------------------------------------------------------------- registry */

interface Run {
  promise: Promise<SyncResult>;
  controller: AbortController;
  tally: Tally;
}

// On globalThis, so a hot reload in development still sees a run started before it.
const g = globalThis as unknown as {
  __jobTrackerInboxRuns?: Map<string, Run>;
  __jobTrackerInboxStop?: { stopped: boolean; controllers: Set<AbortController> };
};

function runs(): Map<string, Run> {
  g.__jobTrackerInboxRuns ??= new Map();
  return g.__jobTrackerInboxRuns;
}

/** The process-wide stop flag, and the controller of every run and dry run in progress. */
function stopState() {
  g.__jobTrackerInboxStop ??= { stopped: false, controllers: new Set() };
  return g.__jobTrackerInboxStop;
}

/** See the contract at the top of this file. */
export function runInboxCheck(userId: string, opts: RunOptions = {}): Promise<SyncResult> {
  const running = runs().get(userId);
  if (running) return running.promise;
  if (stopState().stopped) return Promise.reject(inboxError("stopped"));

  const controller = new AbortController();
  const outer = opts.signal;
  const forward = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", forward, { once: true });

  const tally = newTally();
  const promise = execute(userId, { ...opts, signal: controller.signal }, tally).finally(() => {
    outer?.removeEventListener("abort", forward);
    if (runs().get(userId)?.promise === promise) runs().delete(userId);
  });
  // The outcome is recorded on the connection; a caller that stopped waiting (the route after
  // 20 seconds) must not leave an unhandled rejection behind. Awaiting callers still see it.
  promise.catch(() => {});
  runs().set(userId, { promise, controller, tally });
  return promise;
}

export function isSyncing(userId: string): boolean {
  return runs().has(userId);
}

export function abortSync(userId: string): void {
  runs().get(userId)?.controller.abort();
}

/** See the contract at the top of this file. */
export function stopAllSyncs(): void {
  const stop = stopState();
  stop.stopped = true;
  for (const controller of stop.controllers) controller.abort();
  for (const run of runs().values()) run.controller.abort();
}

/** stopAllSyncs was called in this process. */
export function syncsStopped(): boolean {
  return stopState().stopped;
}

/** Test seam: undoes stopAllSyncs (the runs it aborted stay aborted). */
export function resetSyncStopForTests(): void {
  stopState().stopped = false;
}

/**
 * The controller of one run or dry run: aborted by `outer`, by stopAllSyncs, or by the caller
 * (a lost lease). Throws MailSourceError "stopped" once stopAllSyncs was called. Call end() when
 * the run is over.
 */
export function stoppableRun(outer: AbortSignal | undefined): { controller: AbortController; end: () => void } {
  const stop = stopState();
  if (stop.stopped) throw inboxError("stopped");
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", forward, { once: true });
  stop.controllers.add(controller);
  return {
    controller,
    end: () => {
      outer?.removeEventListener("abort", forward);
      stop.controllers.delete(controller);
    },
  };
}

/** The running run's progress, or null when none runs. */
export function runProgress(userId: string): { scanned: number } | null {
  const run = runs().get(userId);
  return run ? { scanned: run.tally.scanned } : null;
}

/** Waits at most `ms`: the value when the promise settled in time; rejects when it rejected. */
export async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ done: true as const, value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------- listing */

/** What the next run lists: the mail added since the position, or a scan window (new or resumed). */
export type Listing =
  | { mode: "incremental"; position: string }
  | { mode: "full_scan"; after: Date; resume: boolean };

/** See the contract at the top of this file. */
export function nextListing(state: SyncStateRow, now: Date): Listing {
  if (state.backfill_state === "done" && state.history_id) return { mode: "incremental", position: state.history_id };
  if (state.backfill_state === "running" && state.history_id && state.backfill_after) {
    // Never further back than a new scan: a scan resumed after a Reconnect days later stays
    // within INBOX_BACKFILL_DAYS. The position is kept (mail added since it is still picked up).
    const floor = backfillStart(now);
    const after = state.backfill_after.getTime() < floor.getTime() ? floor : state.backfill_after;
    return { mode: "full_scan", after, resume: true };
  }
  return { mode: "full_scan", after: backfillStart(now), resume: false };
}

/** INBOX_BACKFILL_DAYS before `now`: how far any scan reaches back. */
function backfillStart(now: Date): Date {
  return new Date(now.getTime() - getEnv().inboxBackfillDays * DAY);
}

/**
 * The window of a re-scan after an expired position: from a day before the last successful sync,
 * at most INBOX_BACKFILL_DAYS back (and at least a day back).
 */
export function rescanAfter(lastSyncOkAt: Date | null, now: Date): Date {
  const floor = backfillStart(now).getTime();
  const last = lastSyncOkAt?.getTime();
  if (last === undefined || Number.isNaN(last)) return new Date(floor);
  return new Date(Math.min(Math.max(last - DAY, floor), now.getTime() - DAY));
}

/* ------------------------------------------------------------------ run */

/** See the contract at the top of this file. */
export function runSync(userId: string, opts: RunOptions = {}): Promise<SyncResult> {
  return execute(userId, opts, newTally());
}

interface Tally {
  scanned: number;
  stored: Email[];
  ignored: number;
  skipped: number;
  retry: number;
  failed: number;
}

function newTally(): Tally {
  return { scanned: 0, stored: [], ignored: 0, skipped: 0, retry: 0, failed: 0 };
}

function count(tally: Tally, outcome: IngestOutcome): void {
  tally.scanned++;
  if (outcome.kind === "stored") tally.stored.push(outcome.email);
  else if (outcome.kind === "ignored") tally.ignored++;
  else if (outcome.kind === "skipped") tally.skipped++;
  else if (outcome.kind === "failed_attempt") tally[outcome.result]++;
}

/** What one run needs besides the database. */
interface RunContext {
  userId: string;
  source: MailSource;
  now: () => Date;
  signal: AbortSignal;
  ownAddress: string;
  tally: Tally;
  /** Becomes "full_scan" when an expired position starts a re-scan. */
  mode: SyncResult["mode"];
}

async function execute(userId: string, opts: RunOptions, tally: Tally): Promise<SyncResult> {
  if (stopState().stopped) throw inboxError("stopped");
  const db = getDb();
  const now = opts.now ?? (() => new Date());
  const before = connectedState(await getSyncState(db, userId));

  const { controller, end } = stoppableRun(opts.signal);
  let lease: HeldLease | null = null;
  try {
    lease = await holdLease(db, userId, { onLost: () => controller.abort() });
    if (!lease) {
      const mode = nextListing(before, now()).mode;
      console.info(`inbox: sync ${mode} not started: another run holds the lease`);
      return { finishedAt: new Date(), mode, busy: true, ...newTally(), complete: false };
    }
    // Read again under the lease: a run that just ended elsewhere may have moved the position.
    const state = connectedState(await getSyncState(db, userId));
    return await syncHoldingLease(db, userId, state, { ...opts, now, signal: controller.signal }, tally);
  } finally {
    end();
    await lease?.release();
  }
}

/** The connected connection's state, or ConflictError (not connected, or needing a reconnect). */
export function connectedState(state: SyncStateRow | null): SyncStateRow {
  if (!state || state.status !== "connected") {
    throw new ConflictError(state?.status === "needs_reconnect" ? NEEDS_RECONNECT_MESSAGE : NOT_CONNECTED_MESSAGE);
  }
  return state;
}

/** The run itself, with the lease held; its outcome is recorded on the connection. */
async function syncHoldingLease(
  db: Db,
  userId: string,
  state: SyncStateRow,
  opts: RunOptions & { now: () => Date; signal: AbortSignal },
  tally: Tally,
): Promise<SyncResult> {
  const { now, signal } = opts;
  // Outside the try: a refusal is not a failure of the mailbox, and is recorded nowhere.
  if (getEnv().mailSource === "fixture" && !state.demo) throw new ConflictError(DEMO_ON_GMAIL_MESSAGE);
  const listing = nextListing(state, now());
  let mode: SyncResult["mode"] = listing.mode;
  try {
    checkStop(signal);
    const run: RunContext = {
      userId,
      source: opts.source ?? createMailSource({ userId, emailAddress: state.email_address }, { signal, now, pace: opts.pace }),
      now,
      signal,
      ownAddress: state.email_address,
      tally,
      mode,
    };
    let complete: boolean;
    try {
      complete = listing.mode === "incremental" ? await incremental(db, run, state, listing.position) : await fullScan(db, run, listing);
    } finally {
      mode = run.mode;
    }
    await recordSyncSuccess(db, userId);
    await deleteSeenBefore(db, userId, new Date(now().getTime() - LEDGER_DAYS * DAY));
    console.info(
      `inbox: sync ${mode} done: scanned ${tally.scanned}, stored ${tally.stored.length}, ignored ${tally.ignored}, ` +
        `skipped ${tally.skipped}, retry ${tally.retry}, failed ${tally.failed}${complete ? "" : ", position kept"}`,
    );
    return { finishedAt: new Date(), mode, busy: false, ...tally, stored: [...tally.stored], complete };
  } catch (err) {
    await noteRunFailure(db, userId, state, mode, tally, err);
    throw err;
  }
}

/** Records why a run ended on the connection; never hides the run's own error. */
async function noteRunFailure(
  db: Db,
  userId: string,
  state: SyncStateRow,
  mode: SyncResult["mode"],
  tally: Tally,
  err: unknown,
) {
  const code = isMailSourceError(err) ? err.code : "internal";
  console.warn(`inbox: sync ${mode} ended (${errorCode(err)}) after ${tally.scanned} messages`);
  // A stop (abortSync, shutdown, Disconnect, a lost lease) is not a failure of the mailbox.
  if (code === "stopped") return;
  try {
    if (isMailSourceError(err, "needs_reconnect")) {
      // Only the token this run started with: a Reconnect meanwhile stored a new one (or a
      // Disconnect removed it), and the old grant's failure is not the new connection's. Nothing
      // is recorded then; the next run tries the stored token (also after a key rotation
      // re-encrypted it during this run: that run marks it, if it is still refused).
      const marked = await markNeedsReconnect(db, userId, code, { token: state.refresh_token_enc });
      if (!marked) {
        console.info("inbox: the connection changed during the run, its token error is not recorded");
        return;
      }
    }
    await recordSyncFailure(db, userId, code, { retryAfterMs: isMailSourceError(err) ? err.retryAfterMs : null });
  } catch (recordErr) {
    console.warn(`inbox: recording the failure failed (${errorCode(recordErr)})`);
  }
}

/** The first scan, or the rest of one. True when it finished. */
async function fullScan(db: Db, run: RunContext, listing: Extract<Listing, { mode: "full_scan" }>): Promise<boolean> {
  if (!listing.resume) await beginScan(db, run, listing.after);
  return scanWindow(db, run, listing.after);
}

/** Stores the position (getProfile's history id) and the window before anything is listed. */
async function beginScan(db: Db, run: RunContext, after: Date): Promise<void> {
  const profile = await run.source.getProfile();
  const historyId = historyIdOf(profile.historyId);
  await startFullScan(db, run.userId, { historyId, after });
  run.mode = "full_scan";
}

/** Lists the window, drops what the ledger finished, processes the rest. True when the scan is done. */
async function scanWindow(db: Db, run: RunContext, after: Date): Promise<boolean> {
  checkStop(run.signal);
  // Gmail answers newest first in practice (not documented): oldest first is the better bet.
  const listed = uniqueIds(await run.source.listMessageIds(after)).reverse();
  const finished = await finishedMessageIds(db, run.userId, listed);
  const todo = listed.filter((id) => !finished.has(id));
  let done = listed.length - todo.length;
  await setBackfillProgress(db, run.userId, { total: listed.length, done });

  const pending = await processIds(run, todo, () => setBackfillProgress(db, run.userId, { done: ++done }));
  if (pending > 0) return false;
  await finishBackfill(db, run.userId);
  return true;
}

/** Mail added since the position (or a re-scan when it expired). True when the position moved on. */
async function incremental(db: Db, run: RunContext, state: SyncStateRow, position: string): Promise<boolean> {
  let added: { messageIds: string[]; historyId: string };
  try {
    added = await run.source.listAddedSince(position);
  } catch (err) {
    if (!isMailSourceError(err, "history_expired")) throw err;
    const after = rescanAfter(state.last_sync_ok_at, run.now());
    const days = Math.round((run.now().getTime() - after.getTime()) / DAY);
    console.info(`inbox: sync position expired, scanning the last ${days} days again`);
    await beginScan(db, run, after);
    return scanWindow(db, run, after);
  }
  const historyId = historyIdOf(added.historyId);
  const listed = uniqueIds(added.messageIds);
  const finished = await finishedMessageIds(db, run.userId, listed);
  const pending = await processIds(
    run,
    listed.filter((id) => !finished.has(id)),
    async () => {},
  );
  if (pending > 0) return false;
  if (historyId !== position) await setHistoryId(db, run.userId, historyId);
  return true;
}

type Fetched = { id: string; parsed: ParsedMessage | null } | { id: string; error: unknown };

/**
 * Fetches and ingests the messages, a batch at a time. Returns how many are left to retry.
 * `onEach` runs after every message looked at.
 */
async function processIds(run: RunContext, ids: readonly string[], onEach: () => Promise<void>): Promise<number> {
  const ctx = (): IngestContext => ({ ownAddress: run.ownAddress, now: run.now() });
  let pending = 0;
  for (let i = 0; i < ids.length; i += FETCH_BATCH) {
    checkStop(run.signal);
    const batch = await mapLimit(ids.slice(i, i + FETCH_BATCH), FETCH_CONCURRENCY, async (id): Promise<Fetched> => {
      checkStop(run.signal);
      try {
        return { id, parsed: await fetchMessage(run.source, id) };
      } catch (error) {
        return { id, error };
      }
    });
    batch.sort((a, b) => receivedMs(a) - receivedMs(b));

    let ending: unknown = null;
    for (const item of batch) {
      let outcome: IngestOutcome;
      if ("error" in item) {
        const { error } = item;
        if (!isMailSourceError(error) || !MESSAGE_FAULTS.has(error.code)) {
          // Once the run is ending, no more probes: the rest of the batch is only ingested.
          const maybe = !isMailSourceError(error) || MAYBE_MESSAGE_FAULTS.has(error.code);
          const probe = !ending && maybe ? await probeGoogle(run) : error;
          if (probe !== null) {
            ending ??= endingError(error, probe);
            continue;
          }
        }
        outcome = await recordFailure(run.userId, item.id, null, error);
      } else {
        checkStop(run.signal);
        outcome = item.parsed ? await ingestParsed(run.userId, item.id, item.parsed, ctx()) : await skipGone(run.userId, item.id);
      }
      count(run.tally, outcome);
      if (outcome.kind === "failed_attempt" && outcome.result === "retry") pending++;
      await onEach();
    }
    if (ending) throw ending;
  }
  return pending;
}

/**
 * One cheap request (getProfile, 1 quota unit): null when Google answers for this mailbox, else
 * the error. A stop during the probe ends the run as a stop.
 */
async function probeGoogle(run: RunContext): Promise<unknown> {
  try {
    await run.source.getProfile();
    return null;
  } catch (err) {
    checkStop(run.signal);
    return err;
  }
}

/**
 * What ends the run when a message's fetch failed and the probe failed too (`probe` is `error`
 * itself when there was no probe): the probe's error when it is not temporary (the token, the
 * setup) or asks for a longer wait than the message's (Retry-After, so next_sync_at honours it),
 * else the message's.
 */
function endingError(error: unknown, probe: unknown): unknown {
  if (!isMailSourceError(probe) || probe === error) return error;
  if (probe.kind !== "temporary") return probe;
  const waitOf = (e: unknown) => (isMailSourceError(e) ? (e.retryAfterMs ?? 0) : 0);
  return waitOf(probe) > waitOf(error) ? probe : error;
}

/** Fetched messages by received time; failures last (their order does not matter). */
function receivedMs(item: Fetched): number {
  if ("error" in item || !item.parsed) return Number.MAX_SAFE_INTEGER;
  const ms = item.parsed.receivedAt.getTime();
  return Number.isNaN(ms) ? Number.MAX_SAFE_INTEGER : ms;
}

function checkStop(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw inboxError("stopped");
}

/** Ids as the database takes them, each once, in their first order. */
export function uniqueIds(ids: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const id of Array.isArray(ids) ? ids : []) if (isGmailId(id)) seen.add(id);
  return [...seen];
}

function historyIdOf(value: unknown): string {
  if (typeof value === "string" && HISTORY_ID.test(value)) return value;
  throw inboxError("bad_response");
}

/** fn over items, at most `limit` at a time; results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
