import "server-only";
import { z } from "zod";
import {
  classifyFetchFailure,
  classifyGmailResponse,
  inboxError,
  isMailSourceError,
  parseRetryAfter,
} from "@/lib/server/inbox/sync/errors";
import type { GmailMethod, Pacer } from "@/lib/server/inbox/sync/pace";
import type { GmailHeader, GmailMessage, GmailPart, GmailPartBody, MailboxProfile } from "./types";

/**
 * The Gmail REST calls this app makes, with plain `fetch` (no Google SDK):
 *
 *   getProfile()                              users.getProfile
 *   listMessages(q, pageToken?)               users.messages.list, maxResults=500
 *   getMessage(id)                            users.messages.get, format=full; null on 404
 *   getAttachment(messageId, attachmentId)    users.messages.attachments.get; null on 404
 *   listHistory(startHistoryId, pageToken?)   users.history.list, historyTypes=messageAdded,
 *                                             maxResults=500; null on 404 (position expired)
 *
 * Every request goes through the pacer (quota, concurrency, retries) and has its own deadline.
 * Every failure is a MailSourceError with a stable code (sync/errors.ts); nothing Google writes
 * in an error body is kept except its `reason` identifiers.
 *
 * Tokens: each request asks `accessTokens` for a token. A 401 makes the client invalidate that
 * token and ask once more, which refreshes it; a second 401 straight after is
 * needs_reconnect/token_rejected. The token is only ever put in the Authorization header.
 *
 * Responses are read up to a size cap and checked: the fields the app reads must have the right
 * types. A list or a part tree is cleaned (entries with a wrong shape are dropped, depth and
 * counts are capped) rather than failed, but a message without its id, thread id or receive
 * time, or a page without what pagination needs, is bad_response.
 */

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Per request, from sending to the last byte of the body. */
export const REQUEST_TIMEOUT_MS = 30_000;
export const PAGE_SIZE = 500;

/** Body caps. A format=full message carries its text parts inline; large files come as attachment ids. */
export const MAX_SMALL_BODY_BYTES = 256 * 1024;
export const MAX_LIST_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_MESSAGE_BODY_BYTES = 24 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Part tree caps: deeper parts and parts past the count are dropped. */
export const MAX_PART_DEPTH = 32;
export const MAX_PARTS = 1_000;
const MAX_HEADERS_PER_PART = 1_000;
const MAX_HEADER_VALUE = 64 * 1024;
const MAX_LABELS = 500;
const MAX_SNIPPET = 2_000;
const MAX_PAGE_TOKEN = 4_096;

/** Gmail's message and thread ids: hex today; base64url characters accepted. */
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,256}$/;
/** Attachment ids are long opaque strings; these characters are all Gmail has been seen to use. */
const ATTACHMENT_ID = /^[A-Za-z0-9_\-.=~]{1,4096}$/;
const HISTORY_ID = /^\d{1,20}$/;

