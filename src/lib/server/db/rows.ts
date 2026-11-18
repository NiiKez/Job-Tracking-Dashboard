import "server-only";
import type {
  CaptureMethod,
  ChangeSource,
  Email,
  EmailOutcome,
  Job,
  KeywordRule,
  ReviewReason,
  Settings,
  Status,
  StatusEvent,
} from "@/lib/types";
import type { InboxStatus } from "@/lib/server/inbox/status";

/**
 * Database rows as postgres.js returns them (snake_case, timestamptz as Date, arrays as string
 * arrays) and the mappers to the API types in src/lib/types.ts. The repositories select exactly
 * these columns; the services hand only the mapped types to routes.
 */

/** A jobs row (the columns repo/jobs.ts selects). */
export interface JobRow {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string | null;
  description: string;
  url_norm: string | null;
  company_slug: string;
  title_norm: string;
  status: Status;
  status_source: ChangeSource;
  status_locked: boolean;
  capture_method: CaptureMethod;
  created_at: Date;
  applied_at: Date | null;
  updated_at: Date;
  last_activity_at: Date;
  next_interview_at: Date | null;
  next_interview_round: string | null;
  offer_deadline: Date | null;
}

/** A job_status_events row. */
export interface EventRow {
  id: string;
  job_id: string;
  from_status: Status | null;
  to_status: Status;
  at: Date;
  source: ChangeSource;
  email_id: string | null;
  note: string | null;
}

/** An emails row; suggested_job_ids already holds only ids of this user's existing jobs. */
export interface EmailRow {
  id: string;
  job_id: string | null;
  from_name: string;
  from_address: string;
  subject: string;
  body: string;
  received_at: Date;
  language: string;
  outcome: EmailOutcome;
  detected_status: Status | null;
  matched_keywords: string[];
  change_from: Status | null;
  change_to: Status | null;
  review_reason: ReviewReason | null;
  suggested_job_ids: string[];
  suggested_status: Status | null;
  confidence: number;
  /** Gmail ingest's columns; not part of the Email API type. */
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  body_truncated: boolean;
  /** Came with bulk-mail headers; null when unknown (stored before the column, or not from Gmail). */
  bulk: boolean | null;
}

/** A keyword_rules row. */
export interface RuleRow {
  id: string;
  status: KeywordRule["status"];
  phrase: string;
  language: string;
}

/** A user_settings row. */
export interface SettingsRow {
  no_response_days: number;
  create_from_confirmation: boolean;
  review_uncertain: boolean;
  languages: string[];
  inbox_interval_minutes: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for a canonical UUID string. Ids from the request are checked before they reach SQL:
 * PostgreSQL answers a malformed uuid with an error (22P02), and the API answers 404 instead.
 */
export function isUuid(id: unknown): id is string {
  return typeof id === "string" && UUID.test(id);
}

export function iso(d: Date): string {
  return d.toISOString();
}

function isoOrNull(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export function toStatusEvent(row: EventRow): StatusEvent {
  const event: StatusEvent = {
    id: row.id,
    from: row.from_status,
    to: row.to_status,
    at: iso(row.at),
    source: row.source,
  };
  // Optional in the contract: absent rather than null, as the mock had them.
  if (row.email_id) event.emailId = row.email_id;
  if (row.note !== null) event.note = row.note;
  return event;
}

/** history: the job's events ordered by (at, id); emailCount: its linked emails, counted. */
export function toJob(row: JobRow, history: StatusEvent[], emailCount: number): Job {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.location,
    url: row.url,
    description: row.description,
    status: row.status,
    statusSource: row.status_source,
    statusLocked: row.status_locked,
    captureMethod: row.capture_method,
    createdAt: iso(row.created_at),
    appliedAt: isoOrNull(row.applied_at),
    updatedAt: iso(row.updated_at),
    lastActivityAt: iso(row.last_activity_at),
    history,
    emailCount,
    nextInterview: row.next_interview_at
      ? { at: iso(row.next_interview_at), round: row.next_interview_round ?? "" }
      : null,
    offerDeadline: isoOrNull(row.offer_deadline),
  };
}

export function toEmail(row: EmailRow): Email {
  return {
    id: row.id,
    fromName: row.from_name,
    fromAddress: row.from_address,
    subject: row.subject,
    body: row.body,
    receivedAt: iso(row.received_at),
    language: row.language,
    outcome: row.outcome,
    jobId: row.job_id,
    detectedStatus: row.detected_status,
    matchedKeywords: row.matched_keywords,
    statusChange: row.change_to ? { from: row.change_from, to: row.change_to } : null,
    reviewReason: row.review_reason,
    suggestedJobIds: row.suggested_job_ids,
    suggestedStatus: row.suggested_status,
    confidence: row.confidence,
  };
}

export function toKeywordRule(row: RuleRow): KeywordRule {
  return { id: row.id, status: row.status, phrase: row.phrase, language: row.language };
}

export function toSettings(row: SettingsRow, inbox: InboxStatus): Settings {
  return {
    inbox: { provider: "gmail", ...inbox, intervalMinutes: row.inbox_interval_minutes },
    noResponseDays: row.no_response_days,
    createFromConfirmation: row.create_from_confirmation,
    reviewUncertain: row.review_uncertain,
    languages: row.languages,
  };
}
