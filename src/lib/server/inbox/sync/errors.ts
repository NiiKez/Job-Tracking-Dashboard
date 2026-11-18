import "server-only";

/**
 * Failures of a mail source, Google's token endpoint or a sync run, sorted by what the app does
 * about them (docs/plan/2-gmail-ingest.md, "Token errors"):
 *
 *   history_expired  history.list answered 404: the sync position is too old. Run a full scan.
 *   needs_reconnect  invalid_grant, or a 401 straight after a refresh. The connection becomes
 *                    needs_reconnect; the scheduler skips it and Settings shows Reconnect.
 *   setup            invalid_client, or 403 accessNotConfigured: the Google project is not set
 *                    up. Shown as a setup problem.
 *   temporary        429, 403 rate limits, 5xx, network errors, timeouts. Wait and retry.
 *
 * `code` is a short, stable identifier (e.g. "gmail_api_disabled") stored as
 * inbox_connections.last_error_code and turned into on-screen text by a fixed code-to-message
 * map. Never put Google's response text in a message, a code or a log line.
 *
 * API (below the pinned class)
 *   INBOX_ERROR_CODES, InboxErrorCode     every code this app raises, each with one kind
 *   inboxError(code, opts?)               a MailSourceError whose kind comes from the code
 *   inboxErrorKind(code)                  the kind of a known code, or null
 *   inboxErrorMessage(code)               the fixed on-screen text (a generic one for unknown codes)
 *   isRetryable(err)                      a temporary error worth retrying within the same run
 *   classifyGmailResponse(status, body, retryAfterMs)
 *                                         a Gmail API error response → MailSourceError
 *                                         (404 is the caller's business: it means different things)
 *   classifyFetchFailure(cause, how)      a failed request (stopped, timed out or network)
 *   googleErrorReasons(body)              the `reason` values of a Google error body
 *   parseRetryAfter(value, nowMs)         a Retry-After header → milliseconds, or null
 */
export type MailErrorKind = "history_expired" | "needs_reconnect" | "setup" | "temporary";

export class MailSourceError extends Error {
  readonly kind: MailErrorKind;
  readonly code: string;
  /** For "temporary": how long Google asked us to wait (Retry-After), if it said. */
  readonly retryAfterMs: number | null;

