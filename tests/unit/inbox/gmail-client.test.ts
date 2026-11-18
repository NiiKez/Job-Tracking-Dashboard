import { describe, expect, it } from "vitest";
import {
  createGmailClient,
  MAX_PART_DEPTH,
  MAX_PARTS,
  MAX_SMALL_BODY_BYTES,
  normalizeMessage,
  type AccessTokenProvider,
} from "@/lib/server/inbox/source/gmail-client";
import { MailSourceError } from "@/lib/server/inbox/sync/errors";
import {
  directPacer,
  fakeFetch,
  GMAIL,
  gmailMessage,
  GOOGLE_SECRET_TEXT,
  googleError,
  json,
  rotatingTokens,
  type FakeFetch,
} from "./gmail-fakes";

function client(fetch: FakeFetch, opts: { tokens?: AccessTokenProvider; signal?: AbortSignal; timeoutMs?: number } = {}) {
  const pacer = directPacer();
  const tokens = opts.tokens ?? rotatingTokens();
  return {
    pacer,
    tokens,
    gmail: createGmailClient({ accessTokens: tokens, pacer, fetch, signal: opts.signal, timeoutMs: opts.timeoutMs }),
  };
}

async function failure(promise: Promise<unknown>): Promise<MailSourceError> {
  const err = await promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MailSourceError);
  const mse = err as MailSourceError;
  expect(mse.message).not.toContain(GOOGLE_SECRET_TEXT);
  expect(mse.message).not.toContain("token-");
  return mse;
}

