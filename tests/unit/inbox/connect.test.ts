import { createHash } from "node:crypto";
import { Google } from "arctic";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_IN_STATE_COOKIE } from "@/lib/server/auth/google";
import {
  CONNECT_ERROR_REASONS,
  connectAuthorizationUrl,
  gmailConnectConfigured,
  INBOX_SCOPES,
  INBOX_STATE_COOKIE,
  isOwnNavigation,
  settingsPath,
  verifyGrant,
} from "@/lib/server/inbox/oauth/connect";
import { OWNER } from "../../handlers/helpers";
import { APP_ORIGIN, CLIENT_ID, restoreEnv, setEnv, signedInEnv } from "../auth/env";
import {
  ACCESS_TOKEN,
  fakeGoogle,
  GMAIL_SCOPE,
  gmailError,
  inboxEnv,
  profileAnswer,
  REFRESH_TOKEN,
  tokenAnswer,
} from "./connect-fakes";

// The connect flow's pure parts and callback steps 2 to 5 (verifyGrant), against fake Google
// endpoints. The routes, the database and the cookies are in tests/handlers/inbox-connect.test.ts.

// The sync engine's run registry is not needed here.
vi.mock("@/lib/server/inbox/sync/engine", () => ({ abortSync: vi.fn(), isSyncing: () => false }));

const USER = { googleSub: OWNER.sub };

