import "server-only";
import { DEFAULT_USER_SETTINGS } from "@/lib/domain/defaults";
import { classifyMail } from "@/lib/inbox/pipeline/classify";
import { isBulk } from "@/lib/inbox/pipeline/relatedness";
import type { MailInput } from "@/lib/inbox/pipeline/types";
import { getDb, withTx, type Db, type Tx } from "@/lib/server/db/client";
import { lockUserJobs } from "@/lib/server/repo/jobs";
import { findSettingsRow } from "@/lib/server/repo/settings";
import { insertEmail } from "@/lib/server/services/emails";
import { createJobFromEmail, linkEmail, listAllJobs } from "@/lib/server/services/jobs";
import { listRules } from "@/lib/server/services/rules";
import type { ClassifyResult, Email, Job } from "@/lib/types";
import { parseGmailMessage, type ParsedMessage } from "../parse/gmail-message";
import {
  claimMessage,
  findSenderJobIds,
  findThreadJobId,
  finishMessage,
  hasEmailForMessage,
  markSkipped,
  recordFailedAttempt,
} from "../repo";
import type { MailSource } from "../source/types";
import { isMailSourceError } from "./errors";

/**
 * One Gmail message into the database (docs/plan/2-gmail-ingest.md, "One message, one
 * transaction"):
 *
 *   fetchMessage(source, id)            getMessage + parse, before any transaction (attachment
 *                                       fetches are I/O). null when the message is gone (404).
 *                                       Throws what the source throws (MailSourceError).
 *   ingestParsed(userId, parsed, ctx)   the rest, for one fetched message:
 *     1. Skipped without a transaction (ledger "skipped"): labelled SENT, DRAFT, SPAM, TRASH or
 *        CHAT, or from the mailbox's own address.
 *     2. One transaction: claim the ledger row (finished by another run: "already_done", nothing
 *        written); take the per-user jobs lock, so the jobs the pipeline reads stay as they are
 *        until this message is written; if an email with this Gmail id is already stored (its
 *        ledger row was cleaned up), finish the ledger row as "stored" and write nothing else.
 *        Otherwise classifyMail with the context from the database (every job, the rules, the
 *        settings' languages and createFromConfirmation, the thread's job, the sender's jobs,
 *        ctx.now) and write exactly what the contract at the top of
 *        src/lib/inbox/pipeline/classify.ts maps the effect to. Ignored mail leaves only the
 *        ledger row ("ignored"); anything else is "stored".
 *     3. Any error inside the transaction rolls it back (nothing of the message stays), then a
 *        separate statement records the failed attempt: "retry", or "failed" at the third run.
 *   recordFailure(userId, id, date, err) step 3 alone, for a message whose fetch failed
 *   skipGone(userId, id)                ledger "skipped" for a message that no longer exists
 *
 * Shared with the dry run (sync/dry-run.ts), which writes nothing:
 *   skipReason(parsed, ownAddress)      step 1's test alone
 *   receivedTime(parsed, now)           the received time as stored
 *   classifyParsed(db, userId, parsed, receivedAt, now)
 *                                       step 2's context and classifyMail, reading through `db`
 *                                       (the message's transaction, or a read-only one)
 *
 * The received time is Gmail's internalDate, capped at ctx.now (a time from the future would
 * otherwise pin the job's last activity there). Logs carry message ids and codes only.
 */

/** Gmail system labels whose mail is never ingested. */
export const SKIPPED_LABELS: ReadonlySet<string> = new Set(["SENT", "DRAFT", "SPAM", "TRASH", "CHAT"]);

export interface IngestContext {
  /** The mailbox's own address (lower case): its mail is skipped. */
  ownAddress: string;
  /** The run's clock: the pipeline's "now", and the cap on received times. */
  now: Date;
}

export type IngestOutcome =
  | { kind: "stored"; email: Email }
  | { kind: "ignored" }
  | { kind: "skipped"; why: "label" | "own_address" | "gone" }
  /** Another run finished this message first: nothing written. */
  | { kind: "already_done" }
  /** The transaction failed and rolled back; `result` is what the ledger now says. */
  | { kind: "failed_attempt"; result: "retry" | "failed"; attempts: number };