describe("requests", () => {
  it("getProfile: GET /profile with the bearer token, never following redirects or caching", async () => {
    const fetch = fakeFetch(() => json({ emailAddress: "owner@example.com", messagesTotal: 10, historyId: "98765" }));
    const { gmail, pacer } = client(fetch);
    await expect(gmail.getProfile()).resolves.toEqual({ emailAddress: "owner@example.com", historyId: "98765" });
    const [call] = fetch.calls;
    expect(call.url.href).toBe(`${GMAIL}/profile`);
    expect(call.init.method).toBe("GET");
    expect(call.authorization).toBe("Bearer token-1");
    expect(call.init.redirect).toBe("error");
    expect(call.init.cache).toBe("no-store");
    expect(pacer.methods).toEqual(["users.getProfile"]);
  });

  it("getProfile accepts a numeric history id", async () => {
    const fetch = fakeFetch(() => json({ emailAddress: "owner@example.com", historyId: 4242 }));
    await expect(client(fetch).gmail.getProfile()).resolves.toEqual({ emailAddress: "owner@example.com", historyId: "4242" });
  });

  it("listMessages: q, maxResults=500 and the page token; ids only, malformed ones dropped", async () => {
    const fetch = fakeFetch(() =>
      json({
        messages: [
          { id: "18c0a1", threadId: "18c0a1" },
          { id: "../profile", threadId: "x" },
          { id: "18c0a2", threadId: "18c0a1" },
        ],
        nextPageToken: "page-2",
        resultSizeEstimate: 3,
      }),
    );
    const { gmail, pacer } = client(fetch);
    await expect(gmail.listMessages("after:1 -in:sent", "page-1")).resolves.toEqual({
      messageIds: ["18c0a1", "18c0a2"],
      nextPageToken: "page-2",
    });
    const url = fetch.calls[0].url;
    expect(url.origin + url.pathname).toBe(`${GMAIL}/messages`);
    expect(url.searchParams.get("q")).toBe("after:1 -in:sent");
    expect(url.searchParams.get("maxResults")).toBe("500");
    expect(url.searchParams.get("pageToken")).toBe("page-1");
    expect(pacer.methods).toEqual(["users.messages.list"]);
  });

  it("sends the search query with %20 for spaces, exactly as written", async () => {
    const fetch = fakeFetch(() => json({}));
    await client(fetch).gmail.listMessages("after:1792240496 -in:sent -in:drafts -in:chats");
    expect(fetch.calls[0].url.search).toBe("?q=after%3A1792240496%20-in%3Asent%20-in%3Adrafts%20-in%3Achats&maxResults=500");
  });

  it("leaves no listener on the caller's signal after a request", async () => {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      added++;
      return add(...args);
    }) as typeof add;
    controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      removed++;
      return remove(...args);
    }) as typeof remove;
    const fetch = fakeFetch(() => json({ emailAddress: "a@example.com", historyId: "1" }));
    const { gmail } = client(fetch, { signal: controller.signal });
    await gmail.getProfile();
    await gmail.getProfile();
    expect(added).toBe(2);
    expect(removed).toBe(2);
  });

  it("listMessages: an empty result has no messages field", async () => {
    const fetch = fakeFetch(() => json({ resultSizeEstimate: 0 }));
    const { gmail } = client(fetch);
    await expect(gmail.listMessages("q")).resolves.toEqual({ messageIds: [], nextPageToken: null });
    expect(fetch.calls[0].url.searchParams.has("pageToken")).toBe(false);
  });

  it("getMessage: format=full, normalized; null on 404", async () => {
    const fetch = fakeFetch((url) =>
      url.pathname.endsWith("/gone") ? googleError(404, "notFound") : json(gmailMessage("18c0a1")),
    );
    const { gmail, pacer } = client(fetch);
    const message = await gmail.getMessage("18c0a1");
    expect(message).toMatchObject({ id: "18c0a1", threadId: "t18c0a1", internalDate: "1792240496000" });
    expect(message?.payload?.headers).toContainEqual({ name: "Subject", value: "Your application" });
    expect(fetch.calls[0].url.href).toBe(`${GMAIL}/messages/18c0a1?format=full`);
    await expect(gmail.getMessage("gone")).resolves.toBeNull();
    expect(pacer.methods).toEqual(["users.messages.get", "users.messages.get"]);
  });

  it("refuses a malformed id before sending anything", async () => {
    const fetch = fakeFetch(() => json({}));
    const { gmail } = client(fetch);
    await expect(gmail.getMessage("../profile")).rejects.toThrow(TypeError);
    await expect(gmail.getMessage("..")).rejects.toThrow(TypeError);
    await expect(gmail.getAttachment("18c0a1", "..")).rejects.toThrow(TypeError);
    await expect(gmail.listHistory("12; drop")).rejects.toThrow(TypeError);
    expect(fetch.calls).toHaveLength(0);
  });

  it("getAttachment: the base64url data; null on 404", async () => {
    const fetch = fakeFetch((url) =>
      url.pathname.includes("/gone/") ? googleError(404, "notFound") : json({ attachmentId: "ANGj-dJ_8", size: 5, data: "aGVsbG8" }),
    );
    const { gmail, pacer } = client(fetch);
    await expect(gmail.getAttachment("18c0a1", "ANGj-dJ_8")).resolves.toBe("aGVsbG8");
    expect(fetch.calls[0].url.href).toBe(`${GMAIL}/messages/18c0a1/attachments/ANGj-dJ_8`);
    await expect(gmail.getAttachment("gone", "ANGj-dJ_8")).resolves.toBeNull();
    expect(pacer.methods[0]).toBe("users.messages.attachments.get");
  });

  it("listHistory: messageAdded only, no label filter; added ids with their labels; null on 404", async () => {
    const fetch = fakeFetch((url) =>
      url.searchParams.get("startHistoryId") === "1"
        ? googleError(404, "notFound")
        : json({
            history: [
              { id: "101", messages: [{ id: "a1", threadId: "a1" }], messagesAdded: [{ message: { id: "a1", threadId: "a1", labelIds: ["INBOX"] } }] },
              { id: "102", messagesAdded: [{ message: { id: "a2", threadId: "a2" } }, { message: { id: "bad id", threadId: "x" } }] },
              { id: "103" },
            ],
            nextPageToken: "next",
            historyId: "110",
          }),
    );
    const { gmail, pacer } = client(fetch);
    await expect(gmail.listHistory("100", "tok")).resolves.toEqual({
      added: [
        { id: "a1", labelIds: ["INBOX"] },
        { id: "a2", labelIds: [] },
      ],
      historyId: "110",
      nextPageToken: "next",
    });
    const q = fetch.calls[0].url.searchParams;
    expect(fetch.calls[0].url.pathname).toBe("/gmail/v1/users/me/history");
    expect(q.get("startHistoryId")).toBe("100");
    expect(q.get("historyTypes")).toBe("messageAdded");
    expect(q.get("maxResults")).toBe("500");
    expect(q.get("pageToken")).toBe("tok");
    expect(q.has("labelId")).toBe(false);
    await expect(gmail.listHistory("1")).resolves.toBeNull();
    expect(pacer.methods).toEqual(["users.history.list", "users.history.list"]);
  });

  it("a 404 where none is expected is not_found", async () => {
    const err = await failure(client(fakeFetch(() => googleError(404, "notFound"))).gmail.getProfile());
    expect([err.kind, err.code]).toEqual(["temporary", "not_found"]);
  });
});