  constructor(kind: MailErrorKind, code: string, opts: { retryAfterMs?: number | null; cause?: unknown } = {}) {
    super(`${kind}: ${code}`, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "MailSourceError";
    this.kind = kind;
    this.code = code;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

/**
 * A MailSourceError, also one from another copy of this module: Next.js bundles
 * src/instrumentation.ts (the scheduler, and its copy of the engine) apart from the routes, and a
 * route that joins a run the scheduler started gets that copy's errors. So `instanceof` alone is
 * not enough; the name and the two fields decide.
 */
export function isMailSourceError(err: unknown, kind?: MailErrorKind): err is MailSourceError {
  const like =
    err instanceof MailSourceError ||
    (err instanceof Error &&
      err.name === "MailSourceError" &&
      typeof (err as { kind?: unknown }).kind === "string" &&
      typeof (err as { code?: unknown }).code === "string");
  return like && (kind === undefined || (err as MailSourceError).kind === kind);
}

/* ------------------------------------------------------------------ codes */

interface CodeInfo {
  kind: MailErrorKind;
  message: string;
}

/**
 * Every code, its kind and the text Settings shows for it. The text is written here, never taken
 * from Google. Codes are stored in the database: rename one only with a migration of old rows
 * (an unknown stored code still shows GENERIC_MESSAGE).
 */
const CODES = {
  history_expired: {
    kind: "history_expired",
    message: "Gmail's sync position expired, so recent mail is being scanned again.",
  },

  // needs_reconnect
  token_revoked: {
    kind: "needs_reconnect",
    message:
      "Google no longer accepts this app's access to your mailbox (it was removed, it expired, or your password changed). Reconnect Gmail.",
  },
  token_rejected: {
    kind: "needs_reconnect",
    message: "Gmail rejected this app's access to your mailbox. Reconnect Gmail.",
  },
  scope_missing: {
    kind: "needs_reconnect",
    message: "This app may not read your Gmail. Reconnect Gmail and allow it to read your mail.",
  },
  token_unreadable: {
    kind: "needs_reconnect",
    message: "The stored Gmail access cannot be read with the server's current key. Reconnect Gmail.",
  },

  // setup
  gmail_api_disabled: {
    kind: "setup",
    message: "The Gmail API is not enabled in this app's Google Cloud project.",
  },
  oauth_client_invalid: {
    kind: "setup",
    message: "Google rejected this app's OAuth client. Check the Google client ID and secret on the server.",
  },
  gmail_domain_policy: {
    kind: "setup",
    message: "Your Google Workspace administrator does not allow this app to read Gmail.",
  },
  google_not_configured: {
    kind: "setup",
    message: "Google sign-in is not configured on the server.",
  },
  token_key_missing: {
    kind: "setup",
    message: "The server has no key for Gmail tokens (INBOX_TOKEN_KEY), so Gmail cannot be used.",
  },
  // MAIL_SOURCE=fixture (source/fixture-source.ts)
  fixtures_missing: {
    kind: "setup",
    message: "The demo mail folder (fixtures/mail) is missing on the server.",
  },
  fixture_invalid: {
    kind: "setup",
    message: "A demo mail file in fixtures/mail could not be read.",
  },

  // temporary, retried within the run (RETRYABLE below)
  rate_limited: {
    kind: "temporary",
    message: "Gmail asked this app to slow down. It will try again shortly.",
  },
  google_unavailable: {
    kind: "temporary",
    message: "Google's servers had a problem. The app will try again.",
  },
  network: {
    kind: "temporary",
    message: "The server could not reach Google. It will try again.",
  },
  timeout: {
    kind: "temporary",
    message: "Google did not answer in time. The app will try again.",
  },

  // temporary, not retried within the run: the run ends, and the next one tries again
  bad_request: {
    kind: "temporary",
    message: "Gmail refused a request from this app. It will try again later.",
  },
  gmail_forbidden: {
    kind: "temporary",
    message: "Gmail refused access to your mailbox. The app will try again later.",
  },
  not_found: {
    kind: "temporary",
    message: "Gmail could not find something this app asked for. It will try again later.",
  },
  bad_response: {
    kind: "temporary",
    message: "Google sent an answer this app could not read. It will try again later.",
  },
  response_too_large: {
    kind: "temporary",
    message: "A message in your mailbox is too large for this app to read.",
  },
  token_refresh_failed: {
    kind: "temporary",
    message: "Google could not renew this app's access to your mailbox. It will try again later.",
  },
  stopped: {
    kind: "temporary",
    message: "The inbox check was stopped before it finished. It will continue next time.",
  },
} as const satisfies Record<string, CodeInfo>;

export type InboxErrorCode = keyof typeof CODES;

export const INBOX_ERROR_CODES = Object.freeze(Object.keys(CODES)) as readonly InboxErrorCode[];

/** Shown for a stored code this version does not know. */
export const GENERIC_MESSAGE = "Something went wrong while checking Gmail.";

/** Temporary failures that may clear within seconds: the pacer retries them with backoff. */
const RETRYABLE: ReadonlySet<string> = new Set<InboxErrorCode>(["rate_limited", "google_unavailable", "network", "timeout"]);

function isKnownCode(code: string): code is InboxErrorCode {
  return Object.hasOwn(CODES, code);
}

/** A MailSourceError for one of this app's codes, with the code's kind. */
export function inboxError(
  code: InboxErrorCode,
  opts: { retryAfterMs?: number | null; cause?: unknown } = {},
): MailSourceError {
  return new MailSourceError(CODES[code].kind, code, opts);
}

/** The kind of a known code, or null. */
export function inboxErrorKind(code: string): MailErrorKind | null {
  return isKnownCode(code) ? CODES[code].kind : null;
}

/** The on-screen text for a code (as stored in last_error_code). Never Google's own text. */
export function inboxErrorMessage(code: string): string {
  return isKnownCode(code) ? CODES[code].message : GENERIC_MESSAGE;
}

/** A temporary failure worth retrying with backoff inside the same run. */
export function isRetryable(err: unknown): err is MailSourceError {
  return isMailSourceError(err, "temporary") && RETRYABLE.has(err.code);
}

/* ---------------------------------------------------------- classification */

// Google's `errors[].reason` (Gmail's documented values) and, in newer error bodies,
// `details[].reason` of a google.rpc.ErrorInfo. Matched case-sensitively, as Google sends them.
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
  "quotaExceeded",
  "RATE_LIMIT_EXCEEDED",
]);
const API_DISABLED_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED"]);
const SCOPE_REASONS = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);
const DOMAIN_POLICY_REASONS = new Set(["domainPolicy"]);