/** The longest Gmail id the ledger and emails columns take. */
const MAX_ID_LENGTH = 64;

/** A Gmail message or thread id the database accepts. */
export function isGmailId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

/** See the contract at the top of this file. */
export async function fetchMessage(source: MailSource, messageId: string): Promise<ParsedMessage | null> {
  const message = await source.getMessage(messageId);
  if (!message) return null;
  return parseGmailMessage(message, { getAttachment: (attachmentId) => source.getAttachment(messageId, attachmentId) });
}

/** A message that no longer exists. */
export async function skipGone(userId: string, messageId: string): Promise<IngestOutcome> {
  await markSkipped(getDb(), userId, messageId, null);
  return { kind: "skipped", why: "gone" };
}

/**
 * Ingests one fetched message. `messageId` is the id the message was listed under (the parsed
 * one can be missing from a malformed message).
 */
export async function ingestParsed(
  userId: string,
  messageId: string,
  parsed: ParsedMessage,
  ctx: IngestContext,
): Promise<IngestOutcome> {
  const receivedAt = receivedTime(parsed, ctx.now);

  const skip = skipReason(parsed, ctx.ownAddress);
  if (skip) {
    await markSkipped(getDb(), userId, messageId, receivedAt);
    return { kind: "skipped", why: skip };
  }

  try {
    return await withTx((tx) => write(tx, userId, messageId, parsed, receivedAt, ctx));
  } catch (err) {
    return recordFailure(userId, messageId, receivedAt, err);
  }
}

/**
 * Records a failed attempt for the message after its transaction rolled back (or its fetch
 * failed). Throws when the attempt cannot be recorded (the database is gone): the run ends.
 */
export async function recordFailure(
  userId: string,
  messageId: string,
  receivedAt: Date | null,
  err: unknown,
): Promise<IngestOutcome> {
  const recorded = await recordFailedAttempt(getDb(), userId, messageId, receivedAt);
  if (!recorded) return { kind: "already_done" };
  console.warn(
    `inbox: message ${messageId} failed (${errorCode(err)}), attempt ${recorded.attempts}` +
      (recorded.result === "failed" ? ", given up" : ""),
  );
  return { kind: "failed_attempt", ...recorded };
}

/** The message's transaction. */
async function write(
  tx: Tx,
  userId: string,
  messageId: string,
  parsed: ParsedMessage,
  receivedAt: Date,
  ctx: IngestContext,
): Promise<IngestOutcome> {
  if (!(await claimMessage(tx, userId, messageId, receivedAt))) return { kind: "already_done" };
  // The jobs the pipeline reads must not change before this message is written (another run,
  // or a job added in the app meanwhile). Same lock as upsertJob and createJobFromEmail.
  await lockUserJobs(tx, userId);
  if (await hasEmailForMessage(tx, userId, messageId)) {
    await finishMessage(tx, userId, messageId, "stored");
    return { kind: "already_done" };
  }

  const { mail, result } = await classifyParsed(tx, userId, parsed, receivedAt, ctx.now);
  const { effect } = result;

  if (effect.kind === "ignore") {
    await finishMessage(tx, userId, messageId, "ignored");
    return { kind: "ignored" };
  }

  // The write path, as the contract at the top of classify.ts maps the effect.
  let email = await insertEmail(tx, userId, {
    fromName: mail.fromName,
    fromAddress: mail.fromAddress,
    subject: mail.subject,
    body: mail.body,
    receivedAt,
    language: result.language ?? "",
    outcome: result.outcome,
    detectedStatus: result.status,
    matchedKeywords: result.matchedKeywords.map((k) => k.phrase),
    reviewReason: result.reviewReason,
    suggestedJobIds: effect.kind === "review" ? effect.suggestedJobIds : [],
    suggestedStatus: effect.kind === "review" ? effect.suggestedStatus : null,
    confidence: result.confidence,
    gmailMessageId: messageId,
    gmailThreadId: mail.threadId,
    bodyTruncated: parsed.bodyTruncated,
    bulk: isBulk(mail.bulk),
  });
  if (effect.kind === "link") {
    ({ email } = await linkEmail(tx, userId, {
      emailId: email.id,
      jobId: effect.jobId,
      to: effect.to,
      source: "email",
      at: receivedAt,
    }));
  } else if (effect.kind === "create") {
    const created = await createJobFromEmail(tx, userId, {
      company: effect.company,
      title: effect.title,
      status: "applied",
      source: "email",
      emailId: email.id,
      at: receivedAt,
      note: effect.status === "applied" ? "Created from a confirmation email" : "Created from the first email about this application",
    });
    email = created.email ?? email;
    // The first mail about an application the tracker never saw is a rejection, an invitation
    // or an offer: the job starts as "applied" at the mail's time and moves on at once, as a
    // job created from the review list does, so its history reads applied -> rejected.
    if (effect.status !== "applied") {
      ({ email } = await linkEmail(tx, userId, {
        emailId: email.id,
        jobId: created.job.id,
        to: effect.status,
        source: "email",
        at: receivedAt,
      }));
    }
  }
  await finishMessage(tx, userId, messageId, "stored");
  return { kind: "stored", email };
}