describe("401 and token refresh", () => {
  it("drops the rejected token, asks for a fresh one once, and goes on", async () => {
    const fetch = fakeFetch((_url, _init, n) => (n === 1 ? googleError(401, "authError") : json({ emailAddress: "a@example.com", historyId: "1" })));
    const { gmail, tokens } = client(fetch);
    await expect(gmail.getProfile()).resolves.toEqual({ emailAddress: "a@example.com", historyId: "1" });
    expect(fetch.calls.map((c) => c.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect((tokens as ReturnType<typeof rotatingTokens>).invalidated).toEqual(["token-1"]);
  });

  it("a second 401 straight after the refresh is needs_reconnect", async () => {
    const fetch = fakeFetch(() => googleError(401, "authError"));
    const err = await failure(client(fetch).gmail.getMessage("18c0a1"));
    expect([err.kind, err.code]).toEqual(["needs_reconnect", "token_rejected"]);
    expect(fetch.calls).toHaveLength(2);
  });

  it("a failing token provider's error passes through", async () => {
    const fetch = fakeFetch(() => json({}));
    const tokens: AccessTokenProvider = {
      get: () => Promise.reject(new MailSourceError("needs_reconnect", "token_revoked")),
      invalidate: () => {},
    };
    const err = await failure(client(fetch, { tokens }).gmail.getProfile());
    expect(err.code).toBe("token_revoked");
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("error responses", () => {
  const cases: Array<[string, () => Response, string, string]> = [
    ["403 accessNotConfigured", () => googleError(403, "accessNotConfigured"), "setup", "gmail_api_disabled"],
    ["403 rateLimitExceeded", () => googleError(403, "rateLimitExceeded"), "temporary", "rate_limited"],
    ["403 userRateLimitExceeded", () => googleError(403, "userRateLimitExceeded"), "temporary", "rate_limited"],
    ["403 insufficientPermissions", () => googleError(403, "insufficientPermissions"), "needs_reconnect", "scope_missing"],
    ["403 domainPolicy", () => googleError(403, "domainPolicy"), "setup", "gmail_domain_policy"],
    ["403 something else", () => googleError(403, "forbidden"), "temporary", "gmail_forbidden"],
    ["429", () => googleError(429, "rateLimitExceeded"), "temporary", "rate_limited"],
    ["500", () => googleError(500, "backendError"), "temporary", "google_unavailable"],
    ["503 without a body", () => new Response(null, { status: 503 }), "temporary", "google_unavailable"],
    ["400", () => googleError(400, "invalidArgument"), "temporary", "bad_request"],
    ["an HTML error page", () => new Response("<html>oops</html>", { status: 502 }), "temporary", "google_unavailable"],
  ];

  it.each(cases)("%s", async (_name, response, kind, code) => {
    const err = await failure(client(fakeFetch(response)).gmail.listMessages("q"));
    expect([err.kind, err.code]).toEqual([kind, code]);
  });

  it("keeps Retry-After (seconds) on a rate limit", async () => {
    const fetch = fakeFetch(() => googleError(429, "rateLimitExceeded", { "retry-after": "7" }));
    const err = await failure(client(fetch).gmail.getProfile());
    expect(err.retryAfterMs).toBe(7_000);
  });

  it("an error body that is too large is classified by status alone", async () => {
    const fetch = fakeFetch(() => new Response("x".repeat(100_000), { status: 403 }));
    const err = await failure(client(fetch).gmail.getProfile());
    expect(err.code).toBe("gmail_forbidden");
  });
});

describe("failed requests", () => {
  it("a network error is temporary/network", async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await failure(client(fetch).gmail.getProfile());
    expect([err.kind, err.code]).toEqual(["temporary", "network"]);
  });

  it("a request past its deadline is temporary/timeout", async () => {
    const fetch = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const err = await failure(client(fetch, { timeoutMs: 20 }).gmail.getProfile());
    expect([err.kind, err.code]).toEqual(["temporary", "timeout"]);
  });

  it("the caller's signal ends a request as temporary/stopped", async () => {
    const controller = new AbortController();
    const fetch = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          setTimeout(() => controller.abort(), 5);
        }),
    );
    const err = await failure(client(fetch, { signal: controller.signal }).gmail.getProfile());
    expect([err.kind, err.code]).toEqual(["temporary", "stopped"]);
  });

  it("an aborted signal sends nothing", async () => {
    const fetch = fakeFetch(() => json({}));
    const err = await failure(client(fetch, { signal: AbortSignal.abort() }).gmail.getProfile());
    expect(err.code).toBe("stopped");
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("response checks", () => {
  it("a body over the cap is response_too_large (declared length)", async () => {
    const big = "x".repeat(MAX_SMALL_BODY_BYTES + 1);
    const fetch = fakeFetch(() => new Response(big, { status: 200, headers: { "content-length": String(big.length) } }));
    const err = await failure(client(fetch).gmail.getProfile());
    expect([err.kind, err.code]).toEqual(["temporary", "response_too_large"]);
  });

  it("a body over the cap is response_too_large (streamed, no length)", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(32);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++;
        if (sent > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const fetch = fakeFetch(() => new Response(stream, { status: 200 }));
    const err = await failure(client(fetch).gmail.getProfile());
    expect(err.code).toBe("response_too_large");
    // Reading stopped soon after the cap.
    expect(sent).toBeLessThan(10);
  });

  it("a 200 that is not JSON, or has the wrong shape, is bad_response", async () => {
    for (const response of [
      () => new Response("<html>", { status: 200 }),
      () => json({ emailAddress: 42, historyId: "1" }),
      () => json({ emailAddress: "a@example.com", historyId: "-1" }),
      () => json({ emailAddress: "a@example.com" }),
      () => json([]),
    ]) {
      const err = await failure(client(fakeFetch(response)).gmail.getProfile());
      expect([err.kind, err.code]).toEqual(["temporary", "bad_response"]);
    }
  });

  it("a history page without a history id is bad_response", async () => {
    const err = await failure(client(fakeFetch(() => json({ history: [] }))).gmail.listHistory("5"));
    expect(err.code).toBe("bad_response");
  });
});

describe("normalizeMessage", () => {
  it("requires id, threadId and internalDate", () => {
    const base = gmailMessage("18c0a1");
    for (const broken of [
      { ...base, id: undefined },
      { ...base, threadId: 7 },
      { ...base, internalDate: undefined },
      { ...base, internalDate: "soon" },
      null,
      "message",
    ]) {
      expect(() => normalizeMessage(broken)).toThrow(MailSourceError);
    }
  });

  it("accepts a numeric internalDate and drops fields of the wrong type", () => {
    const message = normalizeMessage({
      ...gmailMessage("18c0a1"),
      internalDate: 1792240496000,
      labelIds: ["INBOX", 3, null],
      snippet: { text: "x" },
      historyId: "not-a-number",
      sizeEstimate: -1,
    });
    expect(message.internalDate).toBe("1792240496000");
    expect(message.labelIds).toEqual(["INBOX"]);
    expect(message).not.toHaveProperty("snippet");
    expect(message).not.toHaveProperty("historyId");
    expect(message).not.toHaveProperty("sizeEstimate");
  });

  it("cleans the part tree: bad headers dropped, a missing mimeType defaulted, bodies typed", () => {
    const message = normalizeMessage({
      ...gmailMessage("18c0a1"),
      payload: {
        mimeType: "multipart/alternative",
        headers: [{ name: "From", value: "a@example.com" }, { name: "X" }, "Subject: hi", { name: 1, value: "v" }],
        parts: [
          { partId: "0", body: { size: "12", data: 5 } },
          { partId: "1", mimeType: "text/html", body: { size: 3, data: "PGI-", attachmentId: "ANGj_1" } },
          "not a part",
        ],
      },
    });
    const payload = message.payload!;
    expect(payload.headers).toEqual([{ name: "From", value: "a@example.com" }]);
    expect(payload.parts).toHaveLength(2);
    expect(payload.parts![0]).toEqual({ partId: "0", mimeType: "application/octet-stream", body: { size: 0 } });
    expect(payload.parts![1].body).toEqual({ size: 3, data: "PGI-", attachmentId: "ANGj_1" });
  });

  it("caps the depth and the number of parts", () => {
    let deep: Record<string, unknown> = { mimeType: "text/plain" };
    for (let i = 0; i < MAX_PART_DEPTH + 20; i++) deep = { mimeType: "multipart/mixed", parts: [deep] };
    const message = normalizeMessage({ ...gmailMessage("18c0a1"), payload: deep });
    let depth = 0;
    for (let part = message.payload; part?.parts?.length; part = part.parts[0]) depth++;
    expect(depth).toBe(MAX_PART_DEPTH);

    const wide = { mimeType: "multipart/mixed", parts: Array.from({ length: MAX_PARTS + 50 }, () => ({ mimeType: "text/plain" })) };
    const many = normalizeMessage({ ...gmailMessage("18c0a1"), payload: wide });
    expect(many.payload!.parts!.length).toBe(MAX_PARTS - 1);
  });
});
