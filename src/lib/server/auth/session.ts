import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import type { Db } from "@/lib/server/db/client";
import { isSecureApp } from "@/lib/server/env";
import {
  deleteSessionByTokenHash,
  findSessionByTokenHash,
  insertSession,
  touchSession,
  type SessionWithUser,
} from "@/lib/server/repo/sessions";

/**
 * Sessions: a random 256-bit token in an HttpOnly cookie, its SHA-256 in the sessions table.
 *
 * Cookie: `__Host-jt_session` (Secure, Path=/) when APP_URL is https, else `jt_session` without
 * Secure (local development over http). HttpOnly, SameSite=Lax, Max-Age 30 days. Only the name
 * that matches APP_URL is read: over https, a plain `jt_session` (which anyone on the network
 * path could plant over http) is ignored.
 *
 * Lifetime: 30 days, extended to 30 days from now whenever a request comes more than a day after
 * the last extension (the cookie is re-sent then).
 *
 * API
 *   newSessionToken()                  { token, tokenHash }
 *   hashSessionToken(token)            the 32-byte hash, or null for a malformed token
 *   sessionCookieName()                the name for the current APP_URL
 *   readSessionToken(req)              the cookie's value, or null (not checked against the db)
 *   sessionCookie(token)               Set-Cookie value; clearedSessionCookie() ends it
 *   createSession(db, userId)          inserts a session, returns { token, setCookie }
 *   lookupSession(req)                 "none" (no cookie), "invalid" (malformed, unknown,
 *                                      expired) or "valid" with the session and its user
 *   extendSession(found)               sliding expiry; a Set-Cookie value when it extended
 *   endSession(db, req)                deletes the session the request's cookie names
 *   serializeCookie(name, value, attrs)  the Set-Cookie writer, shared with oauth-state.ts
 *
 * The proxy (src/proxy.ts) cannot import this module (it imports database code) and repeats the
 * two cookie names; tests/unit/auth/proxy.test.ts keeps them in step.
 */

export const SESSION_COOKIE_SECURE = "__Host-jt_session";
export const SESSION_COOKIE_PLAIN = "jt_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A session is extended (and its cookie re-sent) at most once per this interval. */
export const SESSION_TOUCH_AFTER_SECONDS = 24 * 60 * 60;

const TOKEN_BYTES = 32;
/** 32 bytes in unpadded base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/* --------------------------------------------------------------- cookies */

export interface CookieAttributes {
  path: string;
  /** Seconds; 0 deletes the cookie. */
  maxAge: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Lax" | "Strict";
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Values written here are base64url; anything else is refused rather than escaped. */
const COOKIE_VALUE = /^[A-Za-z0-9_-]*$/;

/** A Set-Cookie header value. Names and values are restricted, never escaped. */
export function serializeCookie(name: string, value: string, attrs: CookieAttributes): string {
  if (!COOKIE_NAME.test(name)) throw new Error("serializeCookie: invalid cookie name");
  if (!COOKIE_VALUE.test(value)) throw new Error("serializeCookie: cookie value must be base64url");
  if (!attrs.path.startsWith("/") || /[;\s]/.test(attrs.path)) throw new Error("serializeCookie: invalid path");
  const parts = [`${name}=${value}`, `Path=${attrs.path}`, `Max-Age=${Math.max(0, Math.floor(attrs.maxAge))}`];
  if (attrs.maxAge <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (attrs.secure) parts.push("Secure");
  if (attrs.httpOnly) parts.push("HttpOnly");
  parts.push(`SameSite=${attrs.sameSite}`);
  return parts.join("; ");
}

/** The session cookie's name for the current APP_URL. */
export function sessionCookieName(): string {
  return isSecureApp() ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;
}

function sessionCookieAttributes(maxAge: number): CookieAttributes {
  return { path: "/", maxAge, secure: isSecureApp(), httpOnly: true, sameSite: "Lax" };
}

/** Set-Cookie for a session token (30 days). */
export function sessionCookie(token: string): string {
  return serializeCookie(sessionCookieName(), token, sessionCookieAttributes(SESSION_TTL_SECONDS));
}

/** Set-Cookie that deletes the session cookie (same name, path and flags, so browsers accept it). */
export function clearedSessionCookie(): string {
  return serializeCookie(sessionCookieName(), "", sessionCookieAttributes(0));
}

/** The session cookie's raw value, or null when there is none. Not validated. */
export function readSessionToken(req: NextRequest): string | null {
  const value = req.cookies.get(sessionCookieName())?.value;
  return value ? value : null;
}

/* ---------------------------------------------------------------- tokens */

export function newSessionToken(): { token: string; tokenHash: Buffer } {
  const raw = randomBytes(TOKEN_BYTES);
  return { token: raw.toString("base64url"), tokenHash: sha256(raw) };
}

/**
 * SHA-256 of the token's 32 raw bytes, or null when the token is not exactly 32 bytes in
 * canonical unpadded base64url (so one session has exactly one cookie value).
 */
export function hashSessionToken(token: string): Buffer | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const raw = Buffer.from(token, "base64url");
  if (raw.length !== TOKEN_BYTES || raw.toString("base64url") !== token) return null;
  return sha256(raw);
}

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/* ------------------------------------------------------------- lifecycle */

/** Inserts a session for the user; the token goes into the cookie, only its hash into the table. */
export async function createSession(db: Db, userId: string): Promise<{ token: string; setCookie: string }> {
  const { token, tokenHash } = newSessionToken();
  await insertSession(db, userId, tokenHash, SESSION_TTL_SECONDS);
  return { token, setCookie: sessionCookie(token) };
}

export type SessionLookup =
  | { status: "none" }
  | { status: "invalid" }
  | ({ status: "valid"; token: string } & SessionWithUser);

/**
 * The request's session. Reads the cookie first and queries only when there is a well-formed
 * token. "invalid" covers malformed, unknown and expired tokens: the caller clears the cookie.
 */
export async function lookupSession(db: Db, req: NextRequest): Promise<SessionLookup> {
  const token = readSessionToken(req);
  if (!token) return { status: "none" };
  const tokenHash = hashSessionToken(token);
  if (!tokenHash) return { status: "invalid" };
  const found = await findSessionByTokenHash(db, tokenHash, SESSION_TOUCH_AFTER_SECONDS);
  if (!found) return { status: "invalid" };
  return { status: "valid", token, ...found };
}

/**
 * Sliding expiry for a session lookupSession() found: when it was last extended more than a day
 * ago, extends it to 30 days from now and returns the Set-Cookie that re-sends the cookie.
 * Otherwise null (no query).
 */
export async function extendSession(
  db: Db,
  found: Extract<SessionLookup, { status: "valid" }>,
): Promise<string | null> {
  if (!found.session.needsTouch) return null;
  const expiresAt = await touchSession(db, found.session.id, SESSION_TTL_SECONDS, SESSION_TOUCH_AFTER_SECONDS);
  return expiresAt ? sessionCookie(found.token) : null;
}

/** Deletes the session the request's cookie names, if any (sign-out, or a new sign-in). */
export async function endSession(db: Db, req: NextRequest): Promise<void> {
  const token = readSessionToken(req);
  const tokenHash = token ? hashSessionToken(token) : null;
  if (tokenHash) await deleteSessionByTokenHash(db, tokenHash);
}
