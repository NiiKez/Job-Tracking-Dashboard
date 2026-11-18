import "server-only";
import { isUuid } from "@/lib/server/db/rows";
import type { Db, Tx } from "@/lib/server/db/client";
import { userFromRow, type User, type UserRow } from "./users";

/**
 * The Chrome extension's keys (extension_keys, db/migrations/0004_extension_keys.sql). Only the
 * SHA-256 of a key's random bytes is stored (token_hash, 32 bytes); the key itself never reaches
 * the database. The policy (format, when to touch last_used_at) lives in
 * src/lib/server/auth/extension-key.ts, which passes it in as seconds.
 *
 *   lockUserExtensionKeys(tx, userId)                       serializes key creation per user
 *   countExtensionKeys(db, userId)
 *   insertExtensionKey(db, userId, tokenHash, label)        the new row
 *   listExtensionKeyRows(db, userId)                        newest first
 *   findExtensionKeyByTokenHash(db, tokenHash, touchAfterSeconds)  with its user
 *   touchExtensionKey(db, keyId, touchAfterSeconds)         last_used_at = now(), at most once per interval
 *   deleteExtensionKeyRow(db, userId, keyId)                false when it is not the user's
 */

/** An extension_keys row without its hash. */
export interface ExtensionKeyRow {
  id: string;
  label: string;
  created_at: Date;
  last_used_at: Date | null;
}

export interface ExtensionKeyWithUser {
  key: ExtensionKeyRow & {
    /** last_used_at is NULL or older than the touch interval (by the database clock). */
    needsTouch: boolean;
  };
  user: User;
}

/**
 * Holds a per-user lock until the transaction ends, so a count followed by an insert cannot
 * race another request's (the 20-key limit). Same scheme as lockUserJobs, its own namespace.
 */
export async function lockUserExtensionKeys(tx: Tx, userId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended('extension_keys:' || ${userId}::text, 0))`;
}

export async function countExtensionKeys(db: Db, userId: string): Promise<number> {
  const [row] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM extension_keys WHERE user_id = ${userId}`;
  return row.n;
}

export async function insertExtensionKey(
  db: Db,
  userId: string,
  tokenHash: Buffer,
  label: string,
): Promise<ExtensionKeyRow> {
  const [row] = await db<ExtensionKeyRow[]>`
    INSERT INTO extension_keys (user_id, token_hash, label)
    VALUES (${userId}, ${tokenHash}, ${label})
    RETURNING id, label, created_at, last_used_at`;
  return row;
}

/** The user's keys, the newest first. */
export async function listExtensionKeyRows(db: Db, userId: string): Promise<ExtensionKeyRow[]> {
  return db<ExtensionKeyRow[]>`
    SELECT id, label, created_at, last_used_at FROM extension_keys
    WHERE user_id = ${userId}
    ORDER BY created_at DESC, id DESC`;
}

/** The key with this hash, joined to its user; null if none. */
export async function findExtensionKeyByTokenHash(
  db: Db,
  tokenHash: Buffer,
  touchAfterSeconds: number,
): Promise<ExtensionKeyWithUser | null> {
  const [row] = await db<
    (UserRow & {
      key_id: string;
      label: string;
      created_at: Date;
      last_used_at: Date | null;
      needs_touch: boolean;
    })[]
  >`
    SELECT
      k.id AS key_id, k.label, k.created_at, k.last_used_at,
      (k.last_used_at IS NULL OR k.last_used_at < now() - make_interval(secs => ${touchAfterSeconds})) AS needs_touch,
      u.id, u.email, u.google_sub, u.name, u.picture_url
    FROM extension_keys k
    JOIN users u ON u.id = k.user_id
    WHERE k.token_hash = ${tokenHash}`;
  if (!row) return null;
  return {
    key: {
      id: row.key_id,
      label: row.label,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      needsTouch: row.needs_touch,
    },
    user: userFromRow(row),
  };
}

/**
 * Sets last_used_at to now when it is NULL or older than `touchAfterSeconds`, in one UPDATE with
 * that condition: concurrent requests touch the row once. False when it was touched recently
 * (or the key is gone).
 */
export async function touchExtensionKey(db: Db, keyId: string, touchAfterSeconds: number): Promise<boolean> {
  const rows = await db`
    UPDATE extension_keys SET last_used_at = now()
    WHERE id = ${keyId}
      AND (last_used_at IS NULL OR last_used_at < now() - make_interval(secs => ${touchAfterSeconds}))
    RETURNING id`;
  return rows.length > 0;
}

/** Deletes the user's key. False when there is none with this id for this user (or the id is no uuid). */
export async function deleteExtensionKeyRow(db: Db, userId: string, keyId: string): Promise<boolean> {
  if (!isUuid(keyId)) return false;
  const rows = await db`DELETE FROM extension_keys WHERE user_id = ${userId} AND id = ${keyId} RETURNING id`;
  return rows.length > 0;
}
