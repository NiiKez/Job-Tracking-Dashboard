import "server-only";
import type { Db, Tx } from "@/lib/server/db/client";
import { ConflictError } from "@/lib/server/errors";

/**
 * SQL for Gmail ingest (docs/plan/2-gmail-ingest.md, "Sync" and "What is stored"). Every
 * function filters by user_id. Three groups:
 *
 * The connection's sync columns (inbox_connections). The token and status columns (status,
 * refresh_token_enc, granted_scopes, google_sub, email_address) belong to connection.ts (connect,
 * reconnect, disconnect); the one exception is ensureDemoConnection below.
 *
 *   ensureDemoConnection(db, userId)       demo mode (MAIL_SOURCE=fixture): creates the user's
 *                                          demo connection (`demo` true, no token), or re-connects
 *                                          one that is not connected: status connected, the user's
 *                                          own Google sub and email, the last error and the failure
 *                                          count cleared, next_sync_at now. A demo row keeps its
 *                                          sync position; a connected one is left alone. A Gmail
 *                                          row (`demo` false, whatever its status) is never
 *                                          touched: ConflictError(DEMO_ON_GMAIL_MESSAGE). Taking
 *                                          it over would drop a real token without revoking it,
 *                                          reset its position and sync invented mail into real
 *                                          jobs (a server started with fixture mail by mistake).
 *   getSyncState(db, userId)               status, address, demo, the stored token (to compare
 *                                          only) and the sync columns, or null
 *   startFullScan(db, userId, { historyId, after })
 *                                          the sync position and the scan window, stored before
 *                                          anything is listed; backfill running, counts reset
 *   setBackfillProgress / finishBackfill   the first scan's counts, and its end
 *   setHistoryId(db, userId, historyId)    moves the position (incremental sync)
 *   resetScan(tx, userId)                  "Scan again": the next run is a new full scan, and the
 *                                          ledger forgets every message that was not stored (see
 *                                          the function). Null, with nothing changed, when not
 *                                          connected or while a run holds the lease.
 *   recordSyncSuccess / recordSyncFailure  last_sync_ok_at, last_error_*, consecutive_failures
 *                                          and next_sync_at (now + the interval from settings;
 *                                          after failures the wait doubles, see FAILURE_WAIT;
 *                                          never sooner than Google's Retry-After)
 *
 * The lease (lease_owner, lease_until): one sync per connection at a time, across processes and
 * restarts. Times come from the database clock, so every process agrees on them.
 *
 *   takeLease(db, userId, owner)           true when `owner` now holds it: there was none, or it
 *                                          expired (a crashed process). LEASE_SECONDS long.
 *   renewLease(db, userId, owner)          another LEASE_SECONDS from now; false when `owner` no
 *                                          longer holds it (it expired and another run took it)
 *   releaseLease(db, userId, owner)        gives it up (only `owner`'s)
 *
 * The ledger (inbox_seen_messages): one row per Gmail message looked at, nothing readable.
 *
 *   finishedMessageIds(db, userId, ids)    the ids among `ids` that need no more work (any result
 *                                          but "retry")
 *   claimMessage(tx, userId, id, date)     inside the message's transaction: true when this run
 *                                          may ingest it (no row yet, or a "retry" row); false
 *                                          when another run finished it. A claim waits for a
 *                                          concurrent claim of the same message to commit or
 *                                          roll back. The claimed row says "retry" until
 *                                          finishMessage sets the result, so a rollback leaves
 *                                          the ledger as it was.
 *   finishMessage(tx, userId, id, result)  the claimed row's result: ignored, stored or skipped
 *   markSkipped(db, userId, id, date)      claim and finish "skipped" in one statement (no
 *                                          transaction needed: nothing else is written)
 *   recordFailedAttempt(db, userId, id, date)
 *                                          after the message's transaction rolled back: attempts
 *                                          + 1, result "retry", or "failed" at MAX_ATTEMPTS. A
 *                                          finished row is left alone.
 *   deleteSeenBefore(db, userId, cutoff)   the 90-day clean-up (by received time, else by the
 *                                          last time a run looked at it). Not a "retry" row that a
 *                                          run looked at since `cutoff`: its attempts must reach
 *                                          "failed", or a message received long ago (mail imported
 *                                          into Gmail) would lose them at every run and hold the
 *                                          position forever. One no run has looked at for that
 *                                          long (the mailbox was disconnected, or the position
 *                                          moved past it) is deleted like any other row, as
 *                                          /privacy promises.
 *   deleteAllSeenBefore(db, cutoff)        the same for every user, whatever their connection's
 *                                          status (the scheduler, every 6 hours)
 *
 * What the pipeline needs from earlier mail (PipelineContext):
 *
 *   findThreadJobId(db, userId, threadId)  the job the latest linked email of the thread is on
 *   findSenderJobIds(db, userId, address)  the jobs mail from this exact address was linked to,
 *                                          most recent first
 *   hasEmailForMessage(db, userId, id)     an email row with this Gmail id exists (the ledger row
 *                                          may be gone after 90 days; the unique key backs this)
 */

