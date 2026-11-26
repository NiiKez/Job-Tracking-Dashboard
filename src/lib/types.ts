/**
 * Domain types shared by the API (src/app/api, src/lib/server) and the UI:
 * the contract between the screens and the backend.
 */

export const STATUSES = [
  "saved",
  "applied",
  "interview",
  "offer",
  "rejected",
  "no_response",
] as const;

export type Status = (typeof STATUSES)[number];

/** How much a job matters to the user. Inside each stage, higher priority comes first. */
export const PRIORITIES = ["high", "medium", "low"] as const;

export type Priority = (typeof PRIORITIES)[number];

/** What a job gets when no priority is picked. */
export const DEFAULT_PRIORITY: Priority = "medium";

/** Who or what caused a status change. */
export type ChangeSource =
  | "extension" // clicked Save / Applied in the Chrome extension
  | "paste" // added through the dashboard paste dialog
  | "manual" // changed by hand in the dashboard
  | "email" // an email matched a keyword rule
  | "review" // confirmed from the Needs-review list
  | "time"; // no reply after N days

/** How the job first entered the dashboard. */
export type CaptureMethod = "extension" | "paste" | "email";

export interface StatusEvent {
  id: string;
  from: Status | null;
  to: Status;
  at: string; // ISO date
  source: ChangeSource;
  emailId?: string;
  note?: string;
}

/** The next scheduled interview of a job in the Interview stage. */
export interface NextInterview {
  at: string; // ISO date-time
  /** "Technical interview", "Final round" … (may be empty) */
  round: string;
}

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string | null;
  description: string;
  status: Status;
  /** Set by hand (dashboard or extension); new jobs get DEFAULT_PRIORITY. */
  priority: Priority;
  /** Source of the current status. */
  statusSource: ChangeSource;
  /** True after a manual change: emails won't move this job until unlocked. */
  statusLocked: boolean;
  captureMethod: CaptureMethod;
  createdAt: string;
  appliedAt: string | null;
  updatedAt: string;
  /** Last time anything happened (status change or linked email). */
  lastActivityAt: string;
  history: StatusEvent[];
  emailCount: number;
  /** Set by hand in the job detail; shown on Interview cards. */
  nextInterview: NextInterview | null;
  /** Respond-by date for an offer (ISO, end of that day); shown on Offer cards. */
  offerDeadline: string | null;
}

export interface JobWithEmails extends Job {
  emails: Email[];
}

export type EmailOutcome =
  | "matched" // matched a job and changed (or confirmed) its status
  | "created" // confirmation email created a new application
  | "ignored" // not job related
  | "review" // unsure: waiting in the Needs-review list
  | "resolved" // was in review, confirmed by the user
  | "dismissed"; // was in review, user said "not job related"

export type ReviewReason =
  | "ambiguous_job" // matches more than one application
  | "unknown_job" // looks job related but no application matches
  | "no_keyword" // job matched but no keyword decided the status
  | "conflicting_keywords" // keywords for several statuses matched
  | "status_mismatch" // would change a closed job (offer, rejected), or is older than the job
  | "bulk_mail"; // bulk headers, only the sender's domain or history points at a job: never changes a job by itself

export interface Email {
  id: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  body: string;
  receivedAt: string;
  language: string; // "en" | "de" | ...
  outcome: EmailOutcome;
  jobId: string | null;
  /** Status the keyword rules picked (null when none / unrelated). */
  detectedStatus: Status | null;
  matchedKeywords: string[];
  /** For outcome === "matched" | "created" | "resolved": the change applied. */
  statusChange: { from: Status | null; to: Status } | null;
  /** Only for review items. */
  reviewReason: ReviewReason | null;
  suggestedJobIds: string[];
  suggestedStatus: Status | null;
  /** 0..1 how sure the matcher was. */
  confidence: number;
}

export interface KeywordRule {
  id: string;
  status: Exclude<Status, "saved" | "no_response">;
  phrase: string;
  language: string;
}

/** POST /api/rules/defaults: what "Update defaults" changed, and the rules after it. */
export interface DefaultRulesUpdate {
  /** Default phrases the user did not have. */
  added: number;
  /** Retired default phrases the user still had. */
  removed: number;
  rules: KeywordRule[];
}

/** POST /api/emails/recheck: what classifying the review list again did (services/recheck.ts). */
export interface ReviewRecheckResult {
  /** Emails that waited for review. */
  checked: number;
  /** Linked to a job, with or without a status change. */
  linked: number;
  /** Started a new job. */
  created: number;
  /** No longer counted as job mail: dismissed, as "Not job related" does. */
  dismissed: number;
  /** Still waiting for review. */
  remaining: number;
}

/** The mailbox connection's state (Settings.inbox.state). */
export type InboxState = "not_connected" | "connected" | "needs_reconnect";

