import { Google } from "arctic";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyTokenError,
  connectionAccessTokens,
  createAccessTokens,
  fixedAccessToken,
  forgetAccessTokens,
  GMAIL_READONLY_SCOPE,
  INBOX_REDIRECT_PATH,
  refreshAccessToken,
  revokeToken,
  type AccessToken,
} from "@/lib/server/inbox/oauth/google-tokens";
import { MailSourceError } from "@/lib/server/inbox/sync/errors";
import { APP_ORIGIN, restoreEnv, setEnv, signedInEnv } from "../auth/env";
import { json } from "./gmail-fakes";

const REFRESH_TOKEN = "1//refresh-token-invented";
const GOOGLE_TEXT = "Token has been expired or revoked for owner@example.com";
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

/** Arctic's real Google client, with the global fetch it uses replaced. */
function arcticWith(handler: (req: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (req: Request) => {
      requests.push(req.clone());
      return handler(req);
    }),
  );
  return { client: new Google("client-id.apps.googleusercontent.com", "test-secret-not-real", `${APP_ORIGIN}/api/inbox/callback`), requests };
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
  expect(mse.message).not.toContain(REFRESH_TOKEN);
  expect(mse.message).not.toContain(GOOGLE_TEXT);
  expect(mse.cause).toBeUndefined();
  return mse;
}

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv();
});

describe("constants", () => {
  it("are the plan's", () => {
    expect(INBOX_REDIRECT_PATH).toBe("/api/inbox/callback");
    expect(GMAIL_READONLY_SCOPE).toBe("https://www.googleapis.com/auth/gmail.readonly");
  });
});