/** Why a fetched message is skipped without being classified, or null. */
export function skipReason(parsed: ParsedMessage, ownAddress: string): "label" | "own_address" | null {
  if (parsed.labelIds.some((l) => SKIPPED_LABELS.has(l))) return "label";
  if (ownAddress && parsed.fromAddress === ownAddress.toLowerCase()) return "own_address";
  return null;
}

/** Gmail's received time, never after `now` (an invalid one counts as now). */
export function receivedTime(parsed: ParsedMessage, now: Date): Date {
  const ms = parsed.receivedAt.getTime();
  return Number.isNaN(ms) || ms > now.getTime() ? new Date(now) : parsed.receivedAt;
}

export interface Classified {
  /** What the pipeline read (the thread id only when the database takes it). */
  mail: MailInput & { threadId: string | null };
  result: ClassifyResult;
  /** Every job of the user, as the pipeline saw them. */
  jobs: Job[];
}

/**
 * The pipeline's answer for one parsed message, with the context read through `db`: every job,
 * the rules, the settings' languages and createFromConfirmation, the thread's job and the
 * sender's jobs. Writes nothing.
 */
export async function classifyParsed(
  db: Db,
  userId: string,
  parsed: ParsedMessage,
  receivedAt: Date,
  now: Date,
): Promise<Classified> {
  const threadId = isGmailId(parsed.gmailThreadId) ? parsed.gmailThreadId : null;
  const [jobs, rules, settings, threadJobId, senderJobIds] = await Promise.all([
    listAllJobs(db, userId),
    listRules(db, userId),
    findSettingsRow(db, userId),
    findThreadJobId(db, userId, threadId),
    findSenderJobIds(db, userId, parsed.fromAddress),
  ]);
  const mail = {
    fromName: parsed.fromName,
    fromAddress: parsed.fromAddress,
    replyToAddress: parsed.replyToAddress,
    subject: parsed.subject,
    body: parsed.body,
    receivedAt,
    threadId,
    bulk: parsed.bulk,
    contentLanguage: parsed.contentLanguage,
  } satisfies MailInput;
  const result = classifyMail(mail, {
    jobs,
    rules,
    createFromConfirmation: settings?.create_from_confirmation ?? DEFAULT_USER_SETTINGS.createFromConfirmation,
    languages: settings?.languages ?? DEFAULT_USER_SETTINGS.languages,
    threadJobId,
    senderJobIds,
    now,
  });
  return { mail, result, jobs };
}

/**
 * A short, stable identifier for a log line: a MailSourceError's code, PostgreSQL's SQLSTATE, or
 * the error's class name. Never the message, which can quote data.
 */
export function errorCode(err: unknown): string {
  if (isMailSourceError(err)) return err.code;
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(name)) return name;
  }
  return "unknown";
}