export interface Settings {
  inbox: {
    provider: "gmail";
    /** The connected mailbox; null when none was ever connected. */
    address: string | null;
    /** state === "connected": syncing works. */
    connected: boolean;
    /** needs_reconnect: Google no longer accepts the stored access; the screen offers Reconnect. */
    state: InboxState;
    /** A sync is running now (the screen polls settings meanwhile). */
    syncing: boolean;
    /** Progress of the first scan (or a full re-scan); null when none is running. */
    backfill: { done: number; total: number | null } | null;
    /** Last successful sync. */
    lastCheckedAt: string | null;
    /** The last failure, with fixed on-screen text for its code; null after a success. */
    lastError: { code: string; message: string; at: string } | null;
    intervalMinutes: number;
    /**
     * False when the server cannot connect Gmail (no INBOX_TOKEN_KEY, or Google sign-in not
     * configured): the screen says Gmail is not set up. Always true in demo mode.
     */
    configured: boolean;
    /** MAIL_SOURCE=fixture: the inbox reads demo mail from fixtures/mail, not Gmail. */
    demo: boolean;
  };
  noResponseDays: number;
  createFromConfirmation: boolean;
  /** Send uncertain emails to review instead of guessing. Always on in v1. */
  reviewUncertain: boolean;
  languages: string[];
}

export interface JobInput {
  title: string;
  company: string;
  location: string;
  url: string | null;
  description: string;
  status: "saved" | "applied";
  /** Omitted: a new job gets DEFAULT_PRIORITY, a duplicate keeps its own. */
  priority?: Priority;
  captureMethod: Exclude<CaptureMethod, "email">;
}

export interface UpsertResult {
  job: Job;
  /** True when an existing job was updated instead of creating a new one. */
  duplicate: boolean;
}

export interface ParseResult {
  title: string;
  company: string;
  location: string;
  url: string | null;
  description: string;
  /** Fields the parser could not fill (UI highlights them). */
  missing: Array<"title" | "company" | "location" | "url" | "description">;
  /** Existing job this looks like, if any. */
  duplicateOf: Job | null;
}

export interface KeywordHit {
  phrase: string;
  status: KeywordRule["status"];
  language: string;
}

/**
 * What the email pipeline (src/lib/inbox/pipeline) decides about one email; the rule tester
 * shows it. The contract, and how `effect` maps onto the write path, is at the top of
 * src/lib/inbox/pipeline/classify.ts.
 */
export interface ClassifyResult {
  related: boolean;
  /** The status the keyword rules point to (null when none, or not related). */
  status: Status | null;
  matchedKeywords: KeywordHit[];
  language: string | null;
  /** What the pipeline would do with this email. */
  outcome: Extract<EmailOutcome, "matched" | "created" | "review" | "ignored">;
  reviewReason: ReviewReason | null;
  /** Jobs the matcher considered (any status, best first). */
  candidates: Job[];
  /**
   * Why the email counts as job related: strong items first (any one is enough), then weak
   * ones (two different kinds are needed); "bulk" when bulk-mail headers cancelled a weak item;
   * last, the kind of noise it is (src/lib/inbox/pipeline/noise.ts), which overrides the rest.
   */
  evidence: Array<
    | "thread" // strong: another email of the thread is linked to a job
    | "sender_history" // strong: mail from this address (not a platform's) was linked to a job before
    | "sender_domain" // strong: the sender's domain is a job's company (weak in bulk mail, not one of the two kinds)
    | "ats_sender" // strong: sent by an applicant-tracking system
    | "applied_phrase" // strong: an "applied" keyword next to a word such as "Bewerbung" (alone it counts as "keyword")
    | "keyword" // weak: any other keyword
    | "hint" // weak: a word such as "application" or "Bewerbung"
    | "company_named" // weak: a job's company is named
    | "board_sender" // weak: sent by a job board
    | "bulk" // bulk-mail headers (cancel one weak item)
    | "portal_mail" // a career portal's housekeeping (verification code, account, password): linked quietly or dropped
    | "job_advert" // a job board advertising jobs: dropped
    | "study_application" // about a place at a university, not a job: dropped
  >;
  /** 0..1 how sure the pipeline is (stored as Email.confidence). */
  confidence: number;
  /** What to write. */
  effect:
    | { kind: "ignore" }
    /** Link to the job and set its status to `to`; `from` is its status now (equal: link only). */
    | { kind: "link"; jobId: string; from: Status; to: Status }
    /** A new job in `status`: "applied" from a confirmation, a later stage from the first mail about an unknown application. */
    | { kind: "create"; company: string; title: string; status: KeywordRule["status"] }
    | { kind: "review"; reason: ReviewReason; suggestedJobIds: string[]; suggestedStatus: Status | null };
}

export interface ClassifyInput {
  fromName?: string;
  fromAddress: string;
  subject: string;
  body: string;
}

export interface InboxCheckResult {
  checkedAt: string;
  /** "running": a sync was still going after the wait (a first scan, or one that was already running). */
  state: "done" | "running";
  /** Messages looked at in this run (job related or not). */
  scanned: number;
  /** Job-related mail stored in this run. */
  processed: Email[];
  noResponseMarked: Job[];
}

