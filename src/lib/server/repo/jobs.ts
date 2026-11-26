import "server-only";
import type { JobKeys } from "@/lib/domain/normalize";
import type { Db, Tx } from "@/lib/server/db/client";
import { isUuid, type JobRow } from "@/lib/server/db/rows";
import { NotFoundError } from "@/lib/server/errors";
import type { CaptureMethod, ChangeSource, Priority, Status } from "@/lib/types";

/**
 * SQL for the jobs table. Every function takes the user's id and filters by it, so another
 * user's job looks exactly like a missing one.
 *
 * The status columns (status, status_source, applied_at, last_activity_at) are written only by
 * insertJobRow, writeJobStatus and touchJobActivity, and those are called only from the write
 * path in services/jobs.ts (createJob, applyStatusChange), which records the matching
 * job_status_events row. The key columns come from jobKeys() in the callers.
 */

/** The columns every query returns (JobRow). */
function columns(db: Db) {
  return db`
    id, title, company, location, url, description, url_norm, company_slug, title_norm,
    status, status_source, status_locked, capture_method, created_at, applied_at, updated_at,
    last_activity_at, next_interview_at, next_interview_round, offer_deadline, priority`;
}

/** Escapes LIKE's wildcards (and its escape character) so the text matches literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface JobRowFilter {
  /** Matched as a substring of search_text; pass it normalized. Empty means no filter. */
  search?: string;
  statuses?: readonly Status[];
}

/** The job list: most recent activity first. */
export async function listJobRows(db: Db, userId: string, filter: JobRowFilter = {}): Promise<JobRow[]> {
  const statuses = filter.statuses ?? [];
  const search = filter.search ?? "";
  return db<JobRow[]>`
    SELECT ${columns(db)} FROM jobs
    WHERE user_id = ${userId}
      ${statuses.length ? db`AND status = ANY(${statuses}::text[])` : db``}
      ${search ? db`AND search_text LIKE '%' || ${escapeLike(search)}::text || '%'` : db``}
    ORDER BY last_activity_at DESC, id DESC`;
}

/** Every job of the user in the order they were added (what the mock's array held). */
export async function listAllJobRows(db: Db, userId: string): Promise<JobRow[]> {
  return db<JobRow[]>`
    SELECT ${columns(db)} FROM jobs WHERE user_id = ${userId} ORDER BY created_at, id`;
}