/* ------------------------------------------------------------- connection */

export type ConnectionStatus = "connected" | "needs_reconnect" | "disconnected";
export type BackfillState = "pending" | "running" | "done";

/** What the sync engine reads of a connection. */
export interface SyncStateRow {
  status: ConnectionStatus;
  email_address: string;
  /** The demo inbox (MAIL_SOURCE=fixture): its position is the demo mail's. */
  demo: boolean;
  /**
   * The stored (encrypted) refresh token when the run read the row, or null. Never decrypted or
   * logged here: only handed back to markNeedsReconnect (connection.ts) to compare, so a run on
   * the old grant cannot mark a connection that was reconnected meanwhile.
   */
  refresh_token_enc: string | null;
  history_id: string | null;
  backfill_state: BackfillState;
  backfill_after: Date | null;
  backfill_total: number | null;
  backfill_done: number;
  last_sync_ok_at: Date | null;
  next_sync_at: Date | null;
  last_error_code: string | null;
  last_error_at: Date | null;
  consecutive_failures: number;
}

/** "Check inbox" (and demo mode's Connect) on a user whose inbox is a Gmail connection. */
export const DEMO_ON_GMAIL_MESSAGE =
  "This server reads demo mail, and your account has a Gmail connection. Demo mail never goes into a Gmail connection, so nothing was checked or changed.";

/** See the contract at the top of this file. */
export async function ensureDemoConnection(db: Db, userId: string): Promise<void> {
  // `c.demo` is checked on the row as it is once locked, so a Gmail row is never written, even
  // one that a concurrent Connect stored after this statement began.
  const rows = await db`
    INSERT INTO inbox_connections AS c (user_id, google_sub, email_address, status, demo, next_sync_at)
    SELECT u.id, u.google_sub, u.email, 'connected', true, now() FROM users u WHERE u.id = ${userId}
    ON CONFLICT (user_id) DO UPDATE SET
      status = 'connected',
      google_sub = EXCLUDED.google_sub,
      email_address = EXCLUDED.email_address,
      last_error_code = NULL,
      last_error_at = NULL,
      consecutive_failures = 0,
      next_sync_at = now(),
      updated_at = now()
    WHERE c.demo AND c.status <> 'connected'
    RETURNING 1`;
  if (rows.length > 0) return;
  // Nothing written: a connected demo row (left alone), a Gmail row, or no such user.
  const [row] = await db<Array<{ demo: boolean }>>`SELECT demo FROM inbox_connections WHERE user_id = ${userId}`;
  if (row && !row.demo) throw new ConflictError(DEMO_ON_GMAIL_MESSAGE);
}

export async function getSyncState(db: Db, userId: string): Promise<SyncStateRow | null> {
  const [row] = await db<SyncStateRow[]>`
    SELECT status, email_address, demo, refresh_token_enc, history_id, backfill_state, backfill_after,
           backfill_total, backfill_done, last_sync_ok_at, next_sync_at, last_error_code, last_error_at,
           consecutive_failures
    FROM inbox_connections WHERE user_id = ${userId}`;
  return row ?? null;
}

/**
 * Starts a full scan: the first one, or (step 2.5) a re-scan after an expired position. The
 * position is stored before anything is listed, so mail arriving during the scan is picked up
 * by the incremental sync afterwards; `after` is fixed here, so a resumed scan lists the same
 * window again (cut to INBOX_BACKFILL_DAYS before now: sync/engine.ts nextListing).
 */
export async function startFullScan(db: Db, userId: string, scan: { historyId: string; after: Date }): Promise<void> {
  await db`
    UPDATE inbox_connections SET
      history_id = ${scan.historyId},
      backfill_state = 'running',
      backfill_after = ${scan.after},
      backfill_total = NULL,
      backfill_done = 0,
      updated_at = now()
    WHERE user_id = ${userId}`;
}

