import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { generateCodeVerifier, generateState } from "arctic";
import { safeNextPath } from "@/lib/domain/safe-next";
import { isSecureApp } from "@/lib/server/env";
import { serializeCookie } from "./session";

/**
 * The short-lived cookie that carries an OAuth flow's state, PKCE verifier and `next` path from
 * the redirect to Google until the callback. Generic: sign-in uses { name: "jt_oauth", path:
 * "/auth" }, area 2's Gmail connection its own name with path "/api/inbox".
 *
 * Cookie: HttpOnly, SameSite=Lax (Google's redirect back is a top-level GET, which Lax allows),
 * Max-Age 10 minutes, Path from the caller. Under https it is Secure and prefixed: `__Host-` when
 * the path is "/", else `__Secure-` (both make browsers refuse a copy planted over plain http).
 * The issue time travels inside the value, so an old cookie is refused even if a browser kept it.
 *
 *   const flow = startOAuthState(COOKIE, nextFromQuery);
 *   //   redirect to Google with flow.state and flow.codeVerifier; send flow.setCookie
 *   const result = finishOAuthState(req, COOKIE, req.nextUrl.searchParams.get("state"));
 *   //   always send result.clearCookie; on result.ok use result.codeVerifier and result.next
 */

export interface OAuthStateCookie {
  /** Base name, without a prefix (e.g. "jt_oauth"). */
  name: string;
  /** Cookie path: the narrowest path that covers the callback (e.g. "/auth"). */
  path: string;
}

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

/** The cookie's full name: prefixed under https. */
export function oauthStateCookieName(cookie: OAuthStateCookie): string {
  if (!isSecureApp()) return cookie.name;
  return cookie.path === "/" ? `__Host-${cookie.name}` : `__Secure-${cookie.name}`;
}

function setCookieValue(cookie: OAuthStateCookie, value: string, maxAge: number): string {
  return serializeCookie(oauthStateCookieName(cookie), value, {
    path: cookie.path,
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