describe("refreshAccessToken", () => {
  it("posts the refresh token to Google and answers the access token with its expiry", async () => {
    const { client, requests } = arcticWith(() =>
      json({ access_token: "ya29.invented", expires_in: 3599, scope: `${GMAIL_READONLY_SCOPE} openid`, token_type: "Bearer" }),
    );
    await expect(refreshAccessToken(REFRESH_TOKEN, { client, now: () => NOW })).resolves.toEqual({
      accessToken: "ya29.invented",
      expiresAt: new Date(NOW + 3_599_000),
    });
    expect(requests[0].url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(await requests[0].text());
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(REFRESH_TOKEN);
  });

  it("uses googleClient with the inbox redirect path by default", async () => {
    signedInEnv();
    arcticWith(() => json({ access_token: "ya29.invented", expires_in: 3599, token_type: "Bearer" }));
    await expect(refreshAccessToken(REFRESH_TOKEN, { now: () => NOW })).resolves.toMatchObject({ accessToken: "ya29.invented" });
  });

  it("without a Google client configured it is a setup problem", async () => {
    setEnv({});
    await expect(refreshAccessToken(REFRESH_TOKEN)).rejects.toMatchObject({ kind: "setup", code: "google_not_configured" });
  });

  const cases: Array<[string, () => Response, string, string]> = [
    ["invalid_grant", () => json({ error: "invalid_grant", error_description: GOOGLE_TEXT }, 400), "needs_reconnect", "token_revoked"],
    ["invalid_client", () => json({ error: "invalid_client", error_description: GOOGLE_TEXT }, 401), "setup", "oauth_client_invalid"],
    ["unauthorized_client", () => json({ error: "unauthorized_client" }, 400), "setup", "oauth_client_invalid"],
    ["another OAuth error", () => json({ error: "invalid_request", error_description: GOOGLE_TEXT }, 400), "temporary", "token_refresh_failed"],
    ["500", () => new Response(GOOGLE_TEXT, { status: 500 }), "temporary", "google_unavailable"],
    ["503", () => new Response(null, { status: 503 }), "temporary", "google_unavailable"],
    ["429", () => new Response(null, { status: 429 }), "temporary", "rate_limited"],
    // Anything else is token_refresh_failed, never bad_response: the refresh runs inside a Gmail
    // request, and the sync engine would take bad_response for a fault of the message fetched.
    ["400 that is not JSON", () => new Response(GOOGLE_TEXT, { status: 400 }), "temporary", "token_refresh_failed"],
    ["400 JSON without an error code", () => json({ message: GOOGLE_TEXT }, 400), "temporary", "token_refresh_failed"],
    [
      "403 with an HTML page",
      () => new Response(`<html>${GOOGLE_TEXT}</html>`, { status: 403, headers: { "content-type": "text/html" } }),
      "temporary",
      "token_refresh_failed",
    ],
    ["200 that is not JSON", () => new Response(`<html>${GOOGLE_TEXT}</html>`, { status: 200 }), "temporary", "token_refresh_failed"],
    ["200 without an access token", () => json({ expires_in: 3599, token_type: "Bearer" }), "temporary", "token_refresh_failed"],
    ["200 with an empty access token", () => json({ access_token: "", expires_in: 3599 }), "temporary", "token_refresh_failed"],
    ["200 with an access token holding spaces", () => json({ access_token: "ya29 x", expires_in: 3599 }), "temporary", "token_refresh_failed"],
    ["200 without gmail.readonly", () => json({ access_token: "ya29.x", expires_in: 3599, scope: "openid email" }), "needs_reconnect", "scope_missing"],
  ];

  it.each(cases)("%s", async (_name, response, kind, code) => {
    const { client } = arcticWith(response);
    const err = await failure(refreshAccessToken(REFRESH_TOKEN, { client }));
    expect([err.kind, err.code]).toEqual([kind, code]);
  });

  it("a network error is temporary/network", async () => {
    const { client } = arcticWith(() => {
      throw new TypeError("fetch failed");
    });
    const err = await failure(refreshAccessToken(REFRESH_TOKEN, { client }));
    expect([err.kind, err.code]).toEqual(["temporary", "network"]);
  });

  it("a hanging token endpoint is temporary/timeout", async () => {
    const { client } = arcticWith(() => new Promise<Response>(() => {}));
    const err = await failure(refreshAccessToken(REFRESH_TOKEN, { client, timeoutMs: 20 }));
    expect([err.kind, err.code]).toEqual(["temporary", "timeout"]);
  });

  it("a missing or odd expires_in is trusted for 5 minutes; a huge one for a day at most", async () => {
    for (const [expiresIn, lifetimeMs] of [
      [undefined, 300_000],
      ["3599", 300_000],
      [-5, 300_000],
      [10 ** 9, 86_400_000],
    ] as const) {
      const { client } = arcticWith(() => json({ access_token: "ya29.x", expires_in: expiresIn, token_type: "Bearer" }));
      const token = await refreshAccessToken(REFRESH_TOKEN, { client, now: () => NOW });
      expect(token.expiresAt.getTime() - NOW).toBe(lifetimeMs);
      vi.unstubAllGlobals();
    }
  });
});

describe("classifyTokenError", () => {
  it("keeps a MailSourceError and maps anything unknown to token_refresh_failed", () => {
    const original = new MailSourceError("setup", "oauth_client_invalid");
    expect(classifyTokenError(original)).toBe(original);
    expect(classifyTokenError(new Error("Missing or invalid 'access_token' field")).code).toBe("token_refresh_failed");
    expect(classifyTokenError("weird")).toMatchObject({ kind: "temporary", code: "token_refresh_failed" });
  });
});

describe("revokeToken", () => {
  it("posts the token to Google's revoke endpoint and answers true", async () => {
    const { client, requests } = arcticWith(() => new Response(null, { status: 200 }));
    await expect(revokeToken(REFRESH_TOKEN, { client })).resolves.toBe(true);
    expect(requests[0].url).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(await requests[0].text()).get("token")).toBe(REFRESH_TOKEN);
  });

  it("answers true for invalid_token: the token is already invalid, so its grant is gone", async () => {
    const { client, requests } = arcticWith(() => json({ error: "invalid_token", error_description: GOOGLE_TEXT }, 400));
    await expect(revokeToken(REFRESH_TOKEN, { client })).resolves.toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("never throws: another error answer, a network error, a hang or no configuration answer false", async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => json({ error: "invalid_request" }, 400),
      () => json({ error: "invalid_client" }, 401),
      () => new Response("<html>not JSON</html>", { status: 400 }),
      () => new Response(null, { status: 503 }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Promise<Response>(() => {}),
    ];
    for (const answer of answers) {
      const { client } = arcticWith(answer);
      await expect(revokeToken(REFRESH_TOKEN, { client, timeoutMs: 20 })).resolves.toBe(false);
      vi.unstubAllGlobals();
    }
    setEnv({});
    await expect(revokeToken(REFRESH_TOKEN)).resolves.toBe(false);
  });
});

describe("createAccessTokens", () => {
  function setup(opts: { lifetimeMs?: number; fail?: () => Error | null } = {}) {
    let t = NOW;
    let n = 0;
    const refresh = vi.fn(async (refreshToken: string): Promise<AccessToken> => {
      expect(refreshToken).toBe(REFRESH_TOKEN);
      const err = opts.fail?.();
      if (err) throw err;
      n++;
      return { accessToken: `access-${n}`, expiresAt: new Date(t + (opts.lifetimeMs ?? 3_600_000)) };
    });
    const getRefreshToken = vi.fn(async () => REFRESH_TOKEN);
    const tokens = createAccessTokens(getRefreshToken, { refresh, now: () => t });
    return { tokens, refresh, getRefreshToken, tick: (ms: number) => (t += ms) };
  }

  it("reuses a token until a minute before it expires", async () => {
    const { tokens, refresh, getRefreshToken, tick } = setup();
    await expect(tokens.get()).resolves.toBe("access-1");
    tick(58 * 60_000);
    await expect(tokens.get()).resolves.toBe("access-1");
    tick(60_000);
    await expect(tokens.get()).resolves.toBe("access-2");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(getRefreshToken).toHaveBeenCalledTimes(2);
  });

  it("refreshes a short-lived token at half its lifetime", async () => {
    const { tokens, tick } = setup({ lifetimeMs: 60_000 });
    await expect(tokens.get()).resolves.toBe("access-1");
    tick(29_000);
    await expect(tokens.get()).resolves.toBe("access-1");
    tick(1_000);
    await expect(tokens.get()).resolves.toBe("access-2");
  });

  it("shares one refresh between concurrent callers", async () => {
    const { tokens, refresh } = setup();
    await expect(Promise.all([tokens.get(), tokens.get(), tokens.get()])).resolves.toEqual(["access-1", "access-1", "access-1"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("drops a token Gmail rejected, but not a newer one", async () => {
    const { tokens, refresh } = setup();
    const first = await tokens.get();
    tokens.invalidate(first);
    const second = await tokens.get();
    expect(second).toBe("access-2");
    // A late 401 for the old token from a concurrent request changes nothing.
    tokens.invalidate(first);
    await expect(tokens.get()).resolves.toBe("access-2");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("passes a failed refresh to every waiter and tries again on the next call", async () => {
    let fail: Error | null = new MailSourceError("temporary", "network");
    const { tokens, refresh } = setup({ fail: () => fail });
    const results = await Promise.allSettled([tokens.get(), tokens.get()]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    fail = null;
    await expect(tokens.get()).resolves.toBe("access-1");
  });

  it("errors from getRefreshToken pass through unchanged", async () => {
    const boom = new Error("database is down");
    const tokens = createAccessTokens(() => Promise.reject(boom), { refresh: vi.fn() });
    await expect(tokens.get()).rejects.toBe(boom);
  });

  it("clear() forgets the token and a refresh in flight", async () => {
    let finish!: (t: AccessToken) => void;
    const refresh = vi
      .fn<(rt: string) => Promise<AccessToken>>()
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockImplementation(async () => ({ accessToken: "after-clear", expiresAt: new Date(Date.now() + 3_600_000) }));
    const tokens = createAccessTokens(async () => REFRESH_TOKEN, { refresh });
    const early = tokens.get();
    await Promise.resolve();
    await Promise.resolve();
    tokens.clear();
    finish({ accessToken: "before-clear", expiresAt: new Date(Date.now() + 3_600_000) });
    await expect(early).resolves.toBe("before-clear");
    await expect(tokens.get()).resolves.toBe("after-clear");
  });

  it("a waiter's signal stops its wait, not the shared refresh", async () => {
    let finish!: (t: AccessToken) => void;
    const refresh = vi.fn(() => new Promise<AccessToken>((resolve) => (finish = resolve)));
    const tokens = createAccessTokens(async () => REFRESH_TOKEN, { refresh });
    const controller = new AbortController();
    const stopped = tokens.get(controller.signal);
    const other = tokens.get();
    controller.abort();
    await expect(stopped).rejects.toMatchObject({ code: "stopped" });
    await Promise.resolve();
    finish({ accessToken: "shared", expiresAt: new Date(Date.now() + 3_600_000) });
    await expect(other).resolves.toBe("shared");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("connectionAccessTokens", () => {
  it("one cache per connection, kept across runs, until forgetAccessTokens", async () => {
    signedInEnv();
    let n = 0;
    const { requests } = arcticWith(() =>
      json({ access_token: `ya29.invented-${++n}`, expires_in: 3599, scope: GMAIL_READONLY_SCOPE, token_type: "Bearer" }),
    );
    const getRefreshToken = vi.fn(async () => REFRESH_TOKEN);
    const tokens = connectionAccessTokens("user-a", getRefreshToken);
    expect(connectionAccessTokens("user-a", getRefreshToken)).toBe(tokens);
    expect(connectionAccessTokens("user-b", getRefreshToken)).not.toBe(tokens);
    await expect(tokens.get()).resolves.toBe("ya29.invented-1");
    await expect(connectionAccessTokens("user-a", getRefreshToken).get()).resolves.toBe("ya29.invented-1");
    expect(requests).toHaveLength(1);

    forgetAccessTokens("user-a");
    // A run still holding the old cache refreshes (reading the stored token again).
    await expect(tokens.get()).resolves.toBe("ya29.invented-2");
    expect(getRefreshToken).toHaveBeenCalledTimes(2);
    expect(connectionAccessTokens("user-a", getRefreshToken)).not.toBe(tokens);
    forgetAccessTokens("user-a");
    forgetAccessTokens("user-b");
    forgetAccessTokens("never-connected");
  });
});

describe("fixedAccessToken", () => {
  it("answers its token until Gmail rejects it", async () => {
    const tokens = fixedAccessToken("ya29.exchanged");
    await expect(tokens.get()).resolves.toBe("ya29.exchanged");
    tokens.invalidate("something-else");
    await expect(tokens.get()).resolves.toBe("ya29.exchanged");
    tokens.invalidate("ya29.exchanged");
    await expect(tokens.get()).rejects.toMatchObject({ kind: "needs_reconnect", code: "token_rejected" });
  });
});
