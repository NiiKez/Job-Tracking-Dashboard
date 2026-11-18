import "server-only";
import type { Db, Tx } from "@/lib/server/db/client";
import { isUuid, toEmail } from "@/lib/server/db/rows";
import { BadRequestError } from "@/lib/server/errors";
import { insertEmailRow, listEmailRows } from "@/lib/server/repo/emails";
import type { Email, EmailOutcome, ReviewReason, Status } from "@/lib/types";

/**
 * Emails: the Activity and review lists, and insertEmail, part of the write path that area 2
 * (Gmail ingest) builds on (the rest is in services/jobs.ts):
 *
 *   insertEmail(tx, userId, fields)
 *     Stores an email with what the pipeline decided about it, not linked to any job (jobId and
 *     statusChange null). Link it afterwards with linkEmail or createJobFromEmail, in the same
 *     transaction. suggestedJobIds keeps only well-formed ids; ids of jobs that are gone (or were
 *     never the user's) are dropped whenever an email is read. Returns the stored Email.
 *     Mail from Gmail also carries its Gmail ids and whether the body was cut (gmailMessageId,
 *     gmailThreadId, bodyTruncated) and whether it had bulk-mail headers (bulk), which
 *     services/recheck.ts needs to classify it again; a second email with the same
 *     gmailMessageId for the user violates emails_user_id_gmail_message_id_key. The rule tester
 *     and the seed leave them out.
 */

export interface EmailFilter {
  outcomes?: readonly EmailOutcome[];
  /** Only the emails linked to this job (none for an unknown or malformed id). */
  jobId?: string;
}

/** Newest first. */
export async function listEmails(db: Db, userId: string, filter: EmailFilter = {}): Promise<Email[]> {
  if (filter.jobId && !isUuid(filter.jobId)) return [];
  const rows = await listEmailRows(db, userId, { outcomes: filter.outcomes, jobId: filter.jobId || undefined });
  return rows.map(toEmail);
}

export interface NewEmail {
  fromName?: string;
  fromAddress?: string;
  subject?: string;
  body?: string;
  receivedAt: Date;
  language?: string;
  outcome: EmailOutcome;
  detectedStatus?: Status | null;
  matchedKeywords?: readonly string[];
  reviewReason?: ReviewReason | null;
  /** Best first. */
  suggestedJobIds?: readonly string[];
  suggestedStatus?: Status | null;
  /** 0..1 */
  confidence: number;
  /** Gmail's message id (at most 64 characters); null or absent for mail not from Gmail. */
  gmailMessageId?: string | null;
  /** Gmail's thread id (at most 64 characters). */
  gmailThreadId?: string | null;
  /** The body is not the whole text (cut at 20,000 characters, or a part could not be read). */
  bodyTruncated?: boolean;
  /** The mail came with bulk-mail headers (relatedness.ts isBulk); null or absent when unknown. */
  bulk?: boolean | null;
}

/** See the contract at the top of this file. */
export async function insertEmail(tx: Tx, userId: string, email: NewEmail): Promise<Email> {
  if (Number.isNaN(email.receivedAt.getTime())) throw new BadRequestError("receivedAt is not a valid date");
  const row = await insertEmailRow(tx, userId, {
    fromName: email.fromName ?? "",
    fromAddress: email.fromAddress ?? "",
    subject: email.subject ?? "",
    body: email.body ?? "",
    receivedAt: email.receivedAt,
    language: email.language ?? "",
    outcome: email.outcome,
    detectedStatus: email.detectedStatus ?? null,
    matchedKeywords: email.matchedKeywords ?? [],
    reviewReason: email.reviewReason ?? null,
    suggestedJobIds: (email.suggestedJobIds ?? []).filter(isUuid),
    suggestedStatus: email.suggestedStatus ?? null,
    confidence: email.confidence,
    gmailMessageId: email.gmailMessageId || null,
    gmailThreadId: email.gmailThreadId || null,
    bodyTruncated: email.bodyTruncated ?? false,
    bulk: email.bulk ?? null,
  });
  return toEmail(row);
}
