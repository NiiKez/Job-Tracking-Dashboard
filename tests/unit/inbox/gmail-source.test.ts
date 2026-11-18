import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedAccessToken } from "@/lib/server/inbox/oauth/google-tokens";
import { createGmailSource, firstScanQuery } from "@/lib/server/inbox/source/gmail-source";
import { MailSourceError } from "@/lib/server/inbox/sync/errors";
import { restoreEnv, signedInEnv } from "../auth/env";
import { directPacer, fakeFetch, GMAIL, gmailMessage, googleError, json, rotatingTokens, type FakeFetch } from "./gmail-fakes";

function source(fetch: FakeFetch) {
  return createGmailSource({ accessTokens: rotatingTokens(), pacer: directPacer(), fetch });
}

async function failure(promise: Promise<unknown>): Promise<MailSourceError> {
  const err = await promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MailSourceError);
  return err as MailSourceError;
}

describe("firstScanQuery", () => {
  it("uses whole epoch seconds and leaves out sent mail, drafts and chats", () => {
    expect(firstScanQuery(new Date("2026-10-17T12:34:56.789Z"))).toBe(
      `after:${Math.floor(Date.UTC(2026, 9, 17, 12, 34, 56) / 1000)} -in:sent -in:drafts -in:chats`,
    );
    expect(() => firstScanQuery(new Date("nope"))).toThrow(TypeError);
  });
});

describe("listMessageIds", () => {
  it("reads every page with the first-scan query and drops duplicate ids", async () => {
    const pages: Record<string, unknown> = {
      first: { messages: [{ id: "a1" }, { id: "a2" }], nextPageToken: "p2" },
      p2: { messages: [{ id: "a2" }, { id: "a3" }], nextPageToken: "p3" },
      p3: { messages: [{ id: "a4" }] },
    };
    const fetch = fakeFetch((url) => json(pages[url.searchParams.get("pageToken") ?? "first"]));
    const after = new Date("2026-10-17T00:00:00Z");
    await expect(source(fetch).listMessageIds(after)).resolves.toEqual(["a1", "a2", "a3", "a4"]);
    expect(fetch.calls).toHaveLength(3);
    for (const call of fetch.calls) {
      expect(call.url.origin + call.url.pathname).toBe(`${GMAIL}/messages`);
      expect(call.url.searchParams.get("q")).toBe(firstScanQuery(after));
      expect(call.url.searchParams.get("maxResults")).toBe("500");
    }
  });

  it("stops on a page token that repeats", async () => {
    const fetch = fakeFetch(() => json({ messages: [{ id: "a1" }], nextPageToken: "same" }));
    const err = await failure(source(fetch).listMessageIds(new Date("2026-10-17T00:00:00Z")));
    expect(err.code).toBe("bad_response");
    expect(fetch.calls).toHaveLength(2);
  });
});