/** The job, or null when it does not exist, belongs to another user, or the id is malformed. */
export async function findJobRow(
  db: Db,
  userId: string,
  jobId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<JobRow | null> {
  if (!isUuid(jobId)) return null;
  const [row] = await db<JobRow[]>`
    SELECT ${columns(db)} FROM jobs WHERE user_id = ${userId} AND id = ${jobId}
    ${opts.forUpdate ? db`FOR UPDATE` : db``}`;
  return row ?? null;
}

/** Like findJobRow, but a missing job is a NotFoundError (404). */
export async function getJobRow(
  db: Db,
  userId: string,
  jobId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<JobRow> {
  const row = await findJobRow(db, userId, jobId, opts);
  if (!row) throw new NotFoundError("Job not found");
  return row;
}

/**
 * Serializes job creation, dedupe and link edits per user until the transaction ends
 * (upsertJob, createJobFromEmail, and updateJob when the patch has a link). Take it before any
 * job row lock, so lock order stays the same everywhere.
 */
export async function lockUserJobs(tx: Tx, userId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended('jobs:' || ${userId}::text, 0))`;
}

/**
 * The job a new one would duplicate: same normalized link first, then same company and title
 * (only when the company has a key). The oldest wins when several match. Call it under
 * lockUserJobs() when the answer decides an insert.
 */
export async function findDuplicateJobRow(
  db: Db,
  userId: string,
  keys: Pick<JobKeys, "urlNorm" | "companySlug" | "titleNorm">,
  opts: { forUpdate?: boolean } = {},
): Promise<JobRow | null> {
  const lock = opts.forUpdate ? db`FOR UPDATE` : db``;
  if (keys.urlNorm) {
    const [row] = await db<JobRow[]>`
      SELECT ${columns(db)} FROM jobs WHERE user_id = ${userId} AND url_norm = ${keys.urlNorm}
      ${lock}`;
    if (row) return row;
  }
  if (!keys.companySlug) return null;
  const [row] = await db<JobRow[]>`
    SELECT ${columns(db)} FROM jobs
    WHERE user_id = ${userId} AND company_slug = ${keys.companySlug} AND title_norm = ${keys.titleNorm}
    ORDER BY created_at, id
    LIMIT 1
    ${lock}`;
  return row ?? null;
}

export interface NewJobRow {
  title: string;
  company: string;
  location: string;
  url: string | null;
  description: string;
  keys: JobKeys;
  status: Status;
  priority: Priority;
  statusSource: ChangeSource;
  captureMethod: CaptureMethod;
  /**
   * When it happened (e.g. a back-dated email's received time): created_at, last_activity_at
   * and, for an applied job, applied_at. null means now().
   */
  at: Date | null;
}

/** Inserts a job. Only createJob() in services/jobs.ts calls it, together with the first event. */
export async function insertJobRow(tx: Tx, userId: string, job: NewJobRow): Promise<JobRow> {
  const [row] = await tx<JobRow[]>`
    INSERT INTO jobs (
      user_id, title, company, location, url, description,
      url_norm, company_slug, title_norm, search_text,
      status, priority, status_source, capture_method, created_at, applied_at, last_activity_at
    ) VALUES (
      ${userId}, ${job.title}, ${job.company}, ${job.location}, ${job.url}, ${job.description},
      ${job.keys.urlNorm}, ${job.keys.companySlug}, ${job.keys.titleNorm}, ${job.keys.searchText},
      ${job.status}, ${job.priority}, ${job.statusSource}, ${job.captureMethod},
      coalesce(${job.at}::timestamptz, now()),
      CASE WHEN ${job.status}::text = 'applied' THEN coalesce(${job.at}::timestamptz, now()) END,
      coalesce(${job.at}::timestamptz, now())
    )
    RETURNING ${columns(tx)}`;
  return row;
}

/** The columns a user (or a merge) edits. Written all at once, from a row held FOR UPDATE. */
export interface JobFields {
  title: string;
  company: string;
  location: string;
  url: string | null;
  description: string;
  /** jobKeys() of the url, company and title above. */
  keys: JobKeys;
  priority: Priority;
  statusLocked: boolean;
  nextInterviewAt: Date | null;
  nextInterviewRound: string | null;
  offerDeadline: Date | null;
}

/** The editable fields of a row as they are (keys still to be recomputed by the caller). */
export function fieldsOfRow(row: JobRow): Omit<JobFields, "keys"> {
  return {
    title: row.title,
    company: row.company,
    location: row.location,
    url: row.url,
    description: row.description,
    priority: row.priority,
    statusLocked: row.status_locked,
    nextInterviewAt: row.next_interview_at,
    nextInterviewRound: row.next_interview_round,
    offerDeadline: row.offer_deadline,
  };
}

/**
 * Writes the editable fields and updated_at. A link another job of the user has fails with a
 * unique violation of jobs_user_id_url_norm_key; the service turns it into a 409.
 */
export async function updateJobFields(tx: Tx, userId: string, jobId: string, f: JobFields): Promise<JobRow> {
  const [row] = await tx<JobRow[]>`
    UPDATE jobs SET
      title = ${f.title},
      company = ${f.company},
      location = ${f.location},
      url = ${f.url},
      description = ${f.description},
      url_norm = ${f.keys.urlNorm},
      company_slug = ${f.keys.companySlug},
      title_norm = ${f.keys.titleNorm},
      search_text = ${f.keys.searchText},
      priority = ${f.priority},
      status_locked = ${f.statusLocked},
      next_interview_at = ${f.nextInterviewAt},
      next_interview_round = ${f.nextInterviewRound},
      offer_deadline = ${f.offerDeadline},
      updated_at = now()
    WHERE user_id = ${userId} AND id = ${jobId}
    RETURNING ${columns(tx)}`;
  if (!row) throw new NotFoundError("Job not found");
  return row;
}

/**
 * A status change on the job row. Only applyStatusChange() calls it, after it recorded the event.
 * `at` null means now(). last_activity_at never moves backwards; applied_at is set once.
 */
export async function writeJobStatus(
  tx: Tx,
  userId: string,
  jobId: string,
  change: { to: Status; source: ChangeSource; at: Date | null; lock: boolean | null },
): Promise<void> {
  await tx`
    UPDATE jobs SET
      status = ${change.to},
      status_source = ${change.source},
      status_locked = coalesce(${change.lock}::boolean, status_locked),
      applied_at = CASE
        WHEN ${change.to}::text = 'applied' THEN coalesce(applied_at, ${change.at}::timestamptz, now())
        ELSE applied_at
      END,
      updated_at = now(),
      last_activity_at = greatest(last_activity_at, coalesce(${change.at}::timestamptz, now()))
    WHERE user_id = ${userId} AND id = ${jobId}`;
}

/** Something happened without a status change (an email was linked): moves last_activity_at only. */
export async function touchJobActivity(tx: Tx, userId: string, jobId: string, at: Date | null): Promise<void> {
  await tx`
    UPDATE jobs SET last_activity_at = greatest(last_activity_at, coalesce(${at}::timestamptz, now()))
    WHERE user_id = ${userId} AND id = ${jobId}`;
}

/** Deletes the job; its events go with it and its emails stay with job_id NULL (both by FK). */
export async function deleteJobRow(db: Db, userId: string, jobId: string): Promise<boolean> {
  if (!isUuid(jobId)) return false;
  const rows = await db`DELETE FROM jobs WHERE user_id = ${userId} AND id = ${jobId} RETURNING id`;
  return rows.length > 0;
}

/** Job count per status (statuses without jobs are absent). */
export async function countJobsByStatus(db: Db, userId: string): Promise<Array<{ status: Status; count: number }>> {
  return db<Array<{ status: Status; count: number }>>`
    SELECT status, count(*)::int AS count FROM jobs WHERE user_id = ${userId} GROUP BY status`;
}