/** The scan's counts: `total` messages listed (when given), `done` of them looked at. */
export async function setBackfillProgress(
  db: Db,
  userId: string,
  progress: { total?: number; done: number },
): Promise<void> {
  await db`
    UPDATE inbox_connections SET
      backfill_total = coalesce(${progress.total ?? null}::int, backfill_total),
      backfill_done = ${progress.done},
      updated_at = now()
    WHERE user_id = ${userId}`;
}

/** Every message of the scan was ingested or skipped for good: incremental sync from now on. */
export async function finishBackfill(db: Db, userId: string): Promise<void> {
  await db`
    UPDATE inbox_connections SET backfill_state = 'done', updated_at = now()
    WHERE user_id = ${userId}`;
}

/**
 * "Scan again" (Settings → Inbox, services: inbox/scan-again.ts). The next run is a new full
 * scan (backfill pending, its window and counts cleared, next_sync_at now), and the ledger
 * forgets every message it did not store: mail a run ignored, skipped or gave up is read again,
 * with the rules of now. Stored mail keeps its row, and its email keeps the Gmail id
 * (hasEmailForMessage), so it is never read twice, also when the owner deleted the email or its
 * job since. The sync position stays until the scan stores a new one (startFullScan).
 *
 * Only on a connected row that no run holds the lease on: a run that is going would end the
 * scan it did not start, or finish ledger rows that were just forgotten. Then null, and nothing
 * changed. Takes the connection row's lock first, so a run that takes the lease meanwhile waits
 * and then reads the reset state. Returns how many ledger rows were forgotten.
 */
export async function resetScan(tx: Tx, userId: string): Promise<{ forgotten: number } | null> {
  const [row] = await tx`
    UPDATE inbox_connections SET
      backfill_state = 'pending',
      backfill_after = NULL,
      backfill_total = NULL,
      backfill_done = 0,
      next_sync_at = now(),
      updated_at = now()
    WHERE user_id = ${userId} AND status = 'connected' AND NOT coalesce(lease_until > now(), false)
    RETURNING user_id`;
  if (!row) return null;
  const forgotten = await tx`
    DELETE FROM inbox_seen_messages WHERE user_id = ${userId} AND result <> 'stored'
    RETURNING 1`;
  return { forgotten: forgotten.length };
}

/** Moves the sync position. */
export async function setHistoryId(db: Db, userId: string, historyId: string): Promise<void> {
  await db`
    UPDATE inbox_connections SET history_id = ${historyId}, updated_at = now()
    WHERE user_id = ${userId}`;
}

/** The interval used when the user has no settings row (as user_settings' default). */
const DEFAULT_INTERVAL_MINUTES = 15;

/** The user's sync interval in minutes, as SQL (read fresh each time). */
function intervalMinutes(db: Db, userId: string) {
  return db`coalesce(
    (SELECT s.inbox_interval_minutes FROM user_settings s WHERE s.user_id = ${userId}),
    ${DEFAULT_INTERVAL_MINUTES}::int)`;
}

/** A run finished: no error, failures reset, the next run one interval from now. */
export async function recordSyncSuccess(db: Db, userId: string): Promise<void> {
  await db`
    UPDATE inbox_connections SET
      last_sync_ok_at = now(),
      last_error_code = NULL,
      last_error_at = NULL,
      consecutive_failures = 0,
      next_sync_at = now() + make_interval(mins => ${intervalMinutes(db, userId)}),
      updated_at = now()
    WHERE user_id = ${userId}`;
}

/**
 * The interval in Settings changed: a connected inbox's next run moves forward to one new
 * interval after its last successful sync, when that is sooner than the run already scheduled
 * (a longer interval takes effect after the next run). Not while failing: the back-off, or a wait
 * Google asked for, stays. The scheduler picks it up on its next tick.
 */
export async function pullNextSyncForward(db: Db, userId: string, minutes: number): Promise<void> {
  await db`
    UPDATE inbox_connections SET
      next_sync_at = LEAST(next_sync_at, coalesce(last_sync_ok_at, now()) + make_interval(mins => ${minutes}))
    WHERE user_id = ${userId} AND status = 'connected' AND consecutive_failures = 0`;
}

/**
 * FAILURE_WAIT: after n failures in a row the next run waits interval × 2^n minutes, at most
 * 60 minutes (or the interval, when that is longer). The scheduler (step 2.6) picks
 * connections by next_sync_at.
 */
export const MAX_FAILURE_WAIT_MINUTES = 60;

/** The longest Retry-After that pushes next_sync_at back (parseRetryAfter caps at a day too). */
const MAX_RETRY_AFTER_MS = 86_400_000;

