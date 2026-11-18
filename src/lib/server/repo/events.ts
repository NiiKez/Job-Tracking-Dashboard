import "server-only";
import type { Db, Tx } from "@/lib/server/db/client";
import type { EventRow } from "@/lib/server/db/rows";
import type { ChangeSource, Status } from "@/lib/types";

/**
 * SQL for job_status_events, the status history of each job. Rows are only added, by the write
 * path in services/jobs.ts, and leave with their job (ON DELETE CASCADE).
 */

export interface NewEvent {
  jobId: string;
  /** null for the event that created the job. */
  from: Status | null;
  to: Status;
  /** null means now(): the same value the job row gets in this transaction. */
  at: Date | null;
  source: ChangeSource;
  emailId: string | null;
  note: string | null;
}

export async function insertEvent(tx: Tx, userId: string, e: NewEvent): Promise<EventRow> {
  const [row] = await tx<EventRow[]>`
    INSERT INTO job_status_events (user_id, job_id, from_status, to_status, at, source, email_id, note)
    VALUES (${userId}, ${e.jobId}, ${e.from}, ${e.to}, coalesce(${e.at}::timestamptz, now()),
            ${e.source}, ${e.emailId}, ${e.note})
    RETURNING id, job_id, from_status, to_status, at, source, email_id, note`;
  return row;
}

/** The history of several jobs in one query, each job's events in order (at, then id). */
export async function listEventsForJobs(db: Db, userId: string, jobIds: readonly string[]): Promise<EventRow[]> {
  if (jobIds.length === 0) return [];
  return db<EventRow[]>`
    SELECT id, job_id, from_status, to_status, at, source, email_id, note
    FROM job_status_events
    WHERE user_id = ${userId} AND job_id = ANY(${jobIds}::uuid[])
    ORDER BY job_id, at, id`;
}
