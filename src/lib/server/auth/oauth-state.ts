import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { generateCodeVerifier, generateState } from "arctic";
import { safeNextPath } from "@/lib/domain/safe-next";
import { isSecureApp } from "@/lib/server/env";
import { serializeCookie } from "./session";

/**
 * The short-lived cookie that carries an OAuth flow's state, PKCE verifier and `next` path from
 * the redirect to Google until the callback. Generic: sign-in uses { name: "jt_oauth" }, area 2's
 * Gmail connection { name: "jt_inbox_oauth" }.
 *
 * Cookie: like the session cookie (session.ts), `__Host-<name>` (Secure, Path=/) when APP_URL is
 * https, else the plain `<name>` without Secure (local development over http). HttpOnly,
 * SameSite=Lax (Google's redirect back is a top-level GET, which Lax allows), Max-Age 10 minutes.
 * Only the name that matches APP_URL is read.
 *
 * Why Path=/ and not the callback's own path: only Path=/ allows the `__Host-` prefix, and only
 * `__Host-` (no Domain, set by this host over https) keeps out a copy planted by another host
 * under the same parent domain, such as the public demo on a sibling subdomain. A `__Secure-`
 * cookie with a narrower path refuses plain http but not a sibling's `Domain=` cookie. The price
 * is that the cookie travels with every request to the app for its 10 minutes.
 *
 * The issue time travels inside the value, so an old cookie is refused even if a browser kept it.
 *
 *   const flow = startOAuthState(COOKIE, nextFromQuery);
 *   //   redirect to Google with flow.state and flow.codeVerifier; send flow.setCookie
 *   const result = finishOAuthState(req, COOKIE, req.nextUrl.searchParams.get("state"));
 *   //   always send result.clearCookie; on result.ok use result.codeVerifier and result.next
 */

export interface OAuthStateCookie {
  /** Base name, without a prefix (e.g. "jt_oauth"); one per flow, so two flows never mix. */
  name: string;
}

/** Every state cookie's path: the `__Host-` prefix requires exactly "/". */
const OAUTH_STATE_PATH = "/";

export const OAUTH_STATE_MAX_AGE_SECONDS = 600;
/** generateState() and generateCodeVerifier() give 43 characters; anything far longer is junk. */
const MAX_STATE_LENGTH = 128;

export interface OAuthStart {
  state: string;
  codeVerifier: string;
  /** The sanitized `next` path (safeNextPath), or null. */
  next: string | null;
  /** Set-Cookie value that stores the flow. */
  setCookie: string;
}

export type OAuthStateProblem = "missing" | "malformed" | "expired" | "mismatch";

export type OAuthFinish =
  | { ok: true; codeVerifier: string; next: string | null; clearCookie: string }
  | {
      ok: false;
      problem: OAuthStateProblem;
      /** The saved `next`, when the cookie could be read: kept on the error redirect. */
      next: string | null;
      clearCookie: string;
    };

interface Stored {
  v: 1;
  /** state */
  s: string;
  /** PKCE code verifier */
  c: string;
  /** next path or null */
  n: string | null;
  /** issued at, seconds since the epoch */
  t: number;
}

/** The cookie's full name for the current APP_URL: `__Host-` prefixed under https. */
export function oauthStateCookieName(cookie: OAuthStateCookie): string {
  return isSecureApp() ? `__Host-${cookie.name}` : cookie.name;
}

function setCookieValue(cookie: OAuthStateCookie, value: string, maxAge: number): string {
  return serializeCookie(oauthStateCookieName(cookie), value, {
    path: OAUTH_STATE_PATH,
    maxAge,
    secure: isSecureApp(),
    httpOnly: true,
    sameSite: "Lax",
  });
}

/** Creates the state and PKCE verifier and the cookie that stores them with the sanitized `next`. */
export function startOAuthState(
  cookie: OAuthStateCookie,
  next: string | null | undefined,
  now: number = Date.now(),
): OAuthStart {
  const stored: Stored = {
    v: 1,
    s: generateState(),
    c: generateCodeVerifier(),
    n: safeNextPath(next),
    t: Math.floor(now / 1000),
  };
  const value = Buffer.from(JSON.stringify(stored), "utf8").toString("base64url");
  return {
    state: stored.s,
    codeVerifier: stored.c,
    next: stored.n,
    setCookie: setCookieValue(cookie, value, OAUTH_STATE_MAX_AGE_SECONDS),
  };
}

/** Set-Cookie that deletes the state cookie. */
export function clearedOAuthStateCookie(cookie: OAuthStateCookie): string {
  return setCookieValue(cookie, "", 0);
}

/**
 * Reads the state cookie on the callback and compares its state with the one Google sent back,
 * in constant time. The cookie is single-use: always send `clearCookie`, whatever the outcome.
 */
export function finishOAuthState(
  req: NextRequest,
  cookie: OAuthStateCookie,
  receivedState: string | null | undefined,
  now: number = Date.now(),
): OAuthFinish {
  const clearCookie = clearedOAuthStateCookie(cookie);
  const raw = req.cookies.get(oauthStateCookieName(cookie))?.value;
  if (!raw) return { ok: false, problem: "missing", next: null, clearCookie };
  const stored = parseStored(raw);
  if (!stored) return { ok: false, problem: "malformed", next: null, clearCookie };
  const next = safeNextPath(stored.n);
  const age = Math.floor(now / 1000) - stored.t;
  if (age < 0 || age > OAUTH_STATE_MAX_AGE_SECONDS) return { ok: false, problem: "expired", next, clearCookie };
  if (!receivedState || !sameString(receivedState, stored.s)) {
    return { ok: false, problem: "mismatch", next, clearCookie };
  }
  return { ok: true, codeVerifier: stored.c, next, clearCookie };
}

function parseStored(raw: string): Stored | null {
  if (raw.length > 4096) return null;
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const isToken = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_STATE_LENGTH;
  if (d.v !== 1 || !isToken(d.s) || !isToken(d.c)) return null;
  if (d.n !== null && typeof d.n !== "string") return null;
  if (typeof d.t !== "number" || !Number.isSafeInteger(d.t)) return null;
  return { v: 1, s: d.s, c: d.c, n: d.n, t: d.t };
}

/** Constant-time string comparison; different lengths are simply unequal. */
function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
