import { describe, expect, it } from "vitest";
import {
  CONNECT_ERROR_FALLBACK,
  CONNECT_ERROR_TEXT,
  checkResultToast,
  connectResultToast,
  disconnectResultToast,
  GOOGLE_PERMISSIONS_URL,
  scanProgressText,
  withoutConnectResult,
} from "@/components/email/inbox-copy";
import type { Email, InboxCheckResult, Job } from "@/lib/types";

// src/components/email/inbox-copy.ts: the fixed text the screens show about the inbox.

const params = (qs: string) => new URLSearchParams(qs);
const inbox = { address: "someone@example.com" };

describe("connectResultToast", () => {
  it("confirms a connection with the address", () => {
    expect(connectResultToast(params("inbox=connected"), inbox)).toEqual({
      kind: "success",
      title: "Inbox connected",
      description: "someone@example.com",
    });
    expect(connectResultToast(params("inbox=connected"), { address: null })?.description).toBeUndefined();
  });

  it.each([
    "denied",
    "scope_missing",
    "account_mismatch",
    "gmail_api_disabled",
    "state",
    "exchange_failed",
    "not_configured",
    "demo_gmail",
  ])("has its own text for the callback's reason %s", (reason) => {
    const copy = connectResultToast(params(`inbox=error&reason=${reason}`), inbox);
    expect(copy?.kind).toBe("error");
    expect(copy?.description).toBe(CONNECT_ERROR_TEXT.get(reason));
    expect(copy?.description).not.toBe(CONNECT_ERROR_FALLBACK);
  });

  it.each(["", "reason=", "reason=constructor", "reason=__proto__", "reason=<b>Call+us</b>", "reason=toString"])(
    "never echoes an unknown reason (%s)",
    (extra) => {
      const copy = connectResultToast(params(`inbox=error&${extra}`), inbox);
      expect(copy).toEqual({
        kind: "error",
        title: "Couldn't connect Gmail",
        description: CONNECT_ERROR_FALLBACK,
      });
    },
  );

  it("is silent without a connect result", () => {
    expect(connectResultToast(params(""), inbox)).toBeNull();
    expect(connectResultToast(params("inbox=maybe"), inbox)).toBeNull();
    expect(connectResultToast(params("reason=denied"), inbox)).toBeNull();
  });

  it("keeps every text short and plain", () => {
    for (const text of [...CONNECT_ERROR_TEXT.values(), CONNECT_ERROR_FALLBACK]) {
      expect(text.length).toBeLessThan(110);
      expect(text).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe("disconnectResultToast", () => {
  it("confirms the disconnect when Google confirmed the revocation (or there was nothing to revoke)", () => {
    expect(disconnectResultToast({ revoked: true })).toEqual({
      kind: "success",
      title: "Inbox disconnected",
      description: "Syncing has stopped.",
    });
  });

  it("says Google didn't confirm, and links to the Google Account to remove the access there", () => {
    const copy = disconnectResultToast({ revoked: false });
    expect(copy.kind).toBe("warning");
    expect(copy.title).toBe("Inbox disconnected");
    expect(copy.description).toMatch(/stopped reading your mail/);
    expect(copy.description).toMatch(/Google didn't confirm/);
    expect(copy.link).toEqual({ label: "myaccount.google.com/permissions", href: GOOGLE_PERMISSIONS_URL });
    expect(GOOGLE_PERMISSIONS_URL).toBe("https://myaccount.google.com/permissions");
  });

  it("does not claim a revocation the answer doesn't state", () => {
    expect(disconnectResultToast({} as { revoked: boolean }).kind).toBe("warning");
  });
});

describe("withoutConnectResult", () => {
  const url = (s: string) => new URL(s, "https://jobs.example.com");

  it("drops inbox and reason, and keeps the rest", () => {
    expect(withoutConnectResult(url("/settings?inbox=error&reason=denied"))).toBe("/settings");
    expect(withoutConnectResult(url("/settings?inbox=connected"))).toBe("/settings");
    expect(withoutConnectResult(url("/settings?tab=x&inbox=connected#inbox"))).toBe("/settings?tab=x#inbox");
  });

  it("leaves an address without a connect result alone", () => {
    expect(withoutConnectResult(url("/settings"))).toBeNull();
    expect(withoutConnectResult(url("/settings?reason=x#inbox"))).toBeNull();
  });
});

describe("scanProgressText", () => {
  it("counts against the total", () => {
    expect(scanProgressText({ done: 120, total: 400 })).toBe("Scanning recent mail: 120 of 400 messages");
    expect(scanProgressText({ done: 0, total: 1 })).toBe("Scanning recent mail: 0 of 1 message");
    expect(scanProgressText({ done: 1200, total: 4000 })).toBe(
      "Scanning recent mail: 1,200 of 4,000 messages",
    );
  });

  it("works without a total yet", () => {
    expect(scanProgressText({ done: 0, total: null })).toBe("Scanning recent mail…");
    expect(scanProgressText({ done: 1, total: null })).toBe("Scanning recent mail: 1 message so far");
    expect(scanProgressText({ done: 37, total: null })).toBe("Scanning recent mail: 37 messages so far");
  });

  it("never shows more done than the total, or odd numbers", () => {
    expect(scanProgressText({ done: 410, total: 400 })).toBe("Scanning recent mail: 410 of 410 messages");
    expect(scanProgressText({ done: -3, total: 10 })).toBe("Scanning recent mail: 0 of 10 messages");
    expect(scanProgressText({ done: Number.NaN, total: 10 })).toBe("Scanning recent mail: 0 of 10 messages");
  });
});

describe("checkResultToast", () => {
  const email = (outcome: Email["outcome"]) => ({ outcome }) as Email;
  const result = (patch: Partial<InboxCheckResult>): InboxCheckResult => ({
    checkedAt: "2026-11-17T09:00:00.000Z",
    state: "done",
    scanned: 0,
    processed: [],
    noResponseMarked: [],
    ...patch,
  });

  it("says a sync is still going", () => {
    expect(checkResultToast(result({ state: "running", scanned: 40 }))).toEqual({
      kind: "info",
      title: "Still checking…",
      description: "New mail will appear shortly.",
    });
  });

  it("says what was read when nothing was about a job", () => {
    expect(checkResultToast(result({})).description).toBe("No new job emails.");
    expect(checkResultToast(result({ scanned: 1 })).description).toBe("1 new email, not about a job.");
    expect(checkResultToast(result({ scanned: 12 }))).toEqual({
      kind: "info",
      title: "Inbox is up to date",
      description: "12 new emails, none about a job.",
    });
  });

  it("sums up what changed", () => {
    const copy = checkResultToast(
      result({
        scanned: 30,
        processed: [email("matched"), email("created"), email("review")],
        noResponseMarked: [{} as Job],
      }),
    );
    expect(copy).toEqual({
      kind: "success",
      title: "Inbox checked",
      description: "3 new emails · 2 updated a job · 1 need review · 1 marked no response",
    });
  });
});