beforeEach(() => {
  signedInEnv();
  inboxEnv();
});
afterEach(() => {
  restoreEnv();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("constants and paths", () => {
  it("lists exactly the plan's reasons, plus not_configured and demo mode's demo_gmail", () => {
    expect(CONNECT_ERROR_REASONS).toEqual([
      "denied",
      "scope_missing",
      "account_mismatch",
      "gmail_api_disabled",
      "state",
      "exchange_failed",
      "not_configured",
      "demo_gmail",
    ]);
  });

  it("builds the Settings paths", () => {
    expect(settingsPath({ ok: true })).toBe("/settings?inbox=connected");
    expect(settingsPath({ ok: false, reason: "scope_missing" })).toBe("/settings?inbox=error&reason=scope_missing");
  });

  it("uses its own state cookie, apart from sign-in's (both Path=/, so __Host- under https)", () => {
    expect(INBOX_STATE_COOKIE).toEqual({ name: "jt_inbox_oauth" });
    expect(INBOX_STATE_COOKIE.name).not.toBe(SIGN_IN_STATE_COOKIE.name);
  });

  it("is configured only with Google sign-in and INBOX_TOKEN_KEY", () => {
    expect(gmailConnectConfigured()).toBe(true);
    inboxEnv({ key: "" });
    expect(gmailConnectConfigured()).toBe(false);
    inboxEnv();
    signedInEnv({ GOOGLE_CLIENT_SECRET: "" });
    expect(gmailConnectConfigured()).toBe(false);
  });
});

describe("isOwnNavigation (demo mode's connect)", () => {
  const nav = (site?: string) => ({ headers: new Headers(site === undefined ? {} : { "sec-fetch-site": site }) });

  it("accepts a click on this site and a typed address", () => {
    expect(isOwnNavigation(nav("same-origin"))).toBe(true);
    expect(isOwnNavigation(nav("none"))).toBe(true);
  });

  it("refuses another site, a sibling subdomain, an odd value and no header", () => {
    expect(isOwnNavigation(nav("cross-site"))).toBe(false);
    expect(isOwnNavigation(nav("same-site"))).toBe(false);
    expect(isOwnNavigation(nav("Same-Origin"))).toBe(false);
    expect(isOwnNavigation(nav(""))).toBe(false);
    expect(isOwnNavigation(nav())).toBe(false);
  });
});

describe("connectAuthorizationUrl", () => {
  it("asks for gmail.readonly with offline access, consent, granted scopes and a login hint", () => {
    const url = connectAuthorizationUrl("state-123", "verifier-abc", OWNER.email);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe(`${APP_ORIGIN}/api/inbox/callback`);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe(`openid email ${GMAIL_SCOPE}`);
    expect(INBOX_SCOPES).toEqual(["openid", "email", GMAIL_SCOPE]);
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("login_hint")).toBe(OWNER.email);
    expect(q.get("state")).toBe("state-123");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(createHash("sha256").update("verifier-abc").digest("base64url"));
  });

  it("throws while sign-in is not configured", () => {
    setEnv({});
    expect(() => connectAuthorizationUrl("s", "v", OWNER.email)).toThrow();
  });
});

describe("verifyGrant (callback steps 2 to 5)", () => {
  it("exchanges the code, checks the grant and the account, reads the profile", async () => {
    const google = fakeGoogle();
    const result = await verifyGrant("4/0code", "verifier-abc", USER);
    expect(result).toEqual({
      ok: true,
      grant: {
        googleSub: OWNER.sub,
        emailAddress: OWNER.email, // lower-cased
        refreshToken: REFRESH_TOKEN,
        grantedScopes: [GMAIL_SCOPE, "https://www.googleapis.com/auth/userinfo.email", "openid"],
      },
    });
    // The exchange: code, PKCE verifier and the connect flow's redirect URI.
    expect(google.token).toHaveLength(1);
    expect(google.token[0].get("grant_type")).toBe("authorization_code");
    expect(google.token[0].get("code")).toBe("4/0code");
    expect(google.token[0].get("code_verifier")).toBe("verifier-abc");
    expect(google.token[0].get("redirect_uri")).toBe(`${APP_ORIGIN}/api/inbox/callback`);
    // getProfile with the new access token; nothing revoked.
    expect(google.profile).toEqual([`Bearer ${ACCESS_TOKEN}`]);
    expect(google.revoked).toEqual([]);
  });

  it("not_configured without Google sign-in, before calling Google", async () => {
    setEnv({});
    const google = fakeGoogle();
    expect(await verifyGrant("c", "v", USER)).toMatchObject({ ok: false, reason: "not_configured" });
    expect(google.urls).toEqual([]);
  });

  it("exchange_failed when Google refuses the code, without its text", async () => {
    fakeGoogle({
      token: () => Response.json({ error: "invalid_grant", error_description: "secret-ish text" }, { status: 400 }),
    });
    const result = await verifyGrant("c", "v", USER);
    expect(result).toEqual({ ok: false, reason: "exchange_failed", detail: "code exchange failed: invalid_grant" });
  });

  it("exchange_failed when the token endpoint is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(await verifyGrant("c", "v", USER)).toMatchObject({ ok: false, reason: "exchange_failed" });
  });

  it("exchange_failed when the exchange does not answer in time", async () => {
    const client = Object.assign(new Google(CLIENT_ID, "x", `${APP_ORIGIN}/api/inbox/callback`), {
      validateAuthorizationCode: () => new Promise<never>(() => {}),
    });
    const result = await verifyGrant("c", "v", USER, { client, timeoutMs: 20 });
    expect(result).toEqual({ ok: false, reason: "exchange_failed", detail: "code exchange failed: Error" });
  });

  it.each([
    ["no refresh token", { refresh_token: undefined }],
    ["no access token", { access_token: undefined }],
    ["a refresh token with spaces", { refresh_token: "a b" }],
    ["no ID token", { id_token: undefined }],
  ])("exchange_failed with %s, and nothing revoked or read", async (_name, overrides) => {
    const google = fakeGoogle({ token: () => tokenAnswer(overrides) });
    expect(await verifyGrant("c", "v", USER)).toMatchObject({ ok: false, reason: "exchange_failed" });
    expect(google.revoked).toEqual([]);
    expect(google.profile).toEqual([]);
  });

  it.each([
    ["an expired ID token", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ["another client's ID token", { aud: "other.apps.googleusercontent.com", azp: "other.apps.googleusercontent.com" }],
    ["a foreign issuer", { iss: "https://evil.example" }],
  ])("exchange_failed with %s", async (_name, claims) => {
    fakeGoogle({ token: () => tokenAnswer({}, claims) });
    expect(await verifyGrant("c", "v", USER)).toMatchObject({ ok: false, reason: "exchange_failed" });
  });

  it.each([
    ["gmail.readonly unticked", { scope: "openid https://www.googleapis.com/auth/userinfo.email" }],
    ["no scope in the answer", { scope: undefined }],
    ["a scope that only contains the name", { scope: `${GMAIL_SCOPE}.extra` }],
  ])("scope_missing with %s: not revoked, no Gmail call", async (_name, overrides) => {
    const google = fakeGoogle({ token: () => tokenAnswer(overrides) });
    expect(await verifyGrant("c", "v", USER)).toMatchObject({ ok: false, reason: "scope_missing" });
    expect(google.revoked).toEqual([]);
    expect(google.profile).toEqual([]);
  });

  it("account_mismatch for another Google account: revokes that new token, reads no mail", async () => {
    const google = fakeGoogle({ token: () => tokenAnswer({}, { sub: "110000000000000000999", email: "else@example.com" }) });
    const result = await verifyGrant("c", "v", USER);
    expect(result).toEqual({ ok: false, reason: "account_mismatch", detail: "another account, revoked: true" });
    expect(google.revoked).toEqual([REFRESH_TOKEN]);
    expect(google.profile).toEqual([]);
  });

  // Another account is checked before the rest of the answer, so its grant is never left behind.
  const OTHER = { sub: "110000000000000000999", email: "else@example.com" };

  it("account_mismatch, not scope_missing, for another account with Gmail unticked: that grant is revoked", async () => {
    const google = fakeGoogle({ token: () => tokenAnswer({ scope: "openid https://www.googleapis.com/auth/userinfo.email" }, OTHER) });
    const result = await verifyGrant("c", "v", USER);
    expect(result).toEqual({ ok: false, reason: "account_mismatch", detail: "another account, revoked: true" });
    expect(google.revoked).toEqual([REFRESH_TOKEN]);
    expect(google.profile).toEqual([]);
  });

  it.each([
    ["no refresh token", { refresh_token: undefined }],
    ["a refresh token that is not one", { refresh_token: "a b" }],
  ])("account_mismatch for another account with %s: the access token is revoked", async (_name, overrides) => {
    const google = fakeGoogle({ token: () => tokenAnswer(overrides, OTHER) });
    const result = await verifyGrant("c", "v", USER);
    expect(result).toEqual({ ok: false, reason: "account_mismatch", detail: "another account, revoked (access token): true" });
    expect(google.revoked).toEqual([ACCESS_TOKEN]);
    expect(google.profile).toEqual([]);
  });

  it("account_mismatch for another account with neither token: nothing to revoke", async () => {
    const google = fakeGoogle({ token: () => tokenAnswer({ refresh_token: undefined, access_token: undefined }, OTHER) });
    const result = await verifyGrant("c", "v", USER);
    expect(result).toEqual({ ok: false, reason: "account_mismatch", detail: "another account, no token to revoke" });
    expect(google.revoked).toEqual([]);
  });

  it.each([
    ["an unverified address", { email_verified: false }],
    ["no address", { email: undefined }],
    ["an expired ID token", { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ])("account_mismatch for another account whose ID token has %s: that grant is revoked", async (_name, claims) => {
    const google = fakeGoogle({ token: () => tokenAnswer({}, { ...OTHER, ...claims }) });
    expect(await verifyGrant("c", "v", USER)).toMatchObject({ ok: false, reason: "account_mismatch" });
    expect(google.revoked).toEqual([REFRESH_TOKEN]);
  });

  it("exchange_failed for an ID token without a usable subject: no account, nothing revoked", async () => {
    for (const sub of ["", "   ", 42, "x".repeat(256)]) {
      const google = fakeGoogle({ token: () => tokenAnswer({}, { sub }) });
      expect(await verifyGrant("c", "v", USER)).toEqual({ ok: false, reason: "exchange_failed", detail: "ID token subject" });
      expect(google.revoked).toEqual([]);
    }
  });

  it("account_mismatch keeps the rule for an account another user holds, also when only the access token came back", async () => {
    const google = fakeGoogle({ token: () => tokenAnswer({ refresh_token: undefined }, OTHER) });
    const revokeUnless = vi.fn(async () => true);
    expect(await verifyGrant("c", "v", USER, { revokeUnless })).toEqual({
      ok: false,
      reason: "account_mismatch",
      detail: "another account, held by another user: not revoked",
    });
    expect(revokeUnless).toHaveBeenCalledWith(OTHER.sub);
    expect(google.revoked).toEqual([]);
  });

  it("account_mismatch still fails when the revocation fails", async () => {
    const google = fakeGoogle({
      token: () => tokenAnswer({}, { sub: "other-sub" }),
      revoke: () => new Response("nope", { status: 503 }),
    });
    expect(await verifyGrant("c", "v", USER)).toMatchObject({ ok: false, reason: "account_mismatch" });
    expect(google.revoked).toEqual([REFRESH_TOKEN]);
  });

  it("account_mismatch does not revoke when another user's connection holds that account", async () => {
    const google = fakeGoogle({ token: () => tokenAnswer({}, { sub: "other-sub" }) });
    const revokeUnless = vi.fn(async () => true);
    expect(await verifyGrant("c", "v", USER, { revokeUnless })).toMatchObject({ ok: false, reason: "account_mismatch" });
    expect(revokeUnless).toHaveBeenCalledWith("other-sub");
    expect(google.revoked).toEqual([]);

    // A failing check counts as "held": never risk ending someone else's connection.
    const failing = vi.fn(async () => Promise.reject(new Error("db down")));
    expect(await verifyGrant("c", "v", USER, { revokeUnless: failing })).toMatchObject({ reason: "account_mismatch" });
    expect(google.revoked).toEqual([]);
  });

  it("gmail_api_disabled when getProfile answers 403 accessNotConfigured", async () => {
    const google = fakeGoogle({ profile: () => gmailError(403, "accessNotConfigured") });
    expect(await verifyGrant("c", "v", USER)).toMatchObject({ ok: false, reason: "gmail_api_disabled" });
    expect(google.revoked).toEqual([]);
  });

  it("scope_missing when getProfile answers 403 insufficientPermissions", async () => {
    fakeGoogle({ profile: () => gmailError(403, "insufficientPermissions") });
    expect(await verifyGrant("c", "v", USER)).toMatchObject({ ok: false, reason: "scope_missing" });
  });

  it("exchange_failed when getProfile fails otherwise, after one attempt (the user is waiting)", async () => {
    let google = fakeGoogle({ profile: () => gmailError(500, "backendError") });
    expect(await verifyGrant("c", "v", USER)).toEqual({
      ok: false,
      reason: "exchange_failed",
      detail: "users.getProfile failed: google_unavailable",
    });
    expect(google.profile).toHaveLength(1);

    google = fakeGoogle({ profile: () => new Response(null, { status: 401 }) });
    expect(await verifyGrant("c", "v", USER)).toMatchObject({ reason: "exchange_failed" });

    fakeGoogle({ profile: () => profileAnswer("not an address") });
    expect(await verifyGrant("c", "v", USER)).toMatchObject({ reason: "exchange_failed" });
  });
});
