import "server-only";
import { jobKeys, normalize } from "@/lib/domain/normalize";
import { lockAfterManualChange } from "@/lib/domain/status-change";
import { getDb, isUniqueViolation, withTx, type Db, type Tx } from "@/lib/server/db/client";
import { toEmail, toJob, toStatusEvent, type JobRow } from "@/lib/server/db/rows";
import { checkDemoCap, checkDemoDescription, checkDemoUrl } from "@/lib/server/demo/caps";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/server/errors";
import { countEmailsForJobs, getEmailRow, listEmailRows, setEmailLink } from "@/lib/server/repo/emails";
import { insertEvent, listEventsForJobs } from "@/lib/server/repo/events";
import {
  deleteJobRow,
  fieldsOfRow,
  findDuplicateJobRow,
  getJobRow,
  insertJobRow,
  listAllJobRows,
  listJobRows,
  lockUserJobs,
  touchJobActivity,
  updateJobFields,
  writeJobStatus,
  type JobFields,
} from "@/lib/server/repo/jobs";
import { DEFAULT_PRIORITY } from "@/lib/types";
import type {
  CaptureMethod,
  ChangeSource,
  Email,
  Job,
  JobInput,
  JobWithEmails,
  Priority,
  Status,
  StatusEvent,
  UpsertResult,
} from "@/lib/types";

/**
 * Jobs: the reads and writes behind /api/jobs, and the write path for jobs and emails that the
 * review service and area 2 (Gmail ingest) build on.
 *
 * Reads take a `Db` (the pool from getDb(), or a transaction). The user-facing writes (upsertJob,
 * updateJob, deleteJob) run their own transaction. The write path takes a `Tx`, so a caller can
 * compose several steps in one transaction:
 *
 *   applyStatusChange(tx, userId, jobId, { to, source, at?, emailId?, note?, lock? })
 *     The only way a job's status changes. Locks the job row. When `to` differs from the current
 *     status it records a job_status_events row (from, to, at, source, emailId, note) and sets
 *     status, status_source, updated_at, last_activity_at, applied_at (the first time the job
 *     becomes "applied") and, when `lock` is given, status_locked. When `to` equals the current
 *     status nothing is recorded and only last_activity_at moves, as the mock's linkEmail did.
 *     `at` defaults to now(); last_activity_at never moves backwards. It does not look at
 *     status_locked: automatic callers decide that first (linkEmail does; a no-response sweep
 *     must skip locked jobs). Throws NotFoundError for a job that is not the user's.
 *
 *   linkEmail(tx, userId, { emailId, jobId, to, source, at?, note? })
 *     Links an email to a job and records the change on the email (Email.statusChange). An
 *     email-sourced change (source "email") to a locked job links the email but keeps the
 *     status: statusChange is { from: status, to: status } and only last_activity_at moves, as
 *     the mock's processIncoming did. Any other source (e.g. "review") applies the change
 *     regardless of the lock, as resolveReview did. Does not touch the email's outcome.
 *     Throws NotFoundError when the email or the job is not the user's.
 *
 *   createJobFromEmail(tx, userId, { company, title, status, source, emailId?, note?, description?, at? })
 *     A job found in mail. Company and title are trimmed and cut to the column limits (blank:
 *     BadRequestError). Takes the same per-user lock and duplicate lookup as upsertJob (company
 *     and title; there is no link). A new job gets capture_method "email", status `status` with
 *     status_source `source`, and a creating event (from null) carrying emailId and note; `at`
 *     (default now()) is its created_at, applied_at, last_activity_at and the event's time. The
 *     email, if given, is linked with statusChange { from: null, to: status }. When the job
 *     already exists nothing about it is merged; the email, if given, is linked to it through
 *     linkEmail with `at` and `note` (lock rules apply). As in upsertJob, "applied" never moves
 *     a job backwards: only a "saved" job becomes "applied"; one at a later stage keeps its
 *     status and only gets the email. Returns { job, created, email } (email: the linked email,
 *     or null without emailId).
 *
 * insertEmail, the fourth write-path function, is in services/emails.ts.
 *
 * The public demo's per-workspace caps (demo/caps.ts; demo mode only, a 409 there) are checked
 * where every path passes: createJob (the job count, its description, its link and its creating
 * event), applyStatusChange (a recorded change), and upsertJob and updateJob (a description or a
 * link they write).
 */

/* ------------------------------------------------------------------- reads */

export interface JobFilter {
  /** Matches company and title, ignoring case and accents (as the mock did). */
  q?: string;
  statuses?: readonly Status[];
}

