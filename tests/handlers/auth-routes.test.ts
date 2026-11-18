import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as startSignIn } from "@/app/auth/google/route";
import { GET as callback } from "@/app/auth/google/callback/route";
import { GET as signOutGet, POST as signOut } from "@/app/auth/signout/route";
import { GET as getMe } from "@/app/api/me/route";
import { DEFAULT_RULES } from "@/lib/domain/defaults";
import { hashSessionToken } from "@/lib/server/auth/session";
import { describeDb, testSql } from "../helpers/test-db";
import { APP_ORIGIN, CLIENT_ID, restoreEnv, setEnv, signedInEnv } from "../unit/auth/env";
import { ctx, fakeIdToken, googleClaims, OWNER, request, setCookieFor, setCookies, signedIn } from "./helpers";

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

const SESSION = "__Host-jt_session";
const STATE = "__Secure-jt_oauth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** "name=value" from a Set-Cookie value. */
const pair = (setCookie: string | undefined) => (setCookie ?? "").split("; ")[0];

async function counts() {
  const [row] = await testSql()<{ users: number; sessions: number }[]>`
    SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM sessions) AS sessions`;
  return row;
}

/** Starts sign-in like the login page's link: the state cookie and Google's URL. */
async function begin(next?: string) {
  const res = await startSignIn(request(`/auth/google${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`));
  expect(res.status).toBe(303);
  const google = new URL(res.headers.get("location")!);
  return { res, google, state: google.searchParams.get("state")!, cookie: pair(setCookieFor(res, STATE)) };
}

/** Google's redirect back, with the state cookie (and any other cookies). */
function back(query: string, cookie: string) {
  return callback(request(`/auth/google/callback?${query}`, { cookie }));
}

/** Stubs Google's token endpoint; records what was sent. */
function stubTokenEndpoint(answer: () => Response) {
  const sent: URLSearchParams[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const req = input instanceof Request ? input : new Request(input);
    expect(req.url).toBe(TOKEN_ENDPOINT);
    sent.push(new URLSearchParams(await req.text()));
    return answer();
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, sent };
}

const idTokenAnswer = (claims: Record<string, unknown>) => () =>
  Response.json({
    access_token: "ya29.not-real",
    token_type: "Bearer",
    expires_in: 3599,
    scope: "openid email profile",
    id_token: fakeIdToken(claims),
  });

