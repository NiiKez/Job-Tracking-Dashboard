// Fakes for the Gmail client and source tests: a recording fetch, Google-shaped answers, a pacer
// that runs requests at once, and token providers. No network. Invented values only.
import type { AccessTokenProvider, FetchLike } from "@/lib/server/inbox/source/gmail-client";
import type { GmailMessage } from "@/lib/server/inbox/source/types";
import type { GmailMethod, Pacer } from "@/lib/server/inbox/sync/pace";

export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Text a Google error body carries; it must never reach an error message or code. */
export const GOOGLE_SECRET_TEXT = "Google internal text for owner@example.com";

export interface FetchCall {
  url: URL;
  init: RequestInit;
  authorization: string | null;
}

export type FakeFetch = FetchLike & { calls: FetchCall[] };

export function fakeFetch(handler: (url: URL, init: RequestInit, call: number) => Response | Promise<Response>): FakeFetch {
  const calls: FetchCall[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const headers = new Headers(init.headers);
    calls.push({ url: parsed, init, authorization: headers.get("authorization") });
    return handler(parsed, init, calls.length);
  }) as FakeFetch;
  fn.calls = calls;
  return fn;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}

/** Gmail's error body: { error: { code, message, errors: [{ reason }], status } }. */
export function googleError(status: number, reason: string | null, headers: Record<string, string> = {}): Response {
  return json(
    {
      error: {
        code: status,
        message: GOOGLE_SECRET_TEXT,
        errors: reason ? [{ message: GOOGLE_SECRET_TEXT, domain: "global", reason }] : [],
        status: status === 429 ? "RESOURCE_EXHAUSTED" : status === 403 ? "PERMISSION_DENIED" : "UNKNOWN",
      },
    },
    status,
    headers,
  );
}

/** Runs every request at once and records the methods. */
export function directPacer(): Pacer & { methods: GmailMethod[] } {
  const methods: GmailMethod[] = [];
  return {
    methods,
    run(method, request) {
      methods.push(method);
      return request();
    },
  };
}

/** Hands out "token-1", "token-2", … : a new one after each invalidate of the current one. */
export function rotatingTokens(): AccessTokenProvider & { invalidated: string[] } {
  let n = 1;
  const invalidated: string[] = [];
  return {
    invalidated,
    async get() {
      return `token-${n}`;
    },
    invalidate(token) {
      invalidated.push(token);
      if (token === `token-${n}`) n++;
    },
  };
}

