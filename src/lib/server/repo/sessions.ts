import "server-only";
import type { Db } from "@/lib/server/db/client";
import { userFromRow, type User, type UserRow } from "./users";

/**
 * Sign-in sessions. Only the SHA-256 of the cookie's token is stored (token_hash, 32 bytes); the
 * token itself never reaches the database. The policy (lifetime, when to extend) lives in
 * src/lib/server/auth/session.ts, which passes it in as seconds.
 *
 *   insertSession(db, userId, tokenHash, ttlSeconds)
 *   findSessionByTokenHash(db, tokenHash, touchAfterSeconds)   unexpired only, with its user
 *   touchSession(db, sessionId, ttlSeconds, touchAfterSeconds)  sliding expiry, at most once per interval
 *   deleteSession(db, sessionId) / deleteSessionByTokenHash(db, tokenHash)
 *   deleteExpiredSessions(db, userId)
 */

export interface SessionRecord {
  id: string;
  lastSeenAt: Date;
  expiresAt: Date;
  /** last_seen_at is older than the touch interval (by the database clock). */
  needsTouch: boolean;
}

export interface SessionWithUser {
  session: SessionRecord;
  user: User;
}

export async function insertSession(
  db: Db,
  userId: string,
  tokenHash: Buffer,
  ttlSeconds: number,
): Promise<{ id: string; expiresAt: Date }> {
  const [row] = await db<{ id: string; expires_at: Date }[]>`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, now() + make_interval(secs => ${ttlSeconds}))
    RETURNING id, expires_at`;
  return { id: row.id, expiresAt: row.expires_at };
}

/** The unexpired session with this token hash, joined to its user; null if none. */
export async function findSessionByTokenHash(
  db: Db,
  tokenHash: Buffer,
  touchAfterSeconds: number,
): Promise<SessionWithUser | null> {
  const [row] = await db<
    (UserRow & { session_id: string; last_seen_at: Date; expires_at: Date; needs_touch: boolean })[]
  >`
    SELECT
      s.id AS session_id, s.last_seen_at, s.expires_at,
      s.last_seen_at < now() - make_interval(secs => ${touchAfterSeconds}) AS needs_touch,
      u.id, u.email, u.google_sub, u.name, u.picture_url
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash} AND s.expires_at > now()`;
  if (!row) return null;
  return {
    session: {
      id: row.session_id,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      needsTouch: row.needs_touch,
    },
    user: userFromRow(row),
  };
}

/**
 * Sliding expiry: when last_seen_at is older than `touchAfterSeconds`, sets last_seen_at to now
 * and expires_at to now + ttl. Returns the new expiry, or null when the session was touched
 * recently (or is gone or expired). Concurrent requests touch it once.
 */
export async function touchSession(
  db: Db,
  sessionId: string,
  ttlSeconds: number,
  touchAfterSeconds: number,
): Promise<Date | null> {
  const [row] = await db<{ expires_at: Date }[]>`
    UPDATE sessions
    SET last_seen_at = now(), expires_at = now() + make_interval(secs => ${ttlSeconds})
    WHERE id = ${sessionId}
      AND expires_at > now()
      AND last_seen_at < now() - make_interval(secs => ${touchAfterSeconds})
    RETURNING expires_at`;
  return row?.expires_at ?? null;
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db`DELETE FROM sessions WHERE id = ${sessionId}`;
}

export async function deleteSessionByTokenHash(db: Db, tokenHash: Buffer): Promise<void> {
  await db`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
}

/** Removes the user's expired sessions (done at each sign-in). Returns how many. */
export async function deleteExpiredSessions(db: Db, userId: string): Promise<number> {
  const result = await db`DELETE FROM sessions WHERE user_id = ${userId} AND expires_at <= now()`;
  return result.count;
}
