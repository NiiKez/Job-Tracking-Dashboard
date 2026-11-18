/*
 * The pipeline's inputs and outputs. The result type itself (ClassifyResult) lives in
 * src/lib/types.ts, because the rule tester's API returns it; the names below are views of it.
 */
import type { ClassifyResult, Job, KeywordRule } from "@/lib/types";

/** Bulk-mail headers, as the Gmail parser reads them. */
export interface BulkHeaders {
  /** A List-Unsubscribe header is present. */
  listUnsubscribe: boolean;
  listId: string | null;
  /** The Precedence header ("bulk", "list", "junk", …). */
  precedence: string | null;
}

/** One email as the pipeline reads it. Step 2.3 maps the Gmail parser's output onto this. */
export interface MailInput {
  fromName: string;
  fromAddress: string;
  replyToAddress?: string | null;
  subject: string;
  /** Cleaned text: quoted replies and preheader padding already stripped. */
  body: string;
  /** Gmail's internalDate (not the Date header). */
  receivedAt: Date;
  threadId?: string | null;
  bulk?: BulkHeaders;
  /** Primary subtag of Content-Language, lower case ("de"). */
  contentLanguage?: string | null;
}

/** What the pipeline knows besides the email. Step 2.3 looks these up in the database. */
export interface PipelineContext {
  /** All the user's jobs, any status, each with its history. */
  jobs: readonly Job[];
  rules: readonly KeywordRule[];
  /** Settings: create a job from a confirmation that matches none. */
  createFromConfirmation: boolean;
  /** Settings: the user's languages, in order. */
  languages: readonly string[];
  /** The job another email of the same Gmail thread is linked to, or null. */
  threadJobId: string | null;
  /** Jobs that mail from this exact sender address was linked to before. */
  senderJobIds: readonly string[];
  now: Date;
}

/** What to write for an email: see the contract at the top of classify.ts. */
export type ClassifyEffect = ClassifyResult["effect"];

/** One piece of evidence that an email is (or is not) about a job application. */
export type Evidence = ClassifyResult["evidence"][number];