/** Where Gmail requests get their access token. google-tokens.ts implements it. */
export interface AccessTokenProvider {
  /** A valid access token: cached, or refreshed now. Throws MailSourceError. */
  get(signal?: AbortSignal): Promise<string>;
  /** Gmail answered 401 with `token`: forget it, so the next get() refreshes. */
  invalidate(token: string): void;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GmailClientOptions {
  accessTokens: AccessTokenProvider;
  pacer: Pacer;
  /** Ends every wait and request (shutdown, disconnect): they throw temporary/stopped. */
  signal?: AbortSignal;
  /** Test seams. */
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

export interface MessageListPage {
  messageIds: string[];
  nextPageToken: string | null;
}

export interface HistoryPage {
  /** Messages added, with the labels the history record gave them (may be empty). */
  added: Array<{ id: string; labelIds: string[] }>;
  /** The mailbox's history id when this page was read. */
  historyId: string;
  nextPageToken: string | null;
}

export interface GmailClient {
  getProfile(): Promise<MailboxProfile>;
  listMessages(q: string, pageToken?: string | null): Promise<MessageListPage>;
  getMessage(id: string): Promise<GmailMessage | null>;
  /** The attachment's data (base64url), or null when it no longer exists. */
  getAttachment(messageId: string, attachmentId: string): Promise<string | null>;
  /** null: Gmail answered 404, the start id is too old. */
  listHistory(startHistoryId: string, pageToken?: string | null): Promise<HistoryPage | null>;
}

/** A Gmail message id as the client accepts it in a URL. */
export function isGmailId(id: unknown): id is string {
  return typeof id === "string" && MESSAGE_ID.test(id);
}

export function createGmailClient(opts: GmailClientOptions): GmailClient {
  const { accessTokens, pacer, signal } = opts;
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const now = opts.now ?? Date.now;

  interface Call<T> {
    method: GmailMethod;
    path: string;
    params?: Record<string, string | null | undefined>;
    maxBytes: number;
    parse: (json: unknown) => T;
    /** What a 404 answers; without it a 404 throws not_found. */
    onNotFound?: () => T;
  }

  async function call<T>(c: Call<T>): Promise<T> {
    // Spaces as %20, not URLSearchParams' "+": the search query is passed exactly as written.
    const query = Object.entries(c.params ?? {})
      .filter((entry): entry is [string, string] => entry[1] != null)
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join("&");
    const url = `${GMAIL_API_BASE}/${c.path}${query ? `?${query}` : ""}`;
    return pacer.run(
      c.method,
      async () => {
        let token = await accessTokens.get(signal);
        let res = await send(url, token, c.maxBytes);
        if (res.status === 401) {
          accessTokens.invalidate(token);
          token = await accessTokens.get(signal);
          res = await send(url, token, c.maxBytes);
        }
        if (res.status === 200) {
          if (res.tooLarge) throw inboxError("response_too_large");
          return c.parse(res.json);
        }
        if (res.status === 404 && c.onNotFound) return c.onNotFound();
        throw classifyGmailResponse(res.status, res.json, res.retryAfterMs);
      },
      signal,
    );
  }

  interface Sent {
    status: number;
    /** The parsed body; for an error status, null when it was not JSON or too large. */
    json: unknown;
    tooLarge: boolean;
    retryAfterMs: number | null;
  }

  /** One HTTP request, body included, within the deadline. */
  async function send(url: string, token: string, maxBytes: number): Promise<Sent> {
    if (signal?.aborted) throw inboxError("stopped");
    // One controller per request, aborted by the deadline or by the caller's signal. A listener
    // removed afterwards, rather than AbortSignal.any, keeps nothing attached to a signal that
    // lives as long as the sync run.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onStop = () => controller.abort();
    signal?.addEventListener("abort", onStop, { once: true });
    try {
      const res = await doFetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: controller.signal,
        // Never follow a redirect with the token; never let a framework cache a mailbox.
        redirect: "error",
        cache: "no-store",
      });
      const ok = res.status === 200;
      const body = await readCapped(res, ok ? maxBytes : MAX_ERROR_BODY_BYTES);
      let json: unknown = null;
      if (body) {
        try {
          json = JSON.parse(new TextDecoder().decode(body));
        } catch {
          if (ok) throw inboxError("bad_response");
        }
      }
      return {
        status: res.status,
        json,
        tooLarge: body === null,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), now()),
      };
    } catch (err) {
      // By isMailSourceError: the token cache is shared across bundles (see sync/errors.ts).
      if (isMailSourceError(err)) throw err;
      throw classifyFetchFailure(err, { stopped: signal?.aborted ?? false, timedOut });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onStop);
    }
  }

  return {
    getProfile() {
      return call<MailboxProfile>({
        method: "users.getProfile",
        path: "profile",
        maxBytes: MAX_SMALL_BODY_BYTES,
        parse: (json) => {
          const p = parseWith(profileSchema, json);
          return { emailAddress: p.emailAddress, historyId: p.historyId };
        },
      });
    },

    listMessages(q, pageToken) {
      return call<MessageListPage>({
        method: "users.messages.list",
        path: "messages",
        params: { q, maxResults: String(PAGE_SIZE), pageToken },
        maxBytes: MAX_LIST_BODY_BYTES,
        parse: (json) => {
          const p = parseWith(messageListSchema, json);
          return {
            messageIds: (p.messages ?? []).map((m) => m.id).filter(isGmailId),
            nextPageToken: p.nextPageToken || null,
          };
        },
      });
    },

    async getMessage(id) {
      assertId(id, MESSAGE_ID);
      return call<GmailMessage | null>({
        method: "users.messages.get",
        path: `messages/${encodeURIComponent(id)}`,
        params: { format: "full" },
        maxBytes: MAX_MESSAGE_BODY_BYTES,
        parse: normalizeMessage,
        onNotFound: () => null,
      });
    },

    async getAttachment(messageId, attachmentId) {
      assertId(messageId, MESSAGE_ID);
      assertId(attachmentId, ATTACHMENT_ID);
      return call<string | null>({
        method: "users.messages.attachments.get",
        path: `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        maxBytes: MAX_MESSAGE_BODY_BYTES,
        parse: (json) => parseWith(attachmentSchema, json).data,
        onNotFound: () => null,
      });
    },

    async listHistory(startHistoryId, pageToken) {
      assertId(startHistoryId, HISTORY_ID);
      return call<HistoryPage | null>({
        method: "users.history.list",
        path: "history",
        params: { startHistoryId, historyTypes: "messageAdded", maxResults: String(PAGE_SIZE), pageToken },
        maxBytes: MAX_LIST_BODY_BYTES,
        onNotFound: () => null,
        parse: (json) => {
          const p = parseWith(historySchema, json);
          const added: HistoryPage["added"] = [];
          for (const record of p.history ?? []) {
            for (const entry of record.messagesAdded ?? []) {
              const message = entry.message;
              if (!isGmailId(message.id)) continue;
              const labelIds = Array.isArray(message.labelIds)
                ? message.labelIds.filter((l): l is string => typeof l === "string").slice(0, MAX_LABELS)
                : [];
              added.push({ id: message.id, labelIds });
            }
          }
          return { added, historyId: p.historyId, nextPageToken: p.nextPageToken || null };
        },
      });
    },
  };
}

/** A malformed id is a bug in the caller, never sent (".." would walk up the URL path). */
function assertId(value: string, pattern: RegExp) {
  if (typeof value !== "string" || !pattern.test(value) || /^\.+$/.test(value)) {
    throw new TypeError("gmail-client: malformed id");
  }
}

/**
 * The body, decompressed, stopping as soon as it passes `max` bytes (null then). A declared
 * length is trusted only without a content-encoding, as it is the compressed size otherwise.
 */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (!res.headers.has("content-encoding") && Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

/* ------------------------------------------------------------- validation */

function parseWith<T>(schema: z.ZodType<T>, json: unknown): T {
  const result = schema.safeParse(json);
  // zod's issues could quote the response: only the code leaves this module.
  if (!result.success) throw inboxError("bad_response");
  return result.data;
}

/** Gmail sends int64 values as decimal strings; a number is accepted too. */
const historyId = z.union([z.string().regex(HISTORY_ID), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]).transform(String);
const pageToken = z.string().max(MAX_PAGE_TOKEN).optional();

const profileSchema = z.object({
  emailAddress: z.string().min(3).max(320),
  historyId,
});

const messageListSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: pageToken,
});

const historySchema = z.object({
  history: z
    .array(
      z.object({
        messagesAdded: z.array(z.object({ message: z.object({ id: z.string(), labelIds: z.unknown().optional() }) })).optional(),
      }),
    )
    .optional(),
  historyId,
  nextPageToken: pageToken,
});

const attachmentSchema = z.object({ data: z.string() });

/**
 * A format=full message as GmailMessage. Required: id, threadId and internalDate (the receive
 * time); without them the message cannot be ingested and this is bad_response. Everything else
 * is kept only when its type is right.
 */
export function normalizeMessage(raw: unknown): GmailMessage {
  if (!isRecord(raw)) throw inboxError("bad_response");
  const internalDate =
    typeof raw.internalDate === "number" && Number.isSafeInteger(raw.internalDate) && raw.internalDate >= 0
      ? String(raw.internalDate)
      : raw.internalDate;
  if (
    !isGmailId(raw.id) ||
    !isGmailId(raw.threadId) ||
    typeof internalDate !== "string" ||
    !/^\d{1,16}$/.test(internalDate)
  ) {
    throw inboxError("bad_response");
  }
  const message: GmailMessage = { id: raw.id, threadId: raw.threadId, internalDate };
  if (Array.isArray(raw.labelIds)) {
    message.labelIds = raw.labelIds.filter((l): l is string => typeof l === "string").slice(0, MAX_LABELS);
  }
  if (typeof raw.snippet === "string") message.snippet = raw.snippet.slice(0, MAX_SNIPPET);
  if (typeof raw.historyId === "string" && HISTORY_ID.test(raw.historyId)) message.historyId = raw.historyId;
  if (isCount(raw.sizeEstimate)) message.sizeEstimate = raw.sizeEstimate;
  if (isRecord(raw.payload)) {
    const budget = { parts: 0 };
    message.payload = normalizePart(raw.payload, 0, budget);
  }
  return message;
}

function normalizePart(raw: Record<string, unknown>, depth: number, budget: { parts: number }): GmailPart {
  budget.parts++;
  const part: GmailPart = {
    mimeType: typeof raw.mimeType === "string" && raw.mimeType !== "" ? raw.mimeType.slice(0, 255) : "application/octet-stream",
  };
  if (typeof raw.partId === "string") part.partId = raw.partId.slice(0, 64);
  if (typeof raw.filename === "string") part.filename = raw.filename.slice(0, 1_000);
  if (Array.isArray(raw.headers)) {
    const headers: GmailHeader[] = [];
    for (const h of raw.headers.slice(0, MAX_HEADERS_PER_PART)) {
      if (isRecord(h) && typeof h.name === "string" && typeof h.value === "string" && h.name.length <= 1_000) {
        headers.push({ name: h.name, value: h.value.slice(0, MAX_HEADER_VALUE) });
      }
    }
    part.headers = headers;
  }
  if (isRecord(raw.body)) {
    const body: GmailPartBody = { size: isCount(raw.body.size) ? raw.body.size : 0 };
    if (typeof raw.body.data === "string") body.data = raw.body.data;
    if (typeof raw.body.attachmentId === "string" && ATTACHMENT_ID.test(raw.body.attachmentId)) {
      body.attachmentId = raw.body.attachmentId;
    }
    part.body = body;
  }
  if (Array.isArray(raw.parts) && depth < MAX_PART_DEPTH) {
    const parts: GmailPart[] = [];
    for (const child of raw.parts) {
      if (budget.parts >= MAX_PARTS) break;
      if (isRecord(child)) parts.push(normalizePart(child, depth + 1, budget));
    }
    part.parts = parts;
  }
  return part;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