/**
 * POST /api/inbox/check?dryRun=1 (development only): what the next sync would do with the
 * mailbox, with nothing written (src/lib/server/inbox/sync/dry-run.ts).
 */
export interface InboxDryRunResult {
  dryRun: true;
  checkedAt: string;
  /** "full_scan": the first scan, a resumed one, or a re-scan after an expired position. */
  mode: "full_scan" | "incremental";
  /** The scan window's start (full scan only). */
  after: string | null;
  /** Messages the listing returned. */
  listed: number;
  /** Of those, done in an earlier run (in the ledger): a real run skips them too. */
  alreadyDone: number;
  /** The most messages one dry run fetches. */
  fetchLimit: number;
  fetched: number;
  /** Left out because of fetchLimit. */
  notFetched: number;
  skipped: { label: number; ownAddress: number; gone: number };
  ignored: number;
  /** Job-related mail by what a real run would do with it. */
  outcomes: { matched: number; created: number; review: number };
  reviewReasons: Partial<Record<ReviewReason, number>>;
  /** Fetches that failed, by error code. */
  failed: Record<string, number>;
  /** At most 50 examples: job-related mail first, then ignored mail, oldest first. */
  sample: InboxDryRunSample[];
  /** What the numbers do not show. */
  notes: string[];
}

export interface InboxDryRunSample {
  receivedAt: string;
  /** Cut to 80 characters. */
  subject: string;
  outcome: ClassifyResult["outcome"];
  reviewReason: ReviewReason | null;
  /** The matched job's company, a review's first suggestion, or the company a confirmation would create. */
  company: string | null;
  /** The status a real run would set (matched, created) or suggest (review). */
  status: Status | null;
}

export type ReviewAction =
  | { action: "confirm" } // accept the suggestion (first suggested job + status)
  | { action: "assign"; jobId: string; status: Status }
  | { action: "create"; status: Status; company: string; title: string }
  | { action: "dismiss" };

export interface Stats {
  byStatus: Record<Status, number>;
  total: number;
  reviewCount: number;
}

/** The signed-in user (GET /api/me). */
export interface Me {
  email: string;
  name: string;
  pictureUrl: string | null;
  /**
   * The public demo only (absent, not null, everywhere else): the visitor's workspace, deleted
   * at `expiresAt` (ISO 8601) with everything in it.
   */
  demo?: { expiresAt: string };
}

/* -------------------------------------------------------- Chrome extension */
// The extension (extension/) and the API it talks to. Design: docs/plan/4-chrome-extension.md.

/**
 * What one of the extension's site readers (extension/src/page/sites/) found in a page's
 * markup. A reader fills only the fields it is sure of.
 */
export interface SiteFields {
  /** The posting's own link, when the tab's address is not it (a search page with a job open). */
  url?: string;
  title?: string;
  company?: string;
  location?: string;
  description?: string;
}

/**
 * What the extension reads from the open tab: POST /api/extension/read. Text, never the
 * page's HTML. The extension cuts it to the limits in docs/plan/4-chrome-extension.md.
 */
export interface PageSnapshot {
  /** The tab's address (http or https). */
  url: string;
  /** The page's `<link rel="canonical">`, or null. */
  canonicalUrl: string | null;
  /** document.title */
  title: string;
  /** og:title, og:site_name, og:description and description: the first of each, keys in lower case. */
  meta: Record<string, string>;
  /** The text of each `<script type="application/ld+json">`, in page order. */
  jsonLd: string[];
  /** The site reader that matched the page and what it found; null when none matched. */
  site: { reader: string; fields: SiteFields } | null;
  /** The text the user selected in the page ("" when none). A long selection becomes the description. */
  selection: string;
}

/** POST /api/extension/jobs: the add-job input; the capture method is always "extension". */
export type ExtensionJobInput = Omit<JobInput, "captureMethod">;

/** A browser the extension was connected in, with its own key (Settings, Chrome extension). */
export interface ExtensionKey {
  id: string;
  /** Where it was connected, e.g. "Chrome on Linux". Set by the connect page. */
  label: string;
  createdAt: string;
  /** Last request made with the key, updated at most every few minutes; null before the first. */
  lastUsedAt: string | null;
}

/**
 * POST /api/extension/keys, from the connect page (/extension/connect). The token goes to the
 * extension once; the server keeps only its hash.
 */
export interface ExtensionKeyCreated {
  key: ExtensionKey;
  token: string;
}

/** GET /api/extension: the Settings section. */
export interface ExtensionOverview {
  /** Version of the extension GET /api/extension/download serves; null when this server has no build of it. */
  version: string | null;
  keys: ExtensionKey[];
}

/** GET /api/extension/session, with the extension's key: who it adds jobs for. */
export interface ExtensionSession {
  email: string;
  name: string;
  /** As ExtensionOverview.version. The popup suggests an update when this is newer than its own. */
  latestVersion: string | null;
}
