import type { InboxCheckResult, InboxState, Settings } from "@/lib/types";

/**
 * What the screens say about the mailbox connection. Fixed text only: nothing here repeats a value
 * from the URL or from Google. An unknown ?reason= gets the generic line; the sync error line is
 * the server's own fixed text (Settings.inbox.lastError.message).
 *
 * Pure (no React, no DOM), so it is unit tested in tests/unit/inbox-copy.test.ts.
 */

export const INBOX_STATE_LABEL: Record<InboxState, string> = {
  not_connected: "Not connected",
  connected: "Connected",
  needs_reconnect: "Needs reconnecting",
};

/**
 * A toast to show: the sonner method, a title, an optional second line, and an optional link
 * after it (a toast with a link stays until it is closed, so there is time to follow it).
 */
export interface ToastCopy {
  kind: "success" | "info" | "warning" | "error";
  title: string;
  description?: string;
  link?: { label: string; href: string };
}

/** Where a Google Account lists the apps that have access to it, and removes them. */
export const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

/**
 * The toast after Disconnect (POST /api/inbox/disconnect). The stored token is deleted either
 * way, so the app reads no more mail; unless Google confirmed the revocation (`revoked` true),
 * the access may still be listed in the Google Account, and the toast links there.
 */
export function disconnectResultToast(res: { revoked: boolean }): ToastCopy {
  if (res.revoked === true) {
    return { kind: "success", title: "Inbox disconnected", description: "Syncing has stopped." };
  }
  return {
    kind: "warning",
    title: "Inbox disconnected",
    description:
      "The app has stopped reading your mail, but Google didn't confirm that its access was removed. Remove it in your Google Account:",
    link: { label: "myaccount.google.com/permissions", href: GOOGLE_PERMISSIONS_URL },
  };
}

/**
 * The ?reason= codes of /api/inbox/callback, and demo_gmail from /api/inbox/connect in demo mode
 * (docs/plan/2-gmail-ingest.md, "Connecting"). A Map, not an object, so a reason such as
 * "constructor" can't reach a prototype property.
 */
export const CONNECT_ERROR_TEXT: ReadonlyMap<string, string> = new Map([
  ["denied", "You cancelled, or didn't allow access to Gmail."],
  ["scope_missing", "The Gmail permission wasn't ticked. Connect again and tick it on Google's screen."],
  ["account_mismatch", "That's another Google account. Connect the Gmail of the account you're signed in with."],
  ["gmail_api_disabled", "The Gmail API is turned off in this server's Google Cloud project. Turn it on, then try again."],
  ["state", "The connection attempt expired. Try again."],
  ["exchange_failed", "Google didn't confirm the connection. Try again."],
  ["not_configured", "Gmail isn't set up on this server yet."],
  ["demo_gmail", "This server reads demo mail, and your Gmail connection stays as it is."],
]);

export const CONNECT_ERROR_FALLBACK = "The connection didn't finish. Try again.";

/**
 * The toast for Google's redirect back to Settings: ?inbox=connected, or ?inbox=error&reason=<code>.
 * Null when the URL carries no connect result.
 */
export function connectResultToast(
  params: URLSearchParams,
  inbox: Pick<Settings["inbox"], "address">,
): ToastCopy | null {
  switch (params.get("inbox")) {
    case "connected":
      return { kind: "success", title: "Inbox connected", description: inbox.address ?? undefined };
    case "error":
      return {
        kind: "error",
        title: "Couldn't connect Gmail",
        description: CONNECT_ERROR_TEXT.get(params.get("reason") ?? "") ?? CONNECT_ERROR_FALLBACK,
      };
    default:
      return null;
  }
}

/**
 * The address without the connect result (?inbox= and ?reason=), keeping the other parameters
 * and the hash; null when there is nothing to remove. A reload must not repeat the toast.
 */
export function withoutConnectResult(url: URL): string | null {
  if (!url.searchParams.has("inbox")) return null;
  const params = new URLSearchParams(url.search);
  params.delete("inbox");
  params.delete("reason");
  const qs = params.toString();
  return `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`;
}

/** A count from the server as a whole, non-negative number. */
const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

/** "1,204" */
const count = (n: number) => n.toLocaleString("en-GB");

const messages = (n: number) => (n === 1 ? "message" : "messages");

/**
 * The progress of the first scan, or of a full re-scan after an expired sync position (which
 * covers a shorter window, so the text names none): "Scanning recent mail: 120 of 400 messages".
 */
export function scanProgressText(backfill: { done: number; total: number | null }): string {
  const lead = "Scanning recent mail";
  const done = whole(backfill.done);
  if (backfill.total === null) {
    return done > 0 ? `${lead}: ${count(done)} ${messages(done)} so far` : `${lead}…`;
  }
  // The total is a listing taken at the start; never show "410 of 400".
  const total = Math.max(whole(backfill.total), done);
  return `${lead}: ${count(done)} of ${count(total)} ${messages(total)}`;
}

/** The toast after "Sync now" (POST /api/inbox/check). */
export function checkResultToast(res: InboxCheckResult): ToastCopy {
  if (res.state === "running") {
    return { kind: "info", title: "Still checking…", description: "New mail will appear shortly." };
  }
  const processed = res.processed.length;
  const marked = res.noResponseMarked.length;
  if (!processed && !marked) {
    // Mail that isn't about a job isn't kept, so this line is the only sign it was read.
    const description =
      res.scanned > 1
        ? `${count(whole(res.scanned))} new emails, none about a job.`
        : res.scanned === 1
          ? "1 new email, not about a job."
          : "No new job emails.";
    return { kind: "info", title: "Inbox is up to date", description };
  }
  const moved = res.processed.filter((e) => e.outcome === "matched" || e.outcome === "created").length;
  const review = res.processed.filter((e) => e.outcome === "review").length;
  const parts = [
    `${processed} new email${processed === 1 ? "" : "s"}`,
    moved ? `${moved} updated a job` : null,
    review ? `${review} need review` : null,
    marked ? `${marked} marked no response` : null,
  ].filter(Boolean);
  return { kind: "success", title: "Inbox checked", description: parts.join(" · ") };
}
