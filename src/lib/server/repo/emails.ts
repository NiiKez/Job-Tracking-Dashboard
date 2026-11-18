import "server-only";
import type { Db, Tx } from "@/lib/server/db/client";
import { isUuid, type EmailRow } from "@/lib/server/db/rows";
import { NotFoundError } from "@/lib/server/errors";
import type { EmailOutcome, ReviewReason, Status } from "@/lib/types";

/**
 * SQL for the emails table. Every function filters by user_id. Linking an email to a job goes
 * through linkEmail / createJobFromEmail in services/jobs.ts, which also record the status change.
 */

/**
 * The columns every query returns (EmailRow), for a query that names the table `e`.
 * suggested_job_ids has no foreign key, so ids of jobs that no longer exist are dropped here,
 * keeping the order (best first).
 */
function columns(db: Db) {
  return db`
    e.id, e.job_id, e.from_name, e.from_address, e.subject, e.body, e.received_at, e.language,
    e.outcome, e.detected_status, e.matched_keywords, e.change_from, e.change_to, e.review_reason,
    ARRAY(
      SELECT s.id FROM unnest(e.suggested_job_ids) WITH ORDINALITY AS s (id, n)
      WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.user_id = e.user_id AND j.id = s.id)
      ORDER BY s.n
    ) AS suggested_job_ids,
    e.suggested_status, e.confidence, e.gmail_message_id, e.gmail_thread_id, e.body_truncated, e.bulk`;
}

export interface EmailRowFilter {
  outcomes?: readonly EmailOutcome[];
  /** Only this job's emails. Must be a valid uuid (the service checks). */
  jobId?: string;
}

/** Newest first. */
export async function listEmailRows(db: Db, userId: string, filter: EmailRowFilter = {}): Promise<EmailRow[]> {
  const outcomes = filter.outcomes ?? [];
  return db<EmailRow[]>`
    SELECT ${columns(db)} FROM emails e
    WHERE e.user_id = ${userId}
      ${outcomes.length ? db`AND e.outcome = ANY(${outcomes}::text[])` : db``}
      ${filter.jobId ? db`AND e.job_id = ${filter.jobId}` : db``}
    ORDER BY e.received_at DESC, e.id DESC`;
}

