import "server-only";
import { DEFAULT_USER_SETTINGS } from "@/lib/domain/defaults";
import { withTx, type Db } from "@/lib/server/db/client";
import { findSettingsRow } from "@/lib/server/repo/settings";
import { applyStatusChange, loadJob } from "@/lib/server/services/jobs";
import type { Job } from "@/lib/types";

/**
 * The no-response sweep (docs/plan/2-gmail-ingest.md, "No-response sweep"), as the mock's
 * sweepNoResponse did it, for one user:
 *
 *   sweepNoResponse(userId, { now? }): Promise<Job[]>
 *     Every job that is "applied", not locked, and whose last activity is noResponseDays
 *     (settings) or more before `now` becomes "no_response" through applyStatusChange: source
 *     "time", note "No reply in N days", at `now`. Returns the jobs it marked, as they are now,
 *     oldest activity first. One transaction; each row is locked and checked again, so a job
 *     that moved on meanwhile (an email, a manual change) is left alone.
 *
 * When it runs (the callers decide; the sweep itself has no gate):
 *   - after every sync that finished completely: the check route, and the scheduler
 *     (sync/scheduler.ts) after the runs it starts;
 *   - and at least every SWEEP_EVERY_MS per user: the scheduler, for the users sweepableUserIds
 *     lets through. The scheduler keeps the last sweep time in memory, so a new process sweeps
 *     every such user on its first tick; that keeps "at least every 6 hours" across restarts
 *     without a column. The scheduler runs this part in every configuration (also with
 *     INBOX_SCHEDULER=off or without INBOX_TOKEN_KEY); only its timed syncs need them.
 *
 *   sweepableUserIds(db, now?): Promise<string[]>
 *     The gate: the users the periodic sweep may run for at `now`, so nothing is marked
 *     "no response" while replies may be waiting unsynced:
 *       connected        only when the first scan (or a re-scan after an expired position) is
 *                        done and the last successful sync is at most MAX_INTERVALS_BEHIND sync
 *                        intervals (user settings) before `now`. Never synced: no.
 *       needs_reconnect  no: mail is piling up unread.
 *       disconnected     yes: the user chose to stop reading mail, so there is nothing to wait
 *                        for; replies are tracked by hand, and a manual status change is
 *                        activity that resets the clock.
 *       no connection    no (owner, 2026-11-17): a user is swept only once their inbox was
 *                        connected and its first scan finished, so the 30-day scan of a new
 *                        connection files the replies before anything is marked. So a release
 *                        without INBOX_TOKEN_KEY, or before anyone connected Gmail, sweeps nobody.
 *     Sorted by user id.
 *
 * A reply synced after its job was marked still moves the job: "no response" is not a closed
 * status, and the pipeline's stale-mail rule only looks at email-driven changes. The gate only
 * spares the job a needless step.
 */

const DAY = 86_400_000;

/** The periodic sweep runs at least this often per user. */
export const SWEEP_EVERY_MS = 6 * 3_600_000;
/** A connected inbox whose last successful sync is older than this many intervals is "behind". */
export const MAX_INTERVALS_BEHIND = 2;

export async function sweepNoResponse(userId: string, opts: { now?: Date } = {}): Promise<Job[]> {
  const now = opts.now ?? new Date();
  return withTx(async (tx) => {
    const settings = await findSettingsRow(tx, userId);
    const days = settings?.no_response_days ?? DEFAULT_USER_SETTINGS.noResponseDays;
    const cutoff = new Date(now.getTime() - days * DAY);
    // FOR UPDATE re-checks the conditions on the newest version of each row it waits for.
    const due = await tx<Array<{ id: string }>>`
      SELECT id FROM jobs
      WHERE user_id = ${userId} AND status = 'applied' AND NOT status_locked AND last_activity_at <= ${cutoff}
      ORDER BY last_activity_at, id
      FOR UPDATE`;
    const marked: Job[] = [];
    for (const { id } of due) {
      await applyStatusChange(tx, userId, id, {
        to: "no_response",
        source: "time",
        at: now,
        note: `No reply in ${days} days`,
      });
      marked.push(await loadJob(tx, userId, id));
    }
    return marked;
  });
}

/** See the contract at the top of this file. */
export async function sweepableUserIds(db: Db, now: Date = new Date()): Promise<string[]> {
  const rows = await db<Array<{ id: string }>>`
    SELECT u.id
    FROM users u
    JOIN inbox_connections c ON c.user_id = u.id
    LEFT JOIN user_settings s ON s.user_id = u.id
    WHERE c.status = 'disconnected'
       OR (c.status = 'connected'
           AND c.backfill_state = 'done'
           AND c.last_sync_ok_at >= ${now}::timestamptz - make_interval(mins => ${MAX_INTERVALS_BEHIND}::int *
                 coalesce(s.inbox_interval_minutes, ${DEFAULT_USER_SETTINGS.inboxIntervalMinutes}::int)))
    ORDER BY u.id`;
  return rows.map((r) => r.id);
}
