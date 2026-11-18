import "server-only";
import { createAccessTokens } from "@/lib/server/inbox/oauth/google-tokens";
import { inboxError } from "@/lib/server/inbox/sync/errors";
import { createPacer, type Pacer } from "@/lib/server/inbox/sync/pace";
import { createGmailClient, type AccessTokenProvider, type FetchLike, type GmailClient } from "./gmail-client";
import type { MailSource } from "./types";

/**
 * MailSource over the Gmail REST API (docs/plan/2-gmail-ingest.md, "Sync"), for one mailbox:
 *
 *   createGmailSource({ getRefreshToken, signal })   with a token cache of its own
 *   createGmailSource({ accessTokens, signal })      with a token provider given: the sync engine
 *                                                    passes the connection's cache
 *                                                    (source/index.ts), the connect callback
 *                                                    fixedAccessToken(token)
 *
 * - listMessageIds(after): messages.list with q=FIRST_SCAN_QUERY (after: in epoch seconds, as a
 *   date would be read as midnight Pacific time), 500 a page, every page, ids deduplicated.
 * - listAddedSince(start): history.list with historyTypes=messageAdded, 500 a page, every page,
 *   no labelId filter (a user's own filters can skip the inbox), ids deduplicated. Answers the
 *   last page's historyId. A 404, or a start id that is not a history id, is history_expired.
 *   Messages whose history record already carries SENT, DRAFT, CHAT, SPAM or TRASH are left out,
 *   as the first scan's query leaves them out: each would cost a 60-unit messages.get only to be
 *   skipped (every saved draft is a new message). The engine still checks the labels of every
 *   message it fetches.
 * - getMessage / getAttachment: null when Gmail answers 404.
 *
 * Every failure is a MailSourceError. Errors from `getRefreshToken` itself (the database, the
 * token decryption) pass through unchanged: the engine maps them.
 */

/** Pagination guards: a page token seen twice, or more pages than any mailbox needs, is bad_response. */
export const MAX_PAGES = 2_000;
/** Labels the first scan's query leaves out (in:sent, in:drafts, in:chats; spam and trash by default). */
const SKIPPED_LABELS = new Set(["SENT", "DRAFT", "CHAT", "SPAM", "TRASH"]);

export type GmailSourceOptions = {
  /** Ends every wait and request: they throw MailSourceError("temporary", "stopped"). */
  signal?: AbortSignal;
  /** Default: a new pacer (quota, 3 at a time, retries). Share one per mailbox if runs overlap. */
  pacer?: Pacer;
  /** Test seams. */
  fetch?: FetchLike;
  timeoutMs?: number;
} & (
  | { getRefreshToken: () => Promise<string>; accessTokens?: undefined }
  | { accessTokens: AccessTokenProvider; getRefreshToken?: undefined }
);

/** The first scan's search: received after `after` (whole epoch seconds), no sent mail, drafts or chats. */
export function firstScanQuery(after: Date): string {
  const seconds = Math.floor(after.getTime() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new TypeError("firstScanQuery: invalid date");
  return `after:${seconds} -in:sent -in:drafts -in:chats`;
}

export function createGmailSource(opts: GmailSourceOptions): MailSource {
  const accessTokens = opts.accessTokens ?? createAccessTokens(opts.getRefreshToken);
  const client = createGmailClient({
    accessTokens,
    pacer: opts.pacer ?? createPacer(),
    signal: opts.signal,
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs,
  });
  return gmailSourceOver(client);
}

/** The MailSource logic over any GmailClient. */
export function gmailSourceOver(client: GmailClient): MailSource {
  return {
    getProfile: () => client.getProfile(),

    async listMessageIds(after) {
      const q = firstScanQuery(after);
      const ids = new Set<string>();
      await eachPage(async (pageToken) => {
        const page = await client.listMessages(q, pageToken);
        for (const id of page.messageIds) ids.add(id);
        return page.nextPageToken;
      });
      return [...ids];
    },

    async listAddedSince(startHistoryId) {
      // A stored position that is not a history id cannot be continued: scan again.
      if (typeof startHistoryId !== "string" || !/^\d{1,20}$/.test(startHistoryId)) {
        throw inboxError("history_expired");
      }
      const ids = new Set<string>();
      let historyId = "";
      await eachPage(async (pageToken) => {
        const page = await client.listHistory(startHistoryId, pageToken);
        if (!page) throw inboxError("history_expired");
        for (const added of page.added) {
          if (!added.labelIds.some((label) => SKIPPED_LABELS.has(label))) ids.add(added.id);
        }
        historyId = page.historyId;
        return page.nextPageToken;
      });
      return { messageIds: [...ids], historyId };
    },

    getMessage: (id) => client.getMessage(id),
    getAttachment: (messageId, attachmentId) => client.getAttachment(messageId, attachmentId),
  };
}

/** Calls `fetchPage` with each page token in turn until there is none. */
async function eachPage(fetchPage: (pageToken: string | null) => Promise<string | null>) {
  const seen = new Set<string>();
  let pageToken: string | null = null;
  for (let pages = 0; ; pages++) {
    if (pages >= MAX_PAGES) throw inboxError("bad_response");
    pageToken = await fetchPage(pageToken);
    if (pageToken === null) return;
    if (seen.has(pageToken)) throw inboxError("bad_response");
    seen.add(pageToken);
  }
}