/** The job list (most recent activity first), each job with its history and email count. */
export async function listJobs(db: Db, userId: string, filter: JobFilter = {}): Promise<Job[]> {
  const search = filter.q ? normalize(filter.q) : "";
  const rows = await listJobRows(db, userId, { search, statuses: filter.statuses });
  return assembleJobs(db, userId, rows);
}

/** Every job of the user, oldest first: what the classifier gets (the mock passed its array). */
export async function listAllJobs(db: Db, userId: string): Promise<Job[]> {
  return assembleJobs(db, userId, await listAllJobRows(db, userId));
}

/** One job with its history and email count. NotFoundError when it is not the user's. */
export async function loadJob(db: Db, userId: string, jobId: string): Promise<Job> {
  const [job] = await assembleJobs(db, userId, [await getJobRow(db, userId, jobId)]);
  return job;
}

/** One job with its emails (newest first). NotFoundError when it is not the user's. */
export async function getJob(db: Db, userId: string, jobId: string): Promise<JobWithEmails> {
  const row = await getJobRow(db, userId, jobId);
  const [events, emails] = await Promise.all([
    listEventsForJobs(db, userId, [row.id]),
    listEmailRows(db, userId, { jobId: row.id }),
  ]);
  return { ...toJob(row, events.map(toStatusEvent), emails.length), emails: emails.map(toEmail) };
}

/** Rows to Jobs: the history and email counts of all of them in two queries. */
async function assembleJobs(db: Db, userId: string, rows: JobRow[]): Promise<Job[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [events, counts] = await Promise.all([
    listEventsForJobs(db, userId, ids),
    countEmailsForJobs(db, userId, ids),
  ]);
  const history = new Map<string, StatusEvent[]>();
  for (const event of events) {
    const list = history.get(event.job_id);
    if (list) list.push(toStatusEvent(event));
    else history.set(event.job_id, [toStatusEvent(event)]);
  }
  return rows.map((row) => toJob(row, history.get(row.id) ?? [], counts.get(row.id) ?? 0));
}

/* -------------------------------------------------------- user-facing writes */

/**
 * Adds a job, or updates the one it duplicates (same link, else same company and title).
 * A duplicate takes the new fields where given (priority too), the longer description, and moves forward from
 * "saved" to "applied" only; it never moves back from a later stage.
 */
export async function upsertJob(userId: string, input: JobInput): Promise<UpsertResult> {
  // A duplicate keeps the longer description and takes the new link, so the input is what may
  // be written.
  checkDemoDescription(input.description);
  checkDemoUrl(input.url);
  return withTx(async (tx) => {
    await lockUserJobs(tx, userId);
    const existing = await findDuplicateJobRow(tx, userId, jobKeys(input), { forUpdate: true });
    if (!existing) {
      const row = await createJob(tx, userId, {
        title: input.title,
        company: input.company,
        location: input.location,
        url: input.url || null,
        description: input.description,
        status: input.status,
        priority: input.priority,
        source: input.captureMethod,
        captureMethod: input.captureMethod,
      });
      return { job: await loadJob(tx, userId, row.id), duplicate: false };
    }

    const merged = {
      ...fieldsOfRow(existing),
      title: input.title || existing.title,
      company: input.company || existing.company,
      location: input.location || existing.location,
      url: input.url || existing.url,
      priority: input.priority ?? existing.priority,
      description:
        input.description && input.description.length > existing.description.length
          ? input.description
          : existing.description,
    };
    await saveFields(tx, userId, existing.id, { ...merged, keys: jobKeys(merged) });
    if (input.status === "applied" && existing.status === "saved") {
      await applyStatusChange(tx, userId, existing.id, { to: "applied", source: input.captureMethod });
    }
    return { job: await loadJob(tx, userId, existing.id), duplicate: true };
  });
}

/** What PATCH /api/jobs/[id] may change. */
export type JobPatch = Partial<
  Pick<
    Job,
    | "title"
    | "company"
    | "location"
    | "url"
    | "description"
    | "status"
    | "priority"
    | "statusLocked"
    | "nextInterview"
    | "offerDeadline"
  >
>;

/**
 * Edits a job. A status change is a manual change and locks the job against email, except
 * saved -> applied (the normal "Mark applied" flow); an explicit statusLocked wins over both.
 * A link that another job of the user already has is a ConflictError (409). A date outside the
 * years 1970-9999 (UTC) is a BadRequestError (400).
 */