/**
 * A run failed with `code` (a stable code from sync/errors.ts, never Google's text). When Google
 * asked to wait (`retryAfterMs`, e.g. a daily limit), the next run is not before that either.
 */
export async function recordSyncFailure(
  db: Db,
  userId: string,
  code: string,
  opts: { retryAfterMs?: number | null } = {},
): Promise<void> {
  const raw = opts.retryAfterMs;
  const retryAfterMs = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.min(Math.round(raw), MAX_RETRY_AFTER_MS) : 0;
  await db`
    UPDATE inbox_connections SET
      last_error_code = ${code.slice(0, 64)},
      last_error_at = now(),
      consecutive_failures = consecutive_failures + 1,
      next_sync_at = greatest(
        now() + make_interval(mins => least(
          ${intervalMinutes(db, userId)} * power(2, least(consecutive_failures + 1, 10))::int,
          greatest(${intervalMinutes(db, userId)}, ${MAX_FAILURE_WAIT_MINUTES}::int))),
        now() + make_interval(secs => ${retryAfterMs / 1000}::double precision)),
      updated_at = now()
    WHERE user_id = ${userId}`;
}

/* ------------------------------------------------------------------ lease */

/** How long a lease lasts without renewal (the plan: 3 minutes). */
export const LEASE_SECONDS = 180;

/**
 * Takes the connection's lease for `owner` when nobody holds it or it expired. Does not touch
 * updated_at: the lease is not a change of the connection.
 */
export async function takeLease(db: Db, userId: string, owner: string): Promise<boolean> {
  const rows = await db`
    UPDATE inbox_connections SET
      lease_owner = ${owner},
      lease_until = now() + make_interval(secs => ${LEASE_SECONDS}::double precision)
    WHERE user_id = ${userId} AND (lease_until IS NULL OR lease_until < now())
    RETURNING 1`;
  return rows.length > 0;
}

/** Another LEASE_SECONDS for `owner`; false when the lease is no longer theirs. */
export async function renewLease(db: Db, userId: string, owner: string): Promise<boolean> {
  const rows = await db`
    UPDATE inbox_connections SET lease_until = now() + make_interval(secs => ${LEASE_SECONDS}::double precision)
    WHERE user_id = ${userId} AND lease_owner = ${owner}
    RETURNING 1`;
  return rows.length > 0;
}

/** Gives up `owner`'s lease (a lease taken over by someone else meanwhile stays theirs). */
export async function releaseLease(db: Db, userId: string, owner: string): Promise<void> {
  await db`
    UPDATE inbox_connections SET lease_owner = NULL, lease_until = NULL
    WHERE user_id = ${userId} AND lease_owner = ${owner}`;
}

/* ------------------------------------------------------------------ ledger */

/** A message that failed in this many runs is given up ("failed"). */
export const MAX_ATTEMPTS = 3;
/**
 * Ledger rows older than this are deleted. With INBOX_BACKFILL_DAYS above it (the deployment
 * uses 180), a resumed scan or a re-scan after an expired position reads ignored mail older than
 * this again; mail that was stored is still skipped (hasEmailForMessage, the unique key).
 */
export const LEDGER_DAYS = 90;

export type SeenResult = "ignored" | "stored" | "skipped" | "retry" | "failed";

/** The ids among `ids` that need no more work: any result but "retry". */
export async function finishedMessageIds(db: Db, userId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db<Array<{ gmail_message_id: string }>>`
    SELECT gmail_message_id FROM inbox_seen_messages
    WHERE user_id = ${userId} AND gmail_message_id = ANY(${ids}::text[]) AND result <> 'retry'`;
  return new Set(rows.map((r) => r.gmail_message_id));
}

/** See the contract at the top of this file. */
export async function claimMessage(tx: Tx, userId: string, messageId: string, internalDate: Date | null): Promise<boolean> {
  const rows = await tx`
    INSERT INTO inbox_seen_messages AS s (user_id, gmail_message_id, result, internal_date)
    VALUES (${userId}, ${messageId}, 'retry', ${internalDate})
    ON CONFLICT (user_id, gmail_message_id) DO UPDATE SET
      seen_at = now(),
      internal_date = coalesce(EXCLUDED.internal_date, s.internal_date)
    WHERE s.result = 'retry'
    RETURNING 1`;
  return rows.length > 0;
}

/** The claimed message's result (in the claim's transaction). */
export async function finishMessage(
  tx: Tx,
  userId: string,
  messageId: string,
  result: "ignored" | "stored" | "skipped",
): Promise<void> {
  await tx`
    UPDATE inbox_seen_messages SET result = ${result}, seen_at = now()
    WHERE user_id = ${userId} AND gmail_message_id = ${messageId}`;
}