/** The email, or NotFoundError (404) when it does not exist, is another user's, or the id is malformed. */
export async function getEmailRow(
  db: Db,
  userId: string,
  emailId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<EmailRow> {
  const [row] = isUuid(emailId)
    ? await db<EmailRow[]>`
        SELECT ${columns(db)} FROM emails e WHERE e.user_id = ${userId} AND e.id = ${emailId}
        ${opts.forUpdate ? db`FOR UPDATE OF e` : db``}`
    : [];
  if (!row) throw new NotFoundError("Email not found");
  return row;
}

export interface NewEmailRow {
  fromName: string;
  fromAddress: string;
  subject: string;
  body: string;
  receivedAt: Date;
  language: string;
  outcome: EmailOutcome;
  detectedStatus: Status | null;
  matchedKeywords: readonly string[];
  reviewReason: ReviewReason | null;
  suggestedJobIds: readonly string[];
  suggestedStatus: Status | null;
  confidence: number;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
  bodyTruncated: boolean;
  bulk: boolean | null;
}

/** Inserts an email that is not linked to a job yet. */
export async function insertEmailRow(tx: Tx, userId: string, e: NewEmailRow): Promise<EmailRow> {
  const [row] = await tx<EmailRow[]>`
    INSERT INTO emails AS e (
      user_id, from_name, from_address, subject, body, received_at, language, outcome,
      detected_status, matched_keywords, review_reason, suggested_job_ids, suggested_status, confidence,
      gmail_message_id, gmail_thread_id, body_truncated, bulk
    ) VALUES (
      ${userId}, ${e.fromName}, ${e.fromAddress}, ${e.subject}, ${e.body}, ${e.receivedAt}, ${e.language},
      ${e.outcome}, ${e.detectedStatus}, ${e.matchedKeywords}::text[], ${e.reviewReason},
      ${e.suggestedJobIds}::uuid[], ${e.suggestedStatus}, ${e.confidence},
      ${e.gmailMessageId}, ${e.gmailThreadId}, ${e.bodyTruncated}, ${e.bulk}
    )
    RETURNING ${columns(tx)}`;
  return row;
}

/** Links the email to a job and records the change applied (from null: the email created the job). */
export async function setEmailLink(
  tx: Tx,
  userId: string,
  emailId: string,
  link: { jobId: string; from: Status | null; to: Status },
): Promise<EmailRow> {
  const [row] = await tx<EmailRow[]>`
    UPDATE emails AS e SET job_id = ${link.jobId}, change_from = ${link.from}, change_to = ${link.to}
    WHERE e.user_id = ${userId} AND e.id = ${emailId}
    RETURNING ${columns(tx)}`;
  if (!row) throw new NotFoundError("Email not found");
  return row;
}

/** Sets what the pipeline (or the user, in review) decided about the email. */
export async function setEmailOutcome(
  tx: Tx,
  userId: string,
  emailId: string,
  outcome: { outcome: EmailOutcome; detectedStatus?: Status | null },
): Promise<EmailRow> {
  const [row] = await tx<EmailRow[]>`
    UPDATE emails AS e SET
      outcome = ${outcome.outcome},
      detected_status = ${outcome.detectedStatus === undefined ? tx`detected_status` : tx`${outcome.detectedStatus}`}
    WHERE e.user_id = ${userId} AND e.id = ${emailId}
    RETURNING ${columns(tx)}`;
  if (!row) throw new NotFoundError("Email not found");
  return row;
}

/**
 * The user's emails that wait for review, oldest first, locked until the transaction ends: a
 * review action on one of them (services/review.ts) waits, and one that committed first has
 * taken its email out of this list.
 */
export async function listReviewRowsForUpdate(tx: Tx, userId: string): Promise<EmailRow[]> {
  return tx<EmailRow[]>`
    SELECT ${columns(tx)} FROM emails e
    WHERE e.user_id = ${userId} AND e.outcome = 'review'
    ORDER BY e.received_at, e.id
    FOR UPDATE OF e`;
}

/** What the pipeline decides about an email, as stored with it. */
export interface EmailClassification {
  language: string;
  outcome: EmailOutcome;
  detectedStatus: Status | null;
  matchedKeywords: readonly string[];
  reviewReason: ReviewReason | null;
  suggestedJobIds: readonly string[];
  suggestedStatus: Status | null;
  confidence: number;
}

/** Replaces what the pipeline decided about a stored email (it was classified again). */
export async function setEmailClassification(
  tx: Tx,
  userId: string,
  emailId: string,
  c: EmailClassification,
): Promise<EmailRow> {
  const [row] = await tx<EmailRow[]>`
    UPDATE emails AS e SET
      language = ${c.language},
      outcome = ${c.outcome},
      detected_status = ${c.detectedStatus},
      matched_keywords = ${c.matchedKeywords}::text[],
      review_reason = ${c.reviewReason},
      suggested_job_ids = ${c.suggestedJobIds}::uuid[],
      suggested_status = ${c.suggestedStatus},
      confidence = ${c.confidence}
    WHERE e.user_id = ${userId} AND e.id = ${emailId}
    RETURNING ${columns(tx)}`;
  if (!row) throw new NotFoundError("Email not found");
  return row;
}

/** Linked emails per job, for several jobs in one query (jobs without emails are absent). */
export async function countEmailsForJobs(
  db: Db,
  userId: string,
  jobIds: readonly string[],
): Promise<Map<string, number>> {
  if (jobIds.length === 0) return new Map();
  const rows = await db<Array<{ job_id: string; count: number }>>`
    SELECT job_id, count(*)::int AS count FROM emails
    WHERE user_id = ${userId} AND job_id = ANY(${jobIds}::uuid[])
    GROUP BY job_id`;
  return new Map(rows.map((r) => [r.job_id, r.count]));
}

export async function countEmailsWithOutcome(db: Db, userId: string, outcome: EmailOutcome): Promise<number> {
  const [row] = await db<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM emails WHERE user_id = ${userId} AND outcome = ${outcome}`;
  return row.count;
}