export async function updateJob(userId: string, jobId: string, patch: JobPatch): Promise<Job> {
  if (patch.description !== undefined) checkDemoDescription(patch.description);
  checkDemoUrl(patch.url);
  return withTx(async (tx) => {
    // A link edit takes the per-user lock (before the row lock, as upsertJob does), so an
    // upsert of the same link waits and then finds this job, instead of inserting a second one
    // and failing on jobs_user_id_url_norm_key.
    if (patch.url !== undefined) await lockUserJobs(tx, userId);
    const row = await getJobRow(tx, userId, jobId, { forUpdate: true });
    const fields = fieldsOfRow(row);
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.company !== undefined) fields.company = patch.company;
    if (patch.location !== undefined) fields.location = patch.location;
    if (patch.url !== undefined) fields.url = patch.url || null; // "" means no link, as in the schema
    if (patch.description !== undefined) fields.description = patch.description;
    if (patch.nextInterview !== undefined) {
      fields.nextInterviewAt = patch.nextInterview ? toDate(patch.nextInterview.at, "nextInterview.at") : null;
      fields.nextInterviewRound = patch.nextInterview ? patch.nextInterview.round : null;
    }
    if (patch.offerDeadline !== undefined) {
      fields.offerDeadline = patch.offerDeadline ? toDate(patch.offerDeadline, "offerDeadline") : null;
    }
    if (patch.priority !== undefined) fields.priority = patch.priority;
    if (typeof patch.statusLocked === "boolean") fields.statusLocked = patch.statusLocked;
    await saveFields(tx, userId, row.id, { ...fields, keys: jobKeys(fields) });

    if (patch.status && patch.status !== row.status) {
      const lock = lockAfterManualChange(row.status, patch.status, patch.statusLocked);
      await applyStatusChange(tx, userId, row.id, { to: patch.status, source: "manual", lock });
    }
    return loadJob(tx, userId, row.id);
  });
}

/** Deletes a job and its history. Its emails stay, unlinked. NotFoundError when it is not the user's. */
export async function deleteJob(userId: string, jobId: string): Promise<void> {
  if (!(await deleteJobRow(getDb(), userId, jobId))) throw new NotFoundError("Job not found");
}

async function saveFields(tx: Tx, userId: string, jobId: string, fields: JobFields): Promise<void> {
  try {
    await updateJobFields(tx, userId, jobId, fields);
  } catch (err) {
    if (isUniqueViolation(err, "jobs_user_id_url_norm_key")) {
      throw new ConflictError("Another job already has this link");
    }
    throw err;
  }
}

/**
 * A date from a patch. Only years 1970-9999 (UTC): PostgreSQL has no year 0 (22008), and
 * postgres.js reads timestamptz text with new Date(), which gets years 0001-0099 wrong.
 */
function toDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestError(`${field} is not a valid date`);
  const year = date.getUTCFullYear();
  if (year < 1970 || year > 9999) throw new BadRequestError(`${field} is out of range`);
  return date;
}

/* ------------------------------------------------------------- write path */

interface NewJob {
  title: string;
  company: string;
  location: string;
  url: string | null;
  description: string;
  status: Status;
  /** Default DEFAULT_PRIORITY. */
  priority?: Priority;
  source: ChangeSource;
  captureMethod: CaptureMethod;
  /** When it happened: created_at, applied_at, last_activity_at and the event. Default now(). */
  at?: Date;
  emailId?: string | null;
  note?: string | null;
}

/**
 * Inserts a job and the event that created it (from null), at the same time. Every new job comes
 * through here, always under lockUserJobs, so the demo's job count is exact.
 */
async function createJob(tx: Tx, userId: string, job: NewJob): Promise<JobRow> {
  checkDemoDescription(job.description);
  checkDemoUrl(job.url);
  await checkDemoCap(tx, userId, "jobs");
  await checkDemoCap(tx, userId, "statusEvents");
  const at = job.at ?? null;
  const row = await insertJobRow(tx, userId, {
    title: job.title,
    company: job.company,
    location: job.location,
    url: job.url,
    description: job.description,
    keys: jobKeys(job),
    status: job.status,
    priority: job.priority ?? DEFAULT_PRIORITY,
    statusSource: job.source,
    captureMethod: job.captureMethod,
    at,
  });
  await insertEvent(tx, userId, {
    jobId: row.id,
    from: null,
    to: job.status,
    at,
    source: job.source,
    emailId: job.emailId ?? null,
    note: job.note ?? null,
  });
  return row;
}

export interface StatusChange {
  to: Status;
  source: ChangeSource;
  /** When it happened (e.g. the email's received time). Default now(). */
  at?: Date;
  /** The email that caused it; must be the user's. */
  emailId?: string | null;
  note?: string | null;
  /** Sets status_locked together with a real change. */
  lock?: boolean;
}