/** Records a message as skipped (sent, draft, spam, trash, chat, own address, gone). */
export async function markSkipped(db: Db, userId: string, messageId: string, internalDate: Date | null): Promise<void> {
  await db`
    INSERT INTO inbox_seen_messages AS s (user_id, gmail_message_id, result, internal_date)
    VALUES (${userId}, ${messageId}, 'skipped', ${internalDate})
    ON CONFLICT (user_id, gmail_message_id) DO UPDATE SET
      result = 'skipped',
      seen_at = now(),
      internal_date = coalesce(EXCLUDED.internal_date, s.internal_date)
    WHERE s.result = 'retry'`;
}

/**
 * One more failed run for the message: "retry", or "failed" once it failed in MAX_ATTEMPTS
 * runs. Null when the row was already finished (another run did it meanwhile).
 */
export async function recordFailedAttempt(
  db: Db,
  userId: string,
  messageId: string,
  internalDate: Date | null,
): Promise<{ result: "retry" | "failed"; attempts: number } | null> {
  const [row] = await db<Array<{ result: "retry" | "failed"; attempts: number }>>`
    INSERT INTO inbox_seen_messages AS s (user_id, gmail_message_id, result, attempts, internal_date)
    VALUES (
      ${userId}, ${messageId},
      CASE WHEN 1 >= ${MAX_ATTEMPTS}::int THEN 'failed' ELSE 'retry' END, 1, ${internalDate})
    ON CONFLICT (user_id, gmail_message_id) DO UPDATE SET
      attempts = s.attempts + 1,
      result = CASE WHEN s.attempts + 1 >= ${MAX_ATTEMPTS}::int THEN 'failed' ELSE 'retry' END,
      seen_at = now(),
      internal_date = coalesce(EXCLUDED.internal_date, s.internal_date)
    WHERE s.result = 'retry'
    RETURNING result, attempts`;
  return row ?? null;
}

/**
 * Deletes the user's ledger rows older than `cutoff`, "retry" rows a run looked at since then
 * excepted; returns how many.
 */
export async function deleteSeenBefore(db: Db, userId: string, cutoff: Date): Promise<number> {
  const rows = await db`
    DELETE FROM inbox_seen_messages
    WHERE user_id = ${userId} AND coalesce(internal_date, seen_at) < ${cutoff}
      AND (result <> 'retry' OR seen_at < ${cutoff})
    RETURNING 1`;
  return rows.length;
}

/** deleteSeenBefore for every user; returns how many rows. */
export async function deleteAllSeenBefore(db: Db, cutoff: Date): Promise<number> {
  const [{ count }] = await db<Array<{ count: number }>>`
    WITH gone AS (
      DELETE FROM inbox_seen_messages
      WHERE coalesce(internal_date, seen_at) < ${cutoff} AND (result <> 'retry' OR seen_at < ${cutoff})
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM gone`;
  return count;
}

/* -------------------------------------------------------- pipeline context */

/** At most this many jobs come back from findSenderJobIds. */
const MAX_SENDER_JOBS = 20;

/** The job the most recent linked email of this Gmail thread is on, or null. */
export async function findThreadJobId(db: Db, userId: string, threadId: string | null): Promise<string | null> {
  if (!threadId) return null;
  const [row] = await db<Array<{ job_id: string }>>`
    SELECT job_id FROM emails
    WHERE user_id = ${userId} AND gmail_thread_id = ${threadId} AND job_id IS NOT NULL
    ORDER BY received_at DESC, id DESC
    LIMIT 1`;
  return row?.job_id ?? null;
}

/** The jobs that mail from exactly this address was linked to, most recent first. */
export async function findSenderJobIds(db: Db, userId: string, address: string): Promise<string[]> {
  if (!address) return [];
  const rows = await db<Array<{ job_id: string }>>`
    SELECT job_id FROM emails
    WHERE user_id = ${userId} AND from_address = ${address} AND job_id IS NOT NULL
    GROUP BY job_id
    ORDER BY max(received_at) DESC, job_id
    LIMIT ${MAX_SENDER_JOBS}`;
  return rows.map((r) => r.job_id);
}

/** True when an email with this Gmail message id is stored. */
export async function hasEmailForMessage(db: Db, userId: string, messageId: string): Promise<boolean> {
  const rows = await db`
    SELECT 1 FROM emails WHERE user_id = ${userId} AND gmail_message_id = ${messageId}`;
  return rows.length > 0;
}
