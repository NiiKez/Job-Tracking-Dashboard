import { describe, expect, it } from "vitest";
import {
  classifyFetchFailure,
  classifyGmailResponse,
  GENERIC_MESSAGE,
  googleErrorReasons,
  INBOX_ERROR_CODES,
  inboxError,
  inboxErrorKind,
  inboxErrorMessage,
  isMailSourceError,
  isRetryable,
  MailSourceError,
  parseRetryAfter,
} from "@/lib/server/inbox/sync/errors";

const SECRET = "Request had insufficient authentication scopes for owner@example.com";

function body(status: number, reasons: string[], extra: Record<string, unknown> = {}) {
  return {
    error: {
      code: status,
      message: SECRET,
      errors: reasons.map((reason) => ({ reason, message: SECRET, domain: "global" })),
      ...extra,
    },
  };
}

describe("the pinned class", () => {
  it("keeps kind, code and retryAfterMs, and says only kind and code", () => {
    const err = new MailSourceError("temporary", "rate_limited", { retryAfterMs: 5_000 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("MailSourceError");
    expect(err.message).toBe("temporary: rate_limited");
    expect(err.retryAfterMs).toBe(5_000);
    expect(isMailSourceError(err)).toBe(true);
    expect(isMailSourceError(err, "setup")).toBe(false);
    expect(isMailSourceError(new Error("x"))).toBe(false);
  });
});

describe("codes", () => {
  it("every code has a kind and a fixed message", () => {
    expect(INBOX_ERROR_CODES.length).toBeGreaterThan(10);
    for (const code of INBOX_ERROR_CODES) {
      expect(code).toMatch(/^[a-z_]+$/);
      expect(inboxErrorKind(code)).toMatch(/^(history_expired|needs_reconnect|setup|temporary)$/);
      expect(inboxErrorMessage(code)).not.toBe(GENERIC_MESSAGE);
      expect(inboxErrorMessage(code).length).toBeGreaterThan(10);
      const err = inboxError(code);
      expect([err.kind, err.code]).toEqual([inboxErrorKind(code), code]);
    }
  });

  it("covers the plan's table", () => {
    expect(inboxErrorKind("history_expired")).toBe("history_expired");
    expect(inboxErrorKind("token_revoked")).toBe("needs_reconnect");
    expect(inboxErrorKind("token_rejected")).toBe("needs_reconnect");
    expect(inboxErrorKind("gmail_api_disabled")).toBe("setup");
    expect(inboxErrorKind("oauth_client_invalid")).toBe("setup");
    for (const code of ["rate_limited", "google_unavailable", "network", "timeout"]) {
      expect(inboxErrorKind(code)).toBe("temporary");
    }
  });

  it("an unknown or odd code gets the generic message", () => {
    for (const code of ["", "nope", "toString", "__proto__", "constructor"]) {
      expect(inboxErrorMessage(code)).toBe(GENERIC_MESSAGE);
      expect(inboxErrorKind(code)).toBeNull();
    }
  });

  it("only short-lived failures are retryable", () => {
    expect(isRetryable(inboxError("rate_limited"))).toBe(true);
    expect(isRetryable(inboxError("google_unavailable"))).toBe(true);
    expect(isRetryable(inboxError("network"))).toBe(true);
    expect(isRetryable(inboxError("timeout"))).toBe(true);
    for (const code of ["bad_request", "bad_response", "stopped", "token_rejected", "gmail_api_disabled", "history_expired"] as const) {
      expect(isRetryable(inboxError(code))).toBe(false);
    }
    expect(isRetryable(new Error("network"))).toBe(false);
  });
});

describe("googleErrorReasons", () => {
  it("reads errors[].reason, details[].reason and status, nothing else", () => {
    const reasons = googleErrorReasons(
      body(403, ["accessNotConfigured"], {
        status: "PERMISSION_DENIED",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
      }),
    );
    expect(reasons).toEqual(["accessNotConfigured", "SERVICE_DISABLED", "PERMISSION_DENIED"]);
    expect(reasons.join(" ")).not.toContain(SECRET);
  });

  it("is empty for anything that is not Google's error shape", () => {
    for (const value of [null, "text", [], { error: "invalid_grant" }, { error: { errors: "x" } }, { error: { errors: [null, 5] } }]) {
      expect(googleErrorReasons(value)).toEqual([]);
    }
  });
});

describe("classifyGmailResponse", () => {
  const cases: Array<[number, unknown, string, string]> = [
    [401, body(401, ["authError"]), "needs_reconnect", "token_rejected"],
    [403, body(403, ["accessNotConfigured"]), "setup", "gmail_api_disabled"],
    [403, { error: { code: 403, details: [{ reason: "SERVICE_DISABLED" }] } }, "setup", "gmail_api_disabled"],
    [403, body(403, ["rateLimitExceeded"]), "temporary", "rate_limited"],
    [403, body(403, ["userRateLimitExceeded"]), "temporary", "rate_limited"],
    [403, body(403, ["dailyLimitExceeded"]), "temporary", "rate_limited"],
    [403, body(403, ["insufficientPermissions"]), "needs_reconnect", "scope_missing"],
    [403, body(403, ["domainPolicy"]), "setup", "gmail_domain_policy"],
    [403, body(403, ["forbidden"]), "temporary", "gmail_forbidden"],
    [403, null, "temporary", "gmail_forbidden"],
    [429, body(429, ["rateLimitExceeded"]), "temporary", "rate_limited"],
    [429, null, "temporary", "rate_limited"],
    [500, body(500, ["backendError"]), "temporary", "google_unavailable"],
    [502, null, "temporary", "google_unavailable"],
    [503, null, "temporary", "google_unavailable"],
    [504, null, "temporary", "google_unavailable"],
    [408, null, "temporary", "timeout"],
    [404, body(404, ["notFound"]), "temporary", "not_found"],
    [400, body(400, ["invalidArgument"]), "temporary", "bad_request"],
    [410, null, "temporary", "bad_request"],
    [302, null, "temporary", "bad_response"],
    [204, null, "temporary", "bad_response"],
  ];

  it.each(cases)("%i %j → %s/%s", (status, errorBody, kind, code) => {
    const err = classifyGmailResponse(status, errorBody);
    expect([err.kind, err.code]).toEqual([kind, code]);
    expect(err.message).not.toContain(SECRET);
  });

  it("keeps Retry-After on rate limits and 5xx only", () => {
    expect(classifyGmailResponse(429, null, 3_000).retryAfterMs).toBe(3_000);
    expect(classifyGmailResponse(403, body(403, ["rateLimitExceeded"]), 3_000).retryAfterMs).toBe(3_000);
    expect(classifyGmailResponse(503, null, 3_000).retryAfterMs).toBe(3_000);
    expect(classifyGmailResponse(403, body(403, ["accessNotConfigured"]), 3_000).retryAfterMs).toBeNull();
  });
});

describe("classifyFetchFailure", () => {
  it("stopped wins over a timeout, which wins over a network error", () => {
    const cause = new TypeError("fetch failed");
    expect(classifyFetchFailure(cause, { stopped: true, timedOut: true }).code).toBe("stopped");
    expect(classifyFetchFailure(cause, { stopped: false, timedOut: true }).code).toBe("timeout");
    const network = classifyFetchFailure(cause, { stopped: false, timedOut: false });
    expect([network.kind, network.code]).toEqual(["temporary", "network"]);
    expect(network.cause).toBe(cause);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.UTC(2026, 10, 16, 12, 0, 0);

  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
    expect(parseRetryAfter("Mon, 16 Nov 2026 12:00:45 GMT", now)).toBe(45_000);
    expect(parseRetryAfter("Mon, 16 Nov 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("is null when missing or unreadable, and capped at a day", () => {
    for (const value of [null, undefined, "", "soon", "-5", "1.5", "12abc"]) {
      expect(parseRetryAfter(value, now)).toBeNull();
    }
    expect(parseRetryAfter("9999999999", now)).toBe(86_400_000);
  });
});
