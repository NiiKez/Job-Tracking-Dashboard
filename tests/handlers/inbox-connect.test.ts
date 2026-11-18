import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as callback } from "@/app/api/inbox/callback/route";
import { GET as connect } from "@/app/api/inbox/connect/route";
import { POST as disconnect } from "@/app/api/inbox/disconnect/route";
import { GET as getSettings } from "@/app/api/settings/route";
import { getDb } from "@/lib/server/db/client";
import { disconnectInbox } from "@/lib/server/inbox/oauth/connect";
import { decryptToken } from "@/lib/server/inbox/oauth/token-crypto";
import { proxy } from "@/proxy";
import type { Settings } from "@/lib/types";
import { describeDb, testSql } from "../helpers/test-db";
import { APP_ORIGIN, restoreEnv, setEnv, signedInEnv } from "../unit/auth/env";
import {
  ACCESS_TOKEN,
  fakeGoogle,
  GMAIL_SCOPE,
  gmailError,
  inboxEnv,
  KEY_HEX,
  REFRESH_TOKEN,
  tokenAnswer,
} from "../unit/inbox/connect-fakes";
import { ctx, OWNER, request, setCookieFor, setCookies, signedIn } from "./helpers";

// GET /api/inbox/connect, GET /api/inbox/callback and POST /api/inbox/disconnect on the real
// database, with Google's endpoints faked behind the global fetch (as the /auth tests do).
// The callback's steps one by one are also in tests/unit/inbox/connect.test.ts.

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

const engine = vi.hoisted(() => ({ aborted: [] as string[] }));
vi.mock("@/lib/server/inbox/sync/engine", () => ({
  abortSync: (userId: string) => engine.aborted.push(userId),
  isSyncing: () => false,
}));

const STATE = "__Secure-jt_inbox_oauth";
const SESSION = "__Host-jt_session";
const KEY = Buffer.from(KEY_HEX, "hex");
const SETTINGS = `${APP_ORIGIN}/settings`;
const CONNECTED = `${SETTINGS}?inbox=connected`;
const failed = (reason: string) => `${SETTINGS}?inbox=error&reason=${reason}`;
const LOGIN = `${APP_ORIGIN}/login?next=%2Fsettings`;

/** "name=value" from a Set-Cookie value. */
const pair = (setCookie: string | undefined) => (setCookie ?? "").split("; ")[0];

interface ConnectionRow {
  status: string;
  google_sub: string;
  email_address: string;
  refresh_token_enc: string | null;
  granted_scopes: string[];
  history_id: string | null;
  last_error_code: string | null;
  next_sync_at: Date | null;
}

async function connectionOf(userId: string): Promise<ConnectionRow | undefined> {
  const [row] = await testSql()<ConnectionRow[]>`
    SELECT status, google_sub, email_address, refresh_token_enc, granted_scopes, history_id, last_error_code, next_sync_at
    FROM inbox_connections WHERE user_id = ${userId}`;
  return row;
}