const MAX_REASONS = 20;
const MAX_REASON_LENGTH = 100;

/**
 * The `reason` values in a Google error body:
 * `{ "error": { "errors": [{ "reason": … }], "details": [{ "reason": … }], "status": … } }`.
 * Only these identifiers are read; `message` is never looked at.
 */
export function googleErrorReasons(body: unknown): string[] {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (!error) return [];
  const reasons: string[] = [];
  for (const list of [error.errors, error.details]) {
    if (!Array.isArray(list)) continue;
    for (const item of list.slice(0, MAX_REASONS)) {
      if (isRecord(item) && typeof item.reason === "string" && item.reason.length <= MAX_REASON_LENGTH) {
        reasons.push(item.reason);
      }
    }
  }
  if (typeof error.status === "string" && error.status.length <= MAX_REASON_LENGTH) reasons.push(error.status);
  return reasons;
}

/**
 * A Gmail API error response as a MailSourceError (the plan's "Token errors" table):
 *
 *   401                                  needs_reconnect token_rejected (the client refreshes
 *                                        once before it gives up; see gmail-client.ts)
 *   403 accessNotConfigured              setup gmail_api_disabled
 *   403 insufficientPermissions          needs_reconnect scope_missing
 *   403 domainPolicy                     setup gmail_domain_policy
 *   403 rate limits, 429                 temporary rate_limited (with Retry-After)
 *   403 anything else                    temporary gmail_forbidden
 *   408                                  temporary timeout
 *   5xx                                  temporary google_unavailable (with Retry-After)
 *   404                                  temporary not_found: callers that expect a 404 handle
 *                                        it before calling this
 *   other 4xx                            temporary bad_request
 *   anything else                        temporary bad_response
 */
export function classifyGmailResponse(status: number, body: unknown, retryAfterMs: number | null = null): MailSourceError {
  const reasons = googleErrorReasons(body);
  const has = (set: ReadonlySet<string>) => reasons.some((r) => set.has(r));

  if (status === 401) return inboxError("token_rejected");
  if (status === 429) return inboxError("rate_limited", { retryAfterMs });
  if (status === 403) {
    if (has(API_DISABLED_REASONS)) return inboxError("gmail_api_disabled");
    if (has(RATE_LIMIT_REASONS)) return inboxError("rate_limited", { retryAfterMs });
    if (has(SCOPE_REASONS)) return inboxError("scope_missing");
    if (has(DOMAIN_POLICY_REASONS)) return inboxError("gmail_domain_policy");
    return inboxError("gmail_forbidden");
  }
  if (status === 404) return inboxError("not_found");
  if (status === 408) return inboxError("timeout");
  if (status >= 500 && status <= 599) return inboxError("google_unavailable", { retryAfterMs });
  if (status >= 400 && status <= 499) return inboxError("bad_request");
  return inboxError("bad_response");
}

/**
 * A request that produced no response. `stopped`: the caller's AbortSignal fired (shutdown or
 * disconnect). `timedOut`: our own deadline. Otherwise a network error. The cause is kept for
 * debugging but never logged by this module.
 */
export function classifyFetchFailure(cause: unknown, how: { stopped: boolean; timedOut: boolean }): MailSourceError {
  if (how.stopped) return inboxError("stopped", { cause });
  if (how.timedOut) return inboxError("timeout", { cause });
  return inboxError("network", { cause });
}

/** Longest Retry-After taken at face value; anything longer is cut to this. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * A Retry-After header (seconds, or an HTTP date) as milliseconds from `nowMs`, or null when it
 * is missing or unreadable. A date in the past is 0.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (value == null) return null;
  const text = value.trim();
  if (text === "") return null;
  let ms: number;
  if (/^\d{1,10}$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const at = Date.parse(text);
    if (!Number.isFinite(at) || !/[a-z]/i.test(text)) return null;
    ms = Math.max(0, at - nowMs);
  }
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