export interface StatusChangeResult {
  /** The status before. */
  from: Status;
  /** The status now. */
  to: Status;
  /** False when `to` was already the status (nothing recorded). */
  changed: boolean;
}

/** See the contract at the top of this file. */
export async function applyStatusChange(
  tx: Tx,
  userId: string,
  jobId: string,
  change: StatusChange,
): Promise<StatusChangeResult> {
  const row = await getJobRow(tx, userId, jobId, { forUpdate: true });
  const at = change.at ?? null;
  if (row.status === change.to) {
    await touchJobActivity(tx, userId, row.id, at);
    return { from: row.status, to: row.status, changed: false };
  }
  await checkDemoCap(tx, userId, "statusEvents");
  await insertEvent(tx, userId, {
    jobId: row.id,
    from: row.status,
    to: change.to,
    at,
    source: change.source,
    emailId: change.emailId ?? null,
    note: change.note ?? null,
  });
  await writeJobStatus(tx, userId, row.id, { to: change.to, source: change.source, at, lock: change.lock ?? null });
  return { from: row.status, to: change.to, changed: true };
}

export interface LinkEmailInput {
  emailId: string;
  jobId: string;
  /** The status the email points to. */
  to: Status;
  source: ChangeSource;
  at?: Date;
  note?: string | null;
}

/** See the contract at the top of this file. */
export async function linkEmail(
  tx: Tx,
  userId: string,
  input: LinkEmailInput,
): Promise<{ email: Email; changed: boolean }> {
  // Email first, then job: the same lock order as resolveReview.
  const email = await getEmailRow(tx, userId, input.emailId, { forUpdate: true });
  const job = await getJobRow(tx, userId, input.jobId, { forUpdate: true });
  // A manual choice wins over mail: link the email, keep the status.
  const keep = input.source === "email" && job.status_locked;
  const result = await applyStatusChange(tx, userId, job.id, {
    to: keep ? job.status : input.to,
    source: input.source,
    at: input.at,
    emailId: email.id,
    note: input.note,
  });
  const linked = await setEmailLink(tx, userId, email.id, { jobId: job.id, from: result.from, to: result.to });
  return { email: toEmail(linked), changed: result.changed };
}

export interface EmailJobInput {
  company: string;
  title: string;
  status: Status;
  source: ChangeSource;
  emailId?: string;
  note?: string;
  description?: string;
  at?: Date;
}

export interface EmailJobResult {
  job: Job;
  /** False when the job already existed. */
  created: boolean;
  /** The linked email, when emailId was given. */
  email: Email | null;
}

/** See the contract at the top of this file. */
export async function createJobFromEmail(tx: Tx, userId: string, input: EmailJobInput): Promise<EmailJobResult> {
  const company = fit(input.company, 200);
  const title = fit(input.title, 200);
  if (!company || !title) throw new BadRequestError("A job needs a company and a title");
  // Email before the per-user lock: resolveReview holds the email when it gets here.
  const email = input.emailId ? await getEmailRow(tx, userId, input.emailId, { forUpdate: true }) : null;
  await lockUserJobs(tx, userId);

  const existing = await findDuplicateJobRow(tx, userId, jobKeys({ url: null, company, title }), {
    forUpdate: true,
  });
  if (existing) {
    // "applied" never moves a job backwards (as in upsertJob): only a saved job becomes applied.
    const to = input.status === "applied" && existing.status !== "saved" ? existing.status : input.status;
    const linked = email
      ? await linkEmail(tx, userId, {
          emailId: email.id,
          jobId: existing.id,
          to,
          source: input.source,
          at: input.at,
          note: input.note,
        })
      : null;
    return { job: await loadJob(tx, userId, existing.id), created: false, email: linked?.email ?? null };
  }

  const row = await createJob(tx, userId, {
    title,
    company,
    location: "",
    url: null,
    description: fit(input.description ?? "", 50_000),
    status: input.status,
    source: input.source,
    captureMethod: "email",
    at: input.at,
    emailId: email?.id ?? null,
    note: input.note ?? null,
  });
  const linked = email ? await setEmailLink(tx, userId, email.id, { jobId: row.id, from: null, to: input.status }) : null;
  return { job: await loadJob(tx, userId, row.id), created: true, email: linked ? toEmail(linked) : null };
}

/** Trimmed and cut to `max` characters (code points, as the column checks count them). */
function fit(s: string, max: number): string {
  const chars = Array.from(s.trim());
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : chars.join("");
}