describeDb("the Gmail connect routes", () => {
  let session: Awaited<ReturnType<typeof signedIn>>;

  beforeEach(async () => {
    signedInEnv();
    inboxEnv();
    engine.aborted.length = 0;
    session = await signedIn();
  });
  afterEach(() => {
    restoreEnv();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Clicks Connect: Google's URL, the state and the state cookie. */
  async function begin(cookie = session.cookie) {
    const res = await connect(request("/api/inbox/connect", { cookie }));
    expect(res.status).toBe(303);
    const google = new URL(res.headers.get("location")!);
    return { res, google, state: google.searchParams.get("state")!, stateCookie: pair(setCookieFor(res, STATE)) };
  }

  /** Google's redirect back, with the session and state cookies. */
  function back(query: string, cookies: string[]) {
    return callback(request(`/api/inbox/callback?${query}`, { cookie: cookies.filter(Boolean).join("; ") }));
  }

  /** Connect from the start to the end with Google faked; answers the callback's response. */
  async function connectFully(answers: Parameters<typeof fakeGoogle>[0] = {}) {
    const { state, stateCookie } = await begin();
    const verifier: string = JSON.parse(Buffer.from(stateCookie.split("=")[1], "base64url").toString("utf8")).c;
    const google = fakeGoogle(answers);
    const res = await back(`code=4%2F0code&state=${state}&scope=${encodeURIComponent(GMAIL_SCOPE)}`, [session.cookie, stateCookie]);
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The state cookie is single-use: cleared on every outcome.
    expect(setCookieFor(res, STATE)).toMatch(/^__Secure-jt_inbox_oauth=; Path=\/api\/inbox; Max-Age=0; /);
    return { res, google, verifier, location: res.headers.get("location") };
  }

  /** Clicks Connect in Settings in demo mode: a navigation from this site. */
  function demoConnect(site: string | null = "same-origin") {
    const headers: Record<string, string> = site === null ? {} : { "sec-fetch-site": site };
    return connect(request("/api/inbox/connect", { cookie: session.cookie, headers }));
  }

  async function inboxSettings(cookie = session.cookie): Promise<Settings["inbox"]> {
    const res = await getSettings(request("/api/settings", { cookie }), ctx());
    expect(res.status).toBe(200);
    return ((await res.json()) as Settings).inbox;
  }

  /* -------------------------------------------------------- connect */

  describe("GET /api/inbox/connect", () => {
    it("sends the browser to Google for gmail.readonly, with a state cookie for /api/inbox", async () => {
      const { res, google, state, stateCookie } = await begin();
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      const q = google.searchParams;
      expect(q.get("redirect_uri")).toBe(`${APP_ORIGIN}/api/inbox/callback`);
      expect(q.get("scope")).toBe(`openid email ${GMAIL_SCOPE}`);
      expect(q.get("access_type")).toBe("offline");
      expect(q.get("prompt")).toBe("consent");
      expect(q.get("include_granted_scopes")).toBe("true");
      expect(q.get("login_hint")).toBe(OWNER.email);
      expect(q.get("code_challenge_method")).toBe("S256");
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(setCookieFor(res, STATE)).toMatch(
        /^__Secure-jt_inbox_oauth=[A-Za-z0-9_-]+; Path=\/api\/inbox; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/,
      );
      const stored = JSON.parse(Buffer.from(stateCookie.split("=")[1], "base64url").toString("utf8"));
      expect(stored.s).toBe(state);
      expect(stored.n).toBeNull();
      // Sign-in's own state cookie is untouched.
      expect(setCookieFor(res, "__Secure-jt_oauth")).toBeUndefined();
    });

    it("sends a signed-out browser to sign in, then back to Settings", async () => {
      const res = await connect(request("/api/inbox/connect"));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(LOGIN);
      expect(setCookies(res)).toEqual([]);

      // A cookie for a session that does not exist is cleared.
      const stale = await connect(request("/api/inbox/connect", { cookie: `${SESSION}=${"x".repeat(43)}` }));
      expect(stale.headers.get("location")).toBe(LOGIN);
      expect(setCookieFor(stale, SESSION)).toMatch(/Max-Age=0/);
    });

    it("says not_configured without INBOX_TOKEN_KEY, without going to Google", async () => {
      inboxEnv({ key: "" });
      const res = await connect(request("/api/inbox/connect", { cookie: session.cookie }));
      expect(res.headers.get("location")).toBe(failed("not_configured"));
      expect(setCookieFor(res, STATE)).toBeUndefined();
    });

    it("in demo mode connects the demo inbox without Google", async () => {
      inboxEnv({ key: "", mailSource: "fixture" });
      const google = fakeGoogle();
      const res = await demoConnect();
      expect(res.headers.get("location")).toBe(CONNECTED);
      expect(setCookieFor(res, STATE)).toBeUndefined();
      expect(google.urls).toEqual([]);
      expect(await connectionOf(session.user.id)).toMatchObject({
        status: "connected",
        google_sub: OWNER.sub,
        email_address: OWNER.email,
        refresh_token_enc: null,
      });
      expect(await inboxSettings()).toMatchObject({ state: "connected", address: OWNER.email, demo: true, configured: true });

      // A typed address counts as the user's own navigation too.
      await disconnect(request("/api/inbox/disconnect", { method: "POST", cookie: session.cookie }), ctx());
      expect((await demoConnect("none")).headers.get("location")).toBe(CONNECTED);
      expect((await connectionOf(session.user.id))!.status).toBe("connected");
    });

    it("in demo mode, a Gmail connection stays as it is, and Settings is told why", async () => {
      // A server started with MAIL_SOURCE=fixture on a database with a real mailbox.
      await connectFully();
      const row = async () => (await testSql()`SELECT * FROM inbox_connections WHERE user_id = ${session.user.id}`)[0];
      const before = await row();
      expect(before).toMatchObject({ demo: false, status: "connected" });
      inboxEnv({ mailSource: "fixture" });
      const google = fakeGoogle();

      for (const site of ["same-origin", "none"]) {
        const res = await demoConnect(site);
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe(failed("demo_gmail"));
      }
      expect(await row()).toEqual(before);
      expect(google.urls).toEqual([]); // nothing revoked
      expect(await inboxSettings()).toMatchObject({ state: "connected", address: OWNER.email, demo: true });
    });

    it("in demo mode, a navigation from another site lands on Settings and connects nothing", async () => {
      inboxEnv({ mailSource: "fixture" });
      // Never connected: still nothing.
      for (const site of ["cross-site", "same-site", null]) {
        const res = await demoConnect(site);
        expect(res.status, String(site)).toBe(303);
        expect(res.headers.get("location"), String(site)).toBe(SETTINGS);
        expect(await connectionOf(session.user.id), String(site)).toBeUndefined();
      }
      // Disconnected: stays disconnected (another site's link must not turn it back on).
      await demoConnect();
      await disconnect(request("/api/inbox/disconnect", { method: "POST", cookie: session.cookie }), ctx());
      for (const site of ["cross-site", "same-site", null]) {
        expect((await demoConnect(site)).headers.get("location"), String(site)).toBe(SETTINGS);
        expect((await connectionOf(session.user.id))!.status, String(site)).toBe("disconnected");
      }
      expect(await inboxSettings()).toMatchObject({ state: "not_connected", connected: false });
    });

    it("with Gmail, a navigation from another site still only leads to Google's consent screen", async () => {
      const res = await connect(request("/api/inbox/connect", { cookie: session.cookie, headers: { "sec-fetch-site": "cross-site" } }));
      expect(new URL(res.headers.get("location")!).origin).toBe("https://accounts.google.com");
      expect(await connectionOf(session.user.id)).toBeUndefined();
    });
  });

  /* ------------------------------------------------------- callback */

  describe("GET /api/inbox/callback", () => {
    it("stores the encrypted token, requests a sync and goes to Settings", async () => {
      const { location, google, verifier } = await connectFully();
      expect(location).toBe(CONNECTED);

      // The exchange: the code, this flow's PKCE verifier, the connect flow's redirect URI.
      expect(google.token).toHaveLength(1);
      expect(google.token[0].get("redirect_uri")).toBe(`${APP_ORIGIN}/api/inbox/callback`);
      expect(google.token[0].get("code")).toBe("4/0code");
      expect(google.token[0].get("code_verifier")).toBe(verifier);
      expect(google.profile).toHaveLength(1);
      expect(google.revoked).toEqual([]);

      const row = (await connectionOf(session.user.id))!;
      expect(row).toMatchObject({
        status: "connected",
        google_sub: OWNER.sub,
        email_address: OWNER.email,
        history_id: null,
        last_error_code: null,
      });
      expect(row.granted_scopes).toContain(GMAIL_SCOPE);
      expect(row.next_sync_at).not.toBeNull();
      expect(row.refresh_token_enc).not.toContain(REFRESH_TOKEN);
      expect(decryptToken(row.refresh_token_enc!, session.user.id, { current: KEY }).token).toBe(REFRESH_TOKEN);

      expect(await inboxSettings()).toEqual({
        provider: "gmail",
        address: OWNER.email,
        connected: true,
        state: "connected",
        syncing: false,
        backfill: null,
        lastCheckedAt: null,
        lastError: null,
        intervalMinutes: 15,
        configured: true,
        demo: false,
      });
    });

    it("sends a signed-out browser to sign in, clears the state cookie, calls nobody", async () => {
      const { state, stateCookie } = await begin();
      const google = fakeGoogle();
      const res = await back(`code=c&state=${state}`, [stateCookie]);
      expect(res.headers.get("location")).toBe(LOGIN);
      expect(setCookieFor(res, STATE)).toMatch(/Max-Age=0/);
      expect(google.urls).toEqual([]);
      expect(await connectionOf(session.user.id)).toBeUndefined();
    });

    it("state: a state that does not match, or no state cookie, before any call to Google", async () => {
      const first = await begin();
      const second = await begin();
      const google = fakeGoogle();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const mismatch = await back(`code=c&state=${second.state}`, [session.cookie, first.stateCookie]);
      expect(mismatch.headers.get("location")).toBe(failed("state"));
      expect(setCookieFor(mismatch, STATE)).toMatch(/Max-Age=0/);
      const missing = await back(`code=c&state=${first.state}`, [session.cookie]);
      expect(missing.headers.get("location")).toBe(failed("state"));
      // Sign-in's state cookie does not count: it is another flow.
      const signIn = await back(`code=c&state=${first.state}`, [session.cookie, first.stateCookie.replace(STATE, "__Secure-jt_oauth")]);
      expect(signIn.headers.get("location")).toBe(failed("state"));
      expect(google.urls).toEqual([]);
    });

    it("denied when the user cancels on Google's screen; other errors are exchange_failed", async () => {
      const google = fakeGoogle();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let flow = await begin();
      let res = await back(`error=access_denied&state=${flow.state}`, [session.cookie, flow.stateCookie]);
      expect(res.headers.get("location")).toBe(failed("denied"));
      flow = await begin();
      res = await back(`error=server_error&state=${flow.state}`, [session.cookie, flow.stateCookie]);
      expect(res.headers.get("location")).toBe(failed("exchange_failed"));
      expect(warn.mock.calls.flat().join(" ")).toContain("server_error");
      // The value comes from the URL: anything that is not a plain code stays out of the log.
      flow = await begin();
      res = await back(`error=x%0Ainbox%3A%20forged%20line&state=${flow.state}`, [session.cookie, flow.stateCookie]);
      expect(res.headers.get("location")).toBe(failed("exchange_failed"));
      expect(warn.mock.calls.flat().join(" ")).not.toContain("forged");
      flow = await begin();
      res = await back(`state=${flow.state}`, [session.cookie, flow.stateCookie]);
      expect(res.headers.get("location")).toBe(failed("exchange_failed"));
      expect(google.urls).toEqual([]);
    });

    it("exchange_failed when Google refuses the code; the log has its error code, no secrets", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { location } = await connectFully({
        token: () => Response.json({ error: "invalid_grant", error_description: "Bad Request" }, { status: 400 }),
      });
      expect(location).toBe(failed("exchange_failed"));
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("invalid_grant");
      expect(logged).not.toContain("4/0code");
      expect(logged).not.toContain("test-secret-not-real");
      expect(await connectionOf(session.user.id)).toBeUndefined();
    });

    it("scope_missing when the Gmail permission was not ticked: nothing stored, nothing revoked", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { location, google } = await connectFully({
        token: () => tokenAnswer({ scope: "openid https://www.googleapis.com/auth/userinfo.email" }),
      });
      expect(location).toBe(failed("scope_missing"));
      expect(google.revoked).toEqual([]);
      expect(google.profile).toEqual([]);
      expect(await connectionOf(session.user.id)).toBeUndefined();
    });

    it("account_mismatch for another Google account: that token is revoked, nothing stored, no mail read", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { location, google } = await connectFully({
        token: () => tokenAnswer({}, { sub: "110000000000000000777", email: "someone.else@example.com" }),
      });
      expect(location).toBe(failed("account_mismatch"));
      expect(google.revoked).toEqual([REFRESH_TOKEN]);
      expect(google.profile).toEqual([]);
      expect(await connectionOf(session.user.id)).toBeUndefined();
      expect(warn.mock.calls.flat().join(" ")).not.toMatch(/110000000000000000777|someone\.else/);
    });

    it("account_mismatch, not scope_missing, for another account with Gmail unticked: that grant is revoked", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { location, google } = await connectFully({
        token: () =>
          tokenAnswer({ scope: "openid https://www.googleapis.com/auth/userinfo.email" }, { sub: "110000000000000000777" }),
      });
      expect(location).toBe(failed("account_mismatch"));
      expect(google.revoked).toEqual([REFRESH_TOKEN]);
      expect(google.profile).toEqual([]);
      expect(await connectionOf(session.user.id)).toBeUndefined();
    });

    it("account_mismatch for another account's answer without a refresh token: the access token is revoked", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { location, google } = await connectFully({
        token: () => tokenAnswer({ refresh_token: undefined }, { sub: "110000000000000000777" }),
      });
      expect(location).toBe(failed("account_mismatch"));
      expect(google.revoked).toEqual([ACCESS_TOKEN]);
      expect(await connectionOf(session.user.id)).toBeUndefined();
    });

    it("account_mismatch leaves the token alone when another user has that account connected", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const other = await signedIn({ sub: "110000000000000000777", email: "someone.else@example.com", name: "S", picture: null });
      await testSql()`
        INSERT INTO inbox_connections (user_id, google_sub, email_address, status, refresh_token_enc)
        VALUES (${other.user.id}, '110000000000000000777', 'someone.else@example.com', 'connected', 'v1.00000000.x.y')`;
      const { location, google } = await connectFully({ token: () => tokenAnswer({}, { sub: "110000000000000000777" }) });
      expect(location).toBe(failed("account_mismatch"));
      expect(google.revoked).toEqual([]);
      expect((await connectionOf(other.user.id))!.status).toBe("connected");
    });

    it("gmail_api_disabled when the Gmail API is not enabled", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { location, google } = await connectFully({ profile: () => gmailError(403, "accessNotConfigured") });
      expect(location).toBe(failed("gmail_api_disabled"));
      expect(google.revoked).toEqual([]);
      expect(await connectionOf(session.user.id)).toBeUndefined();
    });

    it("not_configured when INBOX_TOKEN_KEY went missing during the flow, before any call to Google", async () => {
      const { state, stateCookie } = await begin();
      inboxEnv({ key: "" });
      const google = fakeGoogle();
      const res = await back(`code=c&state=${state}`, [session.cookie, stateCookie]);
      expect(res.headers.get("location")).toBe(failed("not_configured"));
      expect(google.urls).toEqual([]);
    });

    it("in demo mode refuses: no Google flow was started", async () => {
      const { state, stateCookie } = await begin();
      inboxEnv({ mailSource: "fixture" });
      const google = fakeGoogle();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await back(`code=c&state=${state}`, [session.cookie, stateCookie]);
      expect(res.headers.get("location")).toBe(failed("state"));
      expect(google.urls).toEqual([]);
      expect(await connectionOf(session.user.id)).toBeUndefined();
    });

    it("reconnects: a new token, the error cleared, the sync position and the ledger kept, nothing revoked", async () => {
      await connectFully();
      const sql = testSql();
      const userId = session.user.id;
      await sql`
        UPDATE inbox_connections SET status = 'needs_reconnect', history_id = '424242', backfill_state = 'done',
          last_error_code = 'token_revoked', last_error_at = now(), consecutive_failures = 2
        WHERE user_id = ${userId}`;
      await sql`INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result) VALUES (${userId}, '18c0ffee', 'stored')`;
      expect(await inboxSettings()).toMatchObject({ state: "needs_reconnect", lastError: { code: "token_revoked" } });

      const { location, google } = await connectFully({ token: () => tokenAnswer({ refresh_token: "1//0the-new-one" }) });
      expect(location).toBe(CONNECTED);
      expect(google.revoked).toEqual([]);
      const row = (await connectionOf(userId))!;
      expect(row).toMatchObject({ status: "connected", history_id: "424242", last_error_code: null });
      expect(decryptToken(row.refresh_token_enc!, userId, { current: KEY }).token).toBe("1//0the-new-one");
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM inbox_seen_messages WHERE user_id = ${userId}`;
      expect(n).toBe(1);
      expect(await inboxSettings()).toMatchObject({ state: "connected", lastError: null });
    });
  });

  /* ----------------------------------------------------- disconnect */

  describe("POST /api/inbox/disconnect", () => {
    const post = (cookie: string | null, opts: { origin?: string | null } = {}) =>
      disconnect(request("/api/inbox/disconnect", { method: "POST", cookie, ...opts }), ctx());

    it("stops the sync, revokes the token at Google, deletes it, and is idempotent", async () => {
      await connectFully();
      const google = fakeGoogle();
      const res = await post(session.cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, revoked: true });
      expect(engine.aborted).toEqual([session.user.id, session.user.id]); // before and after the delete
      expect(google.revoked).toEqual([REFRESH_TOKEN]);
      expect(await connectionOf(session.user.id)).toMatchObject({ status: "disconnected", refresh_token_enc: null });
      expect(await inboxSettings()).toMatchObject({ state: "not_connected", connected: false, address: OWNER.email });

      // Nothing stored any more: nothing left for the app to remove.
      const again = await post(session.cookie);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ ok: true, revoked: true });
      expect(google.revoked).toEqual([REFRESH_TOKEN]);
      expect(await connectionOf(session.user.id)).toMatchObject({ status: "disconnected" });
    });

    it("deletes the token even when Google cannot be reached, and says it was not revoked", async () => {
      await connectFully();
      vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await post(session.cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, revoked: false });
      expect(await connectionOf(session.user.id)).toMatchObject({ status: "disconnected", refresh_token_enc: null });
      expect(warn.mock.calls.flat().join(" ")).not.toContain(REFRESH_TOKEN);
    });

    it("says it was not revoked when Google refuses the revocation", async () => {
      await connectFully();
      // Not invalid_token: that one means the grant is already gone (revoked: true).
      const google = fakeGoogle({ revoke: () => Response.json({ error: "invalid_request" }, { status: 400 }) });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await post(session.cookie);
      expect(await res.json()).toEqual({ ok: true, revoked: false });
      expect(google.revoked).toEqual([REFRESH_TOKEN]);
      expect(await connectionOf(session.user.id)).toMatchObject({ status: "disconnected", refresh_token_enc: null });
    });

    it("says it was not revoked when Google does not answer in time", async () => {
      await connectFully();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const revokeToken = vi.fn(() => new Promise<void>(() => {}));
      const client = { revokeToken, refreshAccessToken: vi.fn() };
      expect(await disconnectInbox(session.user.id, { client, timeoutMs: 20, db: getDb() })).toEqual({ revoked: false });
      expect(revokeToken).toHaveBeenCalledWith(REFRESH_TOKEN);
      expect(await connectionOf(session.user.id)).toMatchObject({ status: "disconnected", refresh_token_enc: null });
    });

    it("stops the sync again once the token is deleted: a run may have started meanwhile", async () => {
      await connectFully();
      fakeGoogle();
      // A run the scheduler starts between the first abortSync and the end of clearConnection's
      // statement still sees the connection connected; only an abort after the statement stops it.
      engine.aborted.length = 0;
      let abortsBeforeClear = -1;
      const gapDb = new Proxy(getDb(), {
        async apply(target, thisArg, args) {
          const rows = await Reflect.apply(target, thisArg, args);
          abortsBeforeClear = engine.aborted.length;
          return rows;
        },
      });
      await disconnectInbox(session.user.id, { db: gapDb, timeoutMs: 20 });
      expect(abortsBeforeClear).toBe(1);
      expect(engine.aborted).toEqual([session.user.id, session.user.id]);
      expect(await connectionOf(session.user.id)).toMatchObject({ status: "disconnected", refresh_token_enc: null });
    });

    it("deletes a token it cannot decrypt, without revoking, and says it was not revoked", async () => {
      await connectFully();
      inboxEnv({ key: "cd".repeat(32) });
      const google = fakeGoogle();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await post(session.cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, revoked: false });
      expect(google.revoked).toEqual([]);
      expect(await connectionOf(session.user.id)).toMatchObject({ status: "disconnected", refresh_token_enc: null });
    });

    it("works without a connection, and in demo mode: nothing at Google to remove", async () => {
      const google = fakeGoogle();
      const none = await post(session.cookie);
      expect(none.status).toBe(200);
      expect(await none.json()).toEqual({ ok: true, revoked: true });
      expect(await connectionOf(session.user.id)).toBeUndefined();

      inboxEnv({ mailSource: "fixture" });
      await demoConnect();
      const demo = await post(session.cookie);
      expect(demo.status).toBe(200);
      expect(await demo.json()).toEqual({ ok: true, revoked: true });
      expect(await connectionOf(session.user.id)).toMatchObject({ status: "disconnected" });
      expect(google.urls).toEqual([]);
    });

    it("refuses a request from another origin, and a signed-out one", async () => {
      await connectFully();
      const google = fakeGoogle();
      expect((await post(session.cookie, { origin: "https://evil.example" })).status).toBe(403);
      expect((await post(session.cookie, { origin: null })).status).toBe(403);
      expect((await post(null)).status).toBe(401);
      expect(google.revoked).toEqual([]);
      expect(engine.aborted).toEqual([]);
      expect((await connectionOf(session.user.id))!.status).toBe("connected");
    });
  });

  /* ---------------------------------------------------------- proxy */

  describe("the proxy", () => {
    const run = (path: string, opts: { method?: string; cookie?: string } = {}) =>
      proxy(
        new NextRequest(`http://localhost:3800${path}`, {
          method: opts.method ?? "GET",
          headers: opts.cookie ? { cookie: opts.cookie } : {},
        }),
      );

    it("sends a signed-out browser on the two flows to sign in, then to Settings", () => {
      for (const path of ["/api/inbox/connect", "/api/inbox/callback?code=x&state=y"]) {
        const res = run(path);
        expect(res.status, path).toBe(307);
        expect(res.headers.get("location"), path).toBe(LOGIN);
      }
      setEnv({ APP_URL: APP_ORIGIN });
      expect(run("/api/inbox/connect").headers.get("location")).toBe(
        `${APP_ORIGIN}/login?error=not_configured&next=%2Fsettings`,
      );
    });

    it("keeps the JSON 401 for the rest of /api/inbox, and passes requests with a session cookie", () => {
      expect(run("/api/inbox/disconnect", { method: "POST" }).status).toBe(401);
      expect(run("/api/inbox/check", { method: "POST" }).status).toBe(401);
      expect(run("/api/inbox/connect", { method: "POST" }).status).toBe(401);
      expect(run("/api/inbox/connect/x").status).toBe(401);
      expect(run("/api/inbox/connect", { cookie: `${SESSION}=abc` }).headers.get("x-middleware-next")).toBe("1");
    });
  });
});