describe("listAddedSince", () => {
  const added = (id: string, labelIds?: string[]) => ({ message: { id, threadId: id, ...(labelIds ? { labelIds } : {}) } });

  it("reads every page from the start id and answers the last page's history id", async () => {
    const pages: Record<string, unknown> = {
      first: {
        history: [{ id: "501", messagesAdded: [added("m1", ["INBOX", "UNREAD"]), added("m2", ["CATEGORY_PROMOTIONS"])] }],
        nextPageToken: "p2",
        historyId: "510",
      },
      p2: {
        history: [{ id: "511", messagesAdded: [added("m2"), added("m3", ["Label_7"])] }],
        historyId: "512",
      },
    };
    const fetch = fakeFetch((url) => json(pages[url.searchParams.get("pageToken") ?? "first"]));
    await expect(source(fetch).listAddedSince("500")).resolves.toEqual({ messageIds: ["m1", "m2", "m3"], historyId: "512" });
    for (const call of fetch.calls) {
      expect(call.url.searchParams.get("startHistoryId")).toBe("500");
      expect(call.url.searchParams.get("historyTypes")).toBe("messageAdded");
      expect(call.url.searchParams.has("labelId")).toBe(false);
    }
  });

  it("leaves out what the first scan leaves out: sent, drafts, chats, spam, trash", async () => {
    const fetch = fakeFetch(() =>
      json({
        history: [
          {
            id: "601",
            messagesAdded: [
              added("keep", ["INBOX"]),
              added("sent", ["SENT"]),
              added("selfsent", ["SENT", "INBOX"]),
              added("draft", ["DRAFT"]),
              added("chat", ["CHAT"]),
              added("spam", ["SPAM"]),
              added("trash", ["TRASH", "INBOX"]),
              added("filtered", ["Label_3"]),
            ],
          },
        ],
        historyId: "602",
      }),
    );
    await expect(source(fetch).listAddedSince("600")).resolves.toEqual({ messageIds: ["keep", "filtered"], historyId: "602" });
  });

  it("no changes: no ids, the current history id", async () => {
    const fetch = fakeFetch(() => json({ historyId: "700" }));
    await expect(source(fetch).listAddedSince("700")).resolves.toEqual({ messageIds: [], historyId: "700" });
  });

  it("a 404 is history_expired", async () => {
    const fetch = fakeFetch(() => googleError(404, "notFound"));
    const err = await failure(source(fetch).listAddedSince("1"));
    expect([err.kind, err.code]).toEqual(["history_expired", "history_expired"]);
  });

  it("a start id that is not a history id is history_expired, without a request", async () => {
    const fetch = fakeFetch(() => json({ historyId: "1" }));
    for (const start of ["", "abc", "-5", "1".repeat(21)]) {
      const err = await failure(source(fetch).listAddedSince(start));
      expect(err.kind).toBe("history_expired");
    }
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("getMessage and getAttachment", () => {
  it("answer null for a message that is gone", async () => {
    const fetch = fakeFetch((url) => (url.pathname.includes("/gone") ? googleError(404, "notFound") : json(gmailMessage("here"))));
    const s = source(fetch);
    await expect(s.getMessage("gone")).resolves.toBeNull();
    await expect(s.getAttachment("gone", "ANGj1")).resolves.toBeNull();
    await expect(s.getMessage("here")).resolves.toMatchObject({ id: "here" });
  });
});

describe("createGmailSource with a refresh token", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreEnv();
  });

  it("refreshes once through Google's token endpoint and reuses the access token", async () => {
    signedInEnv();
    const tokenCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request) => {
        expect(input.url).toBe("https://oauth2.googleapis.com/token");
        tokenCalls.push(new URLSearchParams(await input.text()).get("refresh_token") ?? "");
        return json({
          access_token: "ya29.fresh",
          expires_in: 3599,
          scope: "openid https://www.googleapis.com/auth/gmail.readonly",
          token_type: "Bearer",
        });
      }),
    );
    const getRefreshToken = vi.fn(async () => "1//refresh-invented");
    const gmail = fakeFetch((url) =>
      url.pathname.endsWith("/profile") ? json({ emailAddress: "owner@example.com", historyId: "9" }) : json(gmailMessage("m1")),
    );
    const s = createGmailSource({ getRefreshToken, pacer: directPacer(), fetch: gmail });
    await Promise.all([s.getProfile(), s.getMessage("m1"), s.getMessage("m1")]);
    expect(getRefreshToken).toHaveBeenCalledTimes(1);
    expect(tokenCalls).toEqual(["1//refresh-invented"]);
    expect(gmail.calls.map((c) => c.authorization)).toEqual(Array(3).fill("Bearer ya29.fresh"));
  });

  it("invalid_grant is needs_reconnect", async () => {
    signedInEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400)),
    );
    const gmail = fakeFetch(() => json({}));
    const s = createGmailSource({ getRefreshToken: async () => "1//refresh-invented", pacer: directPacer(), fetch: gmail });
    const err = await failure(s.getProfile());
    expect([err.kind, err.code]).toEqual(["needs_reconnect", "token_revoked"]);
    expect(gmail.calls).toHaveLength(0);
  });

  it("works with a fixed token from a code exchange", async () => {
    const gmail = fakeFetch(() => json({ emailAddress: "owner@example.com", historyId: "9" }));
    const s = createGmailSource({ accessTokens: fixedAccessToken("ya29.exchanged"), pacer: directPacer(), fetch: gmail });
    await expect(s.getProfile()).resolves.toEqual({ emailAddress: "owner@example.com", historyId: "9" });
    expect(gmail.calls[0].authorization).toBe("Bearer ya29.exchanged");
  });

  it("the signal stops it", async () => {
    const gmail = fakeFetch(() => json({}));
    const s = createGmailSource({ accessTokens: fixedAccessToken("t"), signal: AbortSignal.abort(), fetch: gmail });
    const err = await failure(s.listMessageIds(new Date("2026-10-17T00:00:00Z")));
    expect(err.code).toBe("stopped");
    expect(gmail.calls).toHaveLength(0);
  });
});
