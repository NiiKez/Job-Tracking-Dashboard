import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@/lib/server/db/client";
import { signInConfig } from "@/lib/server/env";
import {
  deleteExtensionKeyRow,
  findExtensionKeyByTokenHash,
  touchExtensionKey,
} from "@/lib/server/repo/extension-keys";
import type { User } from "@/lib/server/repo/users";
import { mayUse } from "./access";

/**
 * The Chrome extension's keys (docs/plan/4-chrome-extension.md, "Key routes"). The extension
 * cannot use the session cookie, so connecting a browser gives it a key of its own, which it
 * sends as `Authorization: Bearer jtx_…` to the routes made with route(…, { auth: "extension" }).
 *
 * Key: "jtx_" and 32 random bytes in unpadded base64url (47 characters). The prefix makes a
 * leaked key easy to recognise (.gitleaks.toml has a rule for it). Only the SHA-256 of the 32
 * bytes is stored, as for sessions. A key does not expire: it ends when it is revoked in
 * Settings, by Disconnect in the popup, or when its user leaves ALLOWED_EMAILS. Google sign-in
 * only: in locked mode and in the public demo no key is accepted.
 *
 * last_used_at (Settings shows it) is moved when it is older than 5 minutes, so a busy popup
 * writes at most one row every 5 minutes.
 *
 * Neither the key nor its hash is ever logged.
 *
 * API
 *   newExtensionKey()                  { token, tokenHash }
 *   hashExtensionKey(token)            the 32-byte hash, or null unless the token is exactly
 *                                      "jtx_" + 43 base64url characters that decode to 32 bytes
 *                                      and encode back the same (one key has one spelling)
 *   readBearerToken(req)               the credentials of `Authorization: Bearer <credentials>`,
 *                                      or null (not checked against anything)
 *   authenticateExtensionKey(db, req)  the key's user and the key's id, or { ok: false } for
 *                                      locked and demo mode and a missing, malformed, unknown or
 *                                      revoked key. A user who may not use the app (mayUse():
 *                                      no longer on ALLOWED_EMAILS, or a demo user): the key is
 *                                      deleted, { ok: false }. Touches last_used_at when due.
 */

export const EXTENSION_KEY_PREFIX = "jtx_";
/** last_used_at is moved at most once per this interval. */
export const EXTENSION_KEY_TOUCH_AFTER_SECONDS = 5 * 60;

const KEY_BYTES = 32;
/** The prefix and 32 bytes in unpadded base64url. */
const KEY_PATTERN = /^jtx_[A-Za-z0-9_-]{43}$/;
/** RFC 6750's header form; the scheme is case-insensitive. */
const BEARER = /^bearer[ \t]+(\S+)$/i;

/* ---------------------------------------------------------------- tokens */

export function newExtensionKey(): { token: string; tokenHash: Buffer } {
  const raw = randomBytes(KEY_BYTES);
  return { token: `${EXTENSION_KEY_PREFIX}${raw.toString("base64url")}`, tokenHash: sha256(raw) };
}

/**
 * SHA-256 of the key's 32 raw bytes, or null when the token is not "jtx_" followed by exactly 32
 * bytes in canonical unpadded base64url.
 */
export function hashExtensionKey(token: string): Buffer | null {
  if (!KEY_PATTERN.test(token)) return null;
  const encoded = token.slice(EXTENSION_KEY_PREFIX.length);
  const raw = Buffer.from(encoded, "base64url");
  if (raw.length !== KEY_BYTES || raw.toString("base64url") !== encoded) return null;
  return sha256(raw);
}

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/** The credentials after "Bearer " in the Authorization header, or null when there are none. */
export function readBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  return header ? (BEARER.exec(header)?.[1] ?? null) : null;
}

/* ------------------------------------------------------------ requests */

export type ExtensionKeyAuth = { ok: true; user: User; keyId: string } | { ok: false };

/**
 * The user whose key the request carries. Never reads the session cookie. Queries only when the
 * header holds a well-formed key.
 */
export async function authenticateExtensionKey(db: Db, req: Request): Promise<ExtensionKeyAuth> {
  if (!signInConfig()) return { ok: false };
  const token = readBearerToken(req);
  const tokenHash = token ? hashExtensionKey(token) : null;
  if (!tokenHash) return { ok: false };
  const found = await findExtensionKeyByTokenHash(db, tokenHash, EXTENSION_KEY_TOUCH_AFTER_SECONDS);
  if (!found) return { ok: false };
  if (!mayUse(found.user)) {
    // Removed from ALLOWED_EMAILS since connecting, or a demo user: this key ends now, as a
    // session would.
    await deleteExtensionKeyRow(db, found.user.id, found.key.id);
    return { ok: false };
  }
  if (found.key.needsTouch) await touchExtensionKey(db, found.key.id, EXTENSION_KEY_TOUCH_AFTER_SECONDS);
  return { ok: true, user: found.user, keyId: found.key.id };
}