/** A minimal format=full message. */
export function gmailMessage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    threadId: `t${id}`,
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Thanks for applying",
    historyId: "12345",
    internalDate: "1792240496000",
    sizeEstimate: 2048,
    payload: {
      partId: "",
      mimeType: "text/plain",
      filename: "",
      headers: [
        { name: "From", value: "Jobs <jobs@example.com>" },
        { name: "Subject", value: "Your application" },
      ],
      body: { size: 12, data: "SGVsbG8gd29ybGQh" },
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------ a fake Gmail */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";

/** A Gmail message as the fake mailbox keeps it: format=full, with its attachments' data. */
export type MailboxMessage = GmailMessage & { _attachments?: Record<string, string> };

export type GmailEndpoint = "token" | "profile" | "messages.list" | "messages.get" | "attachments.get" | "history.list";

export interface GmailRequest {
  endpoint: GmailEndpoint;
  url: URL;
  /** The message id (messages.get, attachments.get). */
  id?: string;
  /** The Authorization header (Gmail), or the refresh token sent (token endpoint). */
  credential: string | null;
}

export interface FakeGmail {
  /** The global fetch to install (vi.stubGlobal("fetch", gmail.fetch)): Arctic and the Gmail client both use it. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Every request, in order. */
  requests: GmailRequest[];
  count(endpoint: GmailEndpoint, id?: string): number;
  /** New mail: each message gets the next history id, as Gmail records a messageAdded. */
  deliver(...messages: MailboxMessage[]): void;
  /** Removes a message (messages.get answers 404 from now on). */
  remove(id: string): void;
  /** The mailbox's current history id. */
  historyId(): string;
  /** history.list answers 404 for any start id below `historyId` (default: the current one). */
  expireHistory(historyId?: number): void;
  /**
   * Runs before every answer. A Response it returns (or resolves) is sent instead; undefined lets
   * the fake answer. It may wait: the request's AbortSignal still ends it, as with the real fetch.
   */
  intercept: ((req: GmailRequest) => Response | undefined | Promise<Response | undefined>) | null;
}

/**
 * An invented Gmail mailbox behind a fake fetch: users.getProfile, messages.list (the first
 * scan's query: after:<seconds>, -in:sent, -in:drafts, -in:chats; spam and trash never listed),
 * messages.get (format=full), messages.attachments.get, history.list (messageAdded records after
 * the start id; 404 once expired), and Google's token endpoint for a refresh (a new access token
 * each time). Lists are paged by `pageSize` (Gmail: up to 500) so paging is exercised.
 */
export function fakeGmail(opts: { emailAddress?: string; pageSize?: number; firstHistoryId?: number } = {}): FakeGmail {
  const pageSize = opts.pageSize ?? 500;
  const messages = new Map<string, MailboxMessage>();
  const history: Array<{ id: number; message: MailboxMessage }> = [];
  let historyId = opts.firstHistoryId ?? 5000;
  let expiredBefore = 0;
  let tokens = 0;
  const requests: GmailRequest[] = [];

  const gmailNotFound = () => googleError(404, "notFound");

  function page<T>(items: T[], token: string | null): { items: T[]; next: string | undefined } {
    const start = token ? Number(token.slice(1)) : 0;
    const items_ = items.slice(start, start + pageSize);
    return { items: items_, next: start + pageSize < items.length ? `p${start + pageSize}` : undefined };
  }

  function listMessages(url: URL): Response {
    const q = url.searchParams.get("q") ?? "";
    const after = /(?:^|\s)after:(\d+)(?:\s|$)/.exec(q);
    const left = new Set(["SPAM", "TRASH"]);
    if (/-in:sent\b/.test(q)) left.add("SENT");
    if (/-in:drafts\b/.test(q)) left.add("DRAFT");
    if (/-in:chats\b/.test(q)) left.add("CHAT");
    const found = [...messages.values()]
      .filter((m) => !after || Number(m.internalDate) > Number(after[1]) * 1000)
      .filter((m) => !(m.labelIds ?? []).some((l) => left.has(l)))
      .sort((a, b) => Number(b.internalDate) - Number(a.internalDate)); // newest first, as Gmail
    const { items, next } = page(found, url.searchParams.get("pageToken"));
    return json({ messages: items.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: next, resultSizeEstimate: found.length });
  }

  function listHistory(url: URL): Response {
    const start = Number(url.searchParams.get("startHistoryId"));
    if (!(start >= expiredBefore)) return gmailNotFound();
    const records = history.filter((h) => h.id > start);
    const { items, next } = page(records, url.searchParams.get("pageToken"));
    return json({
      history: items.map((h) => ({
        id: String(h.id),
        messages: [{ id: h.message.id, threadId: h.message.threadId }],
        messagesAdded: [{ message: { id: h.message.id, threadId: h.message.threadId, labelIds: h.message.labelIds ?? [] } }],
      })),
      historyId: String(historyId),
      nextPageToken: next,
    });
  }

  async function answer(req: GmailRequest): Promise<Response> {
    const custom = await gmail.intercept?.(req);
    if (custom) return custom;
    const path = req.url.pathname.replace("/gmail/v1/users/me/", "");
    switch (req.endpoint) {
      case "token":
        tokens++;
        return Response.json({ access_token: `ya29.fake-access-${tokens}`, expires_in: 3599, scope: `openid ${GMAIL_READONLY}`, token_type: "Bearer" });
      case "profile":
        return json({ emailAddress: opts.emailAddress ?? "owner@example.com", messagesTotal: messages.size, threadsTotal: messages.size, historyId: String(historyId) });
      case "messages.list":
        return listMessages(req.url);
      case "history.list":
        return listHistory(req.url);
      case "messages.get": {
        if (req.url.searchParams.get("format") !== "full") return googleError(400, "invalidArgument");
        const m = messages.get(req.id ?? "");
        if (!m) return gmailNotFound();
        const message: Record<string, unknown> = { ...m };
        delete message._attachments;
        return json(message);
      }
      case "attachments.get": {
        const attachmentId = decodeURIComponent(path.split("/")[3] ?? "");
        const data = messages.get(req.id ?? "")?._attachments?.[attachmentId];
        return data === undefined ? gmailNotFound() : json({ size: Math.floor((data.length * 3) / 4), data });
      }
    }
  }

  const gmail: FakeGmail = {
    requests,
    intercept: null,
    count: (endpoint, id) => requests.filter((r) => r.endpoint === endpoint && (id === undefined || r.id === id)).length,
    deliver(...list) {
      for (const message of list) {
        historyId += 1 + Math.floor(Math.random() * 3); // history ids grow, with gaps
        messages.set(message.id, message);
        history.push({ id: historyId, message });
      }
    },
    remove(id) {
      messages.delete(id);
    },
    historyId: () => String(historyId),
    expireHistory(before = historyId) {
      expiredBefore = before;
    },
    async fetch(input, init) {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input));
      let req: GmailRequest;
      if (url.href.split("?")[0] === TOKEN_URL && request) {
        req = { endpoint: "token", url, credential: new URLSearchParams(await request.text()).get("refresh_token") };
      } else if (`${url.origin}${url.pathname}`.startsWith(`${GMAIL}/`)) {
        const path = url.pathname.replace("/gmail/v1/users/me/", "");
        const parts = path.split("/").map(decodeURIComponent);
        const endpoint: GmailEndpoint | null =
          path === "profile"
            ? "profile"
            : path === "messages"
              ? "messages.list"
              : path === "history"
                ? "history.list"
                : parts[0] === "messages" && parts.length === 2
                  ? "messages.get"
                  : parts[0] === "messages" && parts[2] === "attachments" && parts.length === 4
                    ? "attachments.get"
                    : null;
        if (!endpoint) throw new Error(`fake Gmail: unexpected path ${url.pathname}`);
        req = { endpoint, url, id: parts[0] === "messages" ? parts[1] : undefined, credential: new Headers(init?.headers).get("authorization") };
      } else {
        throw new Error(`fake Gmail: unexpected request to ${url.origin}${url.pathname}`);
      }
      requests.push(req);
      const signal = init?.signal ?? request?.signal;
      if (!signal) return answer(req);
      if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        answer(req)
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", onAbort));
      });
    },
  };
  return gmail;
}

/** Google's token endpoint refusing a refresh token (OAuth error code, e.g. "invalid_grant"). */
export function tokenError(error: string, status = 400): Response {
  return Response.json({ error, error_description: GOOGLE_SECRET_TEXT }, { status });
}