describeDb("/auth routes", () => {
  beforeEach(() => signedInEnv());
  afterEach(() => {
    restoreEnv();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /* --------------------------------------------------------- /auth/google */

  describe("GET /auth/google", () => {
    it("redirects to Google with the right parameters and stores state, verifier and next", async () => {
      const { res, google, state, cookie } = await begin("/jobs?status=applied");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      const q = google.searchParams;
      expect(q.get("client_id")).toBe(CLIENT_ID);
      expect(q.get("redirect_uri")).toBe(`${APP_ORIGIN}/auth/google/callback`);
      expect(q.get("response_type")).toBe("code");
      expect(q.get("scope")).toBe("openid email profile");
      expect(q.get("prompt")).toBe("select_account");
      expect(q.get("code_challenge_method")).toBe("S256");
      expect(q.get("access_type")).not.toBe("offline");
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

      expect(setCookieFor(res, STATE)).toMatch(
        /^__Secure-jt_oauth=[A-Za-z0-9_-]+; Path=\/auth; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/,
      );
      const stored = JSON.parse(Buffer.from(cookie.split("=")[1], "base64url").toString("utf8"));
      expect(stored.s).toBe(state);
      expect(stored.n).toBe("/jobs?status=applied");
      expect(q.get("code_challenge")).toBe(createHash("sha256").update(stored.c).digest("base64url"));
    });

    it("drops an unsafe next", async () => {
      for (const next of ["//evil.example", "https://evil.example", "/auth/signout", "/x/../auth/google", "/./login"]) {
        const { cookie } = await begin(next);
        const stored = JSON.parse(Buffer.from(cookie.split("=")[1], "base64url").toString("utf8"));
        expect(stored.n).toBeNull();
      }
    });

    it("in locked mode, sends the browser back to /login?error=not_configured", async () => {
      signedInEnv({ GOOGLE_CLIENT_SECRET: "" });
      const res = await startSignIn(request("/auth/google?next=%2Freview"));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/login?error=not_configured&next=%2Freview`);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(setCookies(res)).toEqual([]);
    });

    it("in locked mode without APP_URL, uses a relative Location", async () => {
      setEnv({});
      const res = await startSignIn(request("/auth/google"));
      expect(res.headers.get("location")).toBe("/login?error=not_configured");
    });
  });

  /* ------------------------------------------------ /auth/google/callback */

  describe("GET /auth/google/callback", () => {
    it("signs the allowed account in: user, settings, rules and session; cookie; 303 to next", async () => {
      const { state, cookie } = await begin("/review");
      const { fetchMock, sent } = stubTokenEndpoint(idTokenAnswer(googleClaims(CLIENT_ID)));
      const stored = JSON.parse(Buffer.from(cookie.split("=")[1], "base64url").toString("utf8"));

      const res = await back(`code=4%2F0Abc&state=${state}&scope=openid`, cookie);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/review`);
      expect(res.headers.get("cache-control")).toBe("no-store");

      // The exchange sent the code, the PKCE verifier and the same redirect URI.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sent[0].get("grant_type")).toBe("authorization_code");
      expect(sent[0].get("code")).toBe("4/0Abc");
      expect(sent[0].get("code_verifier")).toBe(stored.c);
      expect(sent[0].get("redirect_uri")).toBe(`${APP_ORIGIN}/auth/google/callback`);

      // State cookie cleared, session cookie set.
      expect(setCookieFor(res, STATE)).toMatch(/^__Secure-jt_oauth=; Path=\/auth; Max-Age=0; /);
      const session = setCookieFor(res, SESSION)!;
      expect(session).toMatch(
        /^__Host-jt_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax$/,
      );
      const token = pair(session).split("=")[1];

      const sql = testSql();
      const [user] = await sql`SELECT id, google_sub, email, name, picture_url FROM users`;
      expect(user).toMatchObject({ google_sub: OWNER.sub, email: OWNER.email, name: OWNER.name });
      const [row] = await sql<{ user_id: string; token_hash: Buffer }[]>`SELECT user_id, token_hash FROM sessions`;
      expect(row.user_id).toBe(user.id);
      expect(row.token_hash.equals(hashSessionToken(token)!)).toBe(true);
      const [{ rules }] = await sql<{ rules: number }[]>`SELECT count(*)::int AS rules FROM keyword_rules`;
      expect(rules).toBe(DEFAULT_RULES.length);
      const [{ settings }] = await sql<{ settings: number }[]>`SELECT count(*)::int AS settings FROM user_settings`;
      expect(settings).toBe(1);

      // The new cookie works.
      const me = await getMe(request("/api/me", { cookie: pair(session) }), ctx());
      expect(me.status).toBe(200);
    });

    it("goes to / when there was no next", async () => {
      const { state, cookie } = await begin();
      stubTokenEndpoint(idTokenAnswer(googleClaims(CLIENT_ID)));
      const res = await back(`code=abc&state=${state}`, cookie);
      expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/`);
    });

    it("refuses an account that is not on the allowlist: no user, no session", async () => {
      const { state, cookie } = await begin("/review");
      stubTokenEndpoint(idTokenAnswer(googleClaims(CLIENT_ID, { email: "stranger@example.com", sub: "999" })));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await back(`code=abc&state=${state}`, cookie);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/login?error=not_allowed&next=%2Freview`);
      expect(setCookieFor(res, SESSION)).toBeUndefined();
      expect(setCookieFor(res, STATE)).toMatch(/Max-Age=0/);
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
    });

    it("fails on a state that does not match the cookie, without calling Google", async () => {
      const { cookie } = await begin("/review");
      const other = await begin();
      const { fetchMock } = stubTokenEndpoint(idTokenAnswer(googleClaims(CLIENT_ID)));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await back(`code=abc&state=${other.state}`, cookie);
      expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/login?error=failed&next=%2Freview`);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
    });

    it("fails without the state cookie, or without code or state", async () => {
      const { state, cookie } = await begin("/review");
      const { fetchMock } = stubTokenEndpoint(idTokenAnswer(googleClaims(CLIENT_ID)));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const failed = `${APP_ORIGIN}/login?error=failed`;
      expect((await back(`code=abc&state=${state}`, "")).headers.get("location")).toBe(failed);
      expect((await back(`state=${state}`, cookie)).headers.get("location")).toBe(`${failed}&next=%2Freview`);
      expect((await back("code=abc", cookie)).headers.get("location")).toBe(`${failed}&next=%2Freview`);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
    });

    it("fails when Google reports an error (e.g. the user cancelled)", async () => {
      const { state, cookie } = await begin("/review");
      const { fetchMock } = stubTokenEndpoint(idTokenAnswer(googleClaims(CLIENT_ID)));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await back(`error=access_denied&state=${state}`, cookie);
      expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/login?error=failed&next=%2Freview`);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails when the code exchange fails, and logs no secrets", async () => {
      const { state, cookie } = await begin();
      stubTokenEndpoint(() => Response.json({ error: "invalid_grant", error_description: "Bad Request" }, { status: 400 }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await back(`code=secret-code-123&state=${state}`, cookie);
      expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/login?error=failed`);
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("invalid_grant");
      expect(logged).not.toContain("secret-code-123");
      expect(logged).not.toContain("test-secret-not-real");
    });

    it("fails when the token endpoint is unreachable or answers without an ID token", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let { state, cookie } = await begin();
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new TypeError("fetch failed");
      }));
      expect((await back(`code=abc&state=${state}`, cookie)).headers.get("location")).toBe(
        `${APP_ORIGIN}/login?error=failed`,
      );

      ({ state, cookie } = await begin());
      stubTokenEndpoint(() => Response.json({ access_token: "x", token_type: "Bearer", expires_in: 1 }));
      expect((await back(`code=abc&state=${state}`, cookie)).headers.get("location")).toBe(
        `${APP_ORIGIN}/login?error=failed`,
      );
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
    });

    it.each([
      ["an unverified email", { email_verified: false }],
      ["another client's token", { aud: "other.apps.googleusercontent.com", azp: "other.apps.googleusercontent.com" }],
      ["a foreign issuer", { iss: "https://evil.example" }],
      ["an expired token", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ])("fails on %s: no user, no session", async (_name, overrides) => {
      const { state, cookie } = await begin();
      stubTokenEndpoint(idTokenAnswer(googleClaims(CLIENT_ID, overrides)));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await back(`code=abc&state=${state}`, cookie);
      expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/login?error=failed`);
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
    });

    it("fails when the email belongs to another Google account, without merging", async () => {
      await signedIn({ ...OWNER, sub: "another-google-account" });
      const { state, cookie } = await begin();
      stubTokenEndpoint(idTokenAnswer(googleClaims(CLIENT_ID)));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await back(`code=abc&state=${state}`, cookie);
      expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/login?error=failed`);
      expect(setCookieFor(res, SESSION)).toBeUndefined();
      expect(await counts()).toEqual({ users: 1, sessions: 1 });
    });

    it("replaces this browser's old session and removes the user's expired ones", async () => {
      const old = await signedIn();
      const expired = await signedIn();
      await testSql()`
        UPDATE sessions SET expires_at = now() - interval '1 day'
        WHERE token_hash = ${hashSessionToken(expired.token)!}`;
      const kept = await signedIn(); // another device
      expect(await counts()).toEqual({ users: 1, sessions: 3 });

      const { state, cookie } = await begin();
      stubTokenEndpoint(idTokenAnswer(googleClaims(CLIENT_ID, { name: "Olive O." })));
      const res = await back(`code=abc&state=${state}`, `${cookie}; ${old.cookie}`);
      expect(res.status).toBe(303);
      const token = pair(setCookieFor(res, SESSION)).split("=")[1];

      const hashes = (await testSql()<{ token_hash: Buffer }[]>`SELECT token_hash FROM sessions`).map((r) =>
        r.token_hash.toString("hex"),
      );
      expect(hashes.sort()).toEqual([kept.token, token].map((t) => hashSessionToken(t)!.toString("hex")).sort());
      const [user] = await testSql()`SELECT name FROM users`;
      expect(user.name).toBe("Olive O.");
    });

    it("in locked mode, goes to not_configured", async () => {
      const { state, cookie } = await begin();
      signedInEnv({ ALLOWED_EMAILS: "" });
      const { fetchMock } = stubTokenEndpoint(idTokenAnswer(googleClaims(CLIENT_ID)));
      const res = await back(`code=abc&state=${state}`, cookie);
      expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/login?error=not_configured`);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------- /auth/signout */

  describe("/auth/signout", () => {
    it("POST deletes the session, clears the cookie and goes to /login", async () => {
      const { cookie } = await signedIn();
      const other = await signedIn(); // another device stays signed in
      const res = await signOut(request("/auth/signout", { method: "POST", cookie, contentType: "application/x-www-form-urlencoded" }));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/login`);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(setCookieFor(res, SESSION)).toMatch(/^__Host-jt_session=; Path=\/; Max-Age=0; .*Secure; HttpOnly; SameSite=Lax$/);
      expect(await counts()).toEqual({ users: 1, sessions: 1 });
      expect((await getMe(request("/api/me", { cookie }), ctx())).status).toBe(401);
      expect((await getMe(request("/api/me", { cookie: other.cookie }), ctx())).status).toBe(200);
    });

    it("POST without a session still clears the cookie", async () => {
      const res = await signOut(request("/auth/signout", { method: "POST", contentType: null }));
      expect(res.status).toBe(303);
      expect(setCookieFor(res, SESSION)).toMatch(/Max-Age=0/);
    });

    it("refuses a POST from another origin or without Origin: the session stays", async () => {
      const { cookie } = await signedIn();
      for (const origin of ["https://evil.example", null]) {
        const res = await signOut(request("/auth/signout", { method: "POST", cookie, origin }));
        expect(res.status).toBe(403);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(setCookies(res)).toEqual([]);
      }
      expect(await counts()).toEqual({ users: 1, sessions: 1 });
    });

    it("GET answers 405 and signs nobody out", async () => {
      await signedIn();
      const res = await signOutGet();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await counts()).toEqual({ users: 1, sessions: 1 });
    });
  });
});
