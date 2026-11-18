import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  finishOAuthState,
  OAUTH_STATE_MAX_AGE_SECONDS,
  oauthStateCookieName,
  startOAuthState,
  type OAuthStateCookie,
} from "@/lib/server/auth/oauth-state";
import { restoreEnv, signedInEnv } from "./env";

const SIGN_IN: OAuthStateCookie = { name: "jt_oauth", path: "/auth" };
const INBOX: OAuthStateCookie = { name: "jt_inbox_oauth", path: "/api/inbox" };
const ROOT: OAuthStateCookie = { name: "jt_root", path: "/" };
const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);

/** "name=value" from a Set-Cookie header. */
const pair = (setCookie: string) => setCookie.split("; ")[0];

function callback(cookieHeader: string | null, path = "/auth/google/callback"): NextRequest {
  return new NextRequest(`https://jobs.example.com${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

describe("oauth state cookie", () => {
  afterEach(restoreEnv);

  it("round trip: the callback gets the verifier and the sanitized next back", () => {
    signedInEnv();
    const flow = startOAuthState(SIGN_IN, "/jobs?status=applied", T0);
    expect(flow.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.state).not.toBe(flow.codeVerifier);
    expect(flow.next).toBe("/jobs?status=applied");

    const result = finishOAuthState(callback(pair(flow.setCookie)), SIGN_IN, flow.state, T0 + 5_000);
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ codeVerifier: flow.codeVerifier, next: "/jobs?status=applied" });
  });

  it("drops an unsafe next when starting", () => {
    signedInEnv();
    for (const next of ["//evil.example", "https://evil.example", "/login", null, undefined]) {
      const flow = startOAuthState(SIGN_IN, next, T0);
      expect(flow.next).toBeNull();
      const result = finishOAuthState(callback(pair(flow.setCookie)), SIGN_IN, flow.state, T0);
      expect(result).toMatchObject({ ok: true, next: null });
    }
  });

  it("over https: __Secure- prefix for a sub-path, Secure, HttpOnly, SameSite=Lax, 10 minutes", () => {
    signedInEnv({ APP_URL: "https://jobs.example.com" });
    const flow = startOAuthState(SIGN_IN, null, T0);
    expect(flow.setCookie).toMatch(
      /^__Secure-jt_oauth=[A-Za-z0-9_-]+; Path=\/auth; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/,
    );
    expect(oauthStateCookieName(INBOX)).toBe("__Secure-jt_inbox_oauth");
    expect(startOAuthState(INBOX, null, T0).setCookie).toContain("; Path=/api/inbox; ");
  });

  it("over https with Path=/: the __Host- prefix", () => {
    signedInEnv({ APP_URL: "https://jobs.example.com" });
    expect(oauthStateCookieName(ROOT)).toBe("__Host-jt_root");
    expect(startOAuthState(ROOT, null, T0).setCookie).toMatch(/^__Host-jt_root=[^;]+; Path=\/; /);
  });

  it("over http: no prefix and no Secure", () => {
    signedInEnv({ APP_URL: "http://localhost:3800" });
    const flow = startOAuthState(SIGN_IN, null, T0);
    expect(flow.setCookie).toMatch(/^jt_oauth=[A-Za-z0-9_-]+; Path=\/auth; Max-Age=600; HttpOnly; SameSite=Lax$/);
  });

  it("always clears the cookie, on success and on failure", () => {
    signedInEnv();
    const flow = startOAuthState(SIGN_IN, null, T0);
    const ok = finishOAuthState(callback(pair(flow.setCookie)), SIGN_IN, flow.state, T0);
    const bad = finishOAuthState(callback(null), SIGN_IN, flow.state, T0);
    for (const { clearCookie } of [ok, bad]) {
      expect(clearCookie).toMatch(/^__Secure-jt_oauth=; Path=\/auth; Max-Age=0; /);
      expect(clearCookie).toContain("; Secure; HttpOnly; SameSite=Lax");
    }
  });

  it("fails when the cookie is missing", () => {
    signedInEnv();
    const flow = startOAuthState(SIGN_IN, "/jobs", T0);
    expect(finishOAuthState(callback(null), SIGN_IN, flow.state, T0)).toMatchObject({
      ok: false,
      problem: "missing",
      next: null,
    });
    // Same value under another name (the http one, or another flow's) does not count.
    const value = pair(flow.setCookie).split("=")[1];
    expect(finishOAuthState(callback(`jt_oauth=${value}`), SIGN_IN, flow.state, T0)).toMatchObject({
      problem: "missing",
    });
    expect(finishOAuthState(callback(pair(flow.setCookie)), INBOX, flow.state, T0)).toMatchObject({
      problem: "missing",
    });
  });

  it("fails on a state that differs from the cookie's, keeping next", () => {
    signedInEnv();
    const flow = startOAuthState(SIGN_IN, "/jobs", T0);
    const other = startOAuthState(SIGN_IN, null, T0);
    const cookie = pair(flow.setCookie);
    for (const state of [other.state, `${flow.state}x`, flow.state.slice(1), "", null, undefined]) {
      expect(finishOAuthState(callback(cookie), SIGN_IN, state, T0)).toMatchObject({
        ok: false,
        problem: "mismatch",
        next: "/jobs",
      });
    }
  });

  it("fails on a tampered cookie", () => {
    signedInEnv();
    const flow = startOAuthState(SIGN_IN, "/jobs", T0);
    const [name, value] = pair(flow.setCookie).split("=");
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url");

    for (const tampered of [
      "not-base64-json",
      encode("a string"),
      encode({ ...decoded, v: 2 }),
      encode({ ...decoded, s: 42 }),
      encode({ ...decoded, c: "" }),
      encode({ ...decoded, t: "soon" }),
      encode({ ...decoded, n: 5 }),
    ]) {
      expect(finishOAuthState(callback(`${name}=${tampered}`), SIGN_IN, flow.state, T0)).toMatchObject({
        ok: false,
        problem: "malformed",
      });
    }

    // A cookie whose state was swapped for the attacker's own still has to match the query.
    const swapped = encode({ ...decoded, s: "attacker-state" });
    expect(finishOAuthState(callback(`${name}=${swapped}`), SIGN_IN, flow.state, T0)).toMatchObject({
      problem: "mismatch",
    });
    // A next planted in the cookie is sanitized again on the way out.
    const evil = encode({ ...decoded, n: "//evil.example" });
    expect(finishOAuthState(callback(`${name}=${evil}`), SIGN_IN, flow.state, T0)).toMatchObject({
      ok: true,
      next: null,
    });
  });

  it("fails once the cookie is older than 10 minutes, even if the browser kept it", () => {
    signedInEnv();
    const flow = startOAuthState(SIGN_IN, "/jobs", T0);
    const cookie = callback(pair(flow.setCookie));
    const limit = T0 + OAUTH_STATE_MAX_AGE_SECONDS * 1000;
    expect(finishOAuthState(cookie, SIGN_IN, flow.state, limit).ok).toBe(true);
    expect(finishOAuthState(cookie, SIGN_IN, flow.state, limit + 1000)).toMatchObject({
      ok: false,
      problem: "expired",
      next: "/jobs",
    });
    // Issued in the future: refused too.
    expect(finishOAuthState(cookie, SIGN_IN, flow.state, T0 - 2000)).toMatchObject({ problem: "expired" });
  });
});
