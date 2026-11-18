import "server-only";
import { getDb, type Db } from "@/lib/server/db/client";
import {
  decryptToken,
  encryptToken,
  requireTokenKeys,
  TokenCryptoError,
  type TokenKeys,
} from "@/lib/server/inbox/oauth/token-crypto";
import { forgetAccessTokens } from "@/lib/server/inbox/oauth/google-tokens";
import { inboxError } from "@/lib/server/inbox/sync/errors";

/**
 * The mailbox connection's token and status columns of inbox_connections (status,
 * refresh_token_enc, granted_scopes, google_sub, email_address). The sync columns (history_id,
 * backfill_*, next_sync_at, lease_*, last_sync_ok_at) belong to the sync engine (repo.ts); the
 * writers here touch them only where the plan says so: connecting requests a sync
 * (next_sync_at = now()) and clears the last error.
 *
 *   saveConnection(db, userId, grant)     connect and reconnect: the encrypted token, status
 *                                         connected, a sync requested; keeps history_id, the
 *                                         backfill state, the ledger and the linked mail (a demo
 *                                         row starts over: see saveConnection)
 *   clearConnection(db, userId)           disconnect: token deleted, status disconnected;
 *                                         answers the stored value it removed (to revoke it)
 *   markNeedsReconnect(db, userId, code, { token? })
 *                                         Google no longer accepts the token (only from connected,
 *                                         and only while the stored token is still `token`)
 *   getRefreshToken(userId, db?)          the decrypted token for the sync engine; re-encrypts a
 *                                         row written with INBOX_TOKEN_KEY_PREVIOUS
 *   hasLiveConnection(db, googleSub, exceptUserId)
 *                                         another user's connection holds this Google account
 *
 * The refresh token is encrypted with the user id as associated data (oauth/token-crypto.ts), so
 * every function takes the user id the row belongs to. Nothing here logs a token or an address.
 *
 * Every writer that replaces or removes the token (saveConnection, clearConnection, and
 * markNeedsReconnect when it changes the row) also drops the connection's in-memory access token
 * (oauth/google-tokens.ts forgetAccessTokens), so no sync keeps using one of the old grant.
 */

export interface ConnectionGrant {
  /** The ID token's `sub`: must be the signed-in user's (checked by the connect callback). */
  googleSub: string;
  /** From users.getProfile. Stored lower-cased and trimmed. */
  emailAddress: string;
  /** The plaintext refresh token; encrypted here, never stored as is. */
  refreshToken: string;
  /** The scopes Google granted (the token response's `scope`). */
  grantedScopes: readonly string[];
}

/** Bounds on what is stored from Google's answer. */
const MAX_SCOPES = 32;
const MAX_SCOPE_LENGTH = 512;
const MAX_SUB_LENGTH = 255;
const MAX_EMAIL_LENGTH = 320;

/**
 * The scopes as stored: split on whitespace (a token response's `scope` is space-separated),
 * non-empty, at most MAX_SCOPE_LENGTH characters, no duplicates, sorted, at most MAX_SCOPES.
 */
export function normalizeScopes(scopes: readonly string[]): string[] {
  const set = new Set<string>();
  for (const entry of scopes) {
    if (typeof entry !== "string") continue;
    for (const scope of entry.split(/\s+/)) {
      if (scope !== "" && scope.length <= MAX_SCOPE_LENGTH) set.add(scope);
    }
  }
  return [...set].sort().slice(0, MAX_SCOPES);
}

/** The address as the table stores it (lower-cased, trimmed), or null when it is not one. */
export function normalizeMailbox(address: string): string | null {
  if (typeof address !== "string") return null;
  const email = address.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !/^[^@\s]+@[^@\s]+$/.test(email)) return null;
  return email;
}

/**
 * Connect and reconnect: stores the encrypted refresh token and the account, sets status
 * connected, clears the last error and the failure count, and requests a sync (next_sync_at =
 * now()). Everything else stays: the sync position (history_id), the backfill state, the ledger
 * and the linked mail, so a reconnect continues without duplicates.
 *
 * Except on the demo connection (`demo`, repo.ts ensureDemoConnection): its position, scan and
 * last success belong to the demo mail, not to this mailbox, so they are reset (history_id,
 * backfill_after and the counts cleared, backfill_state pending, last_sync_ok_at NULL) and `demo`
 * is cleared: the first sync is a first scan of the Gmail mailbox. The ledger and mail stay.
 *
 * Never revokes the token it replaces: revocation applies to the whole grant, and the new token
 * belongs to the same grant (docs/plan/2-gmail-ingest.md, "Reconnect").
 *
 * Throws TokenCryptoError("no_key") without INBOX_TOKEN_KEY, TypeError on a malformed grant.
 */
export async function saveConnection(
  db: Db,
  userId: string,
  grant: ConnectionGrant,
  keys: TokenKeys = requireTokenKeys(),
): Promise<void> {
  const email = normalizeMailbox(grant.emailAddress);
  if (!email) throw new TypeError("saveConnection: emailAddress is not an email address");
  if (typeof grant.googleSub !== "string" || grant.googleSub === "" || grant.googleSub.length > MAX_SUB_LENGTH) {
    throw new TypeError("saveConnection: googleSub must be a non-empty string of at most 255 characters");
  }
  const enc = encryptToken(grant.refreshToken, userId, keys);
  const scopes = normalizeScopes(grant.grantedScopes);
  // CASE WHEN c.demo: the demo row's sync columns are reset (NULL otherwise); a Gmail row keeps them.
  await db`
    INSERT INTO inbox_connections AS c (user_id, google_sub, email_address, status, refresh_token_enc, granted_scopes, next_sync_at)
    VALUES (${userId}, ${grant.googleSub}, ${email}, 'connected', ${enc}, ${scopes}::text[], now())
    ON CONFLICT (user_id) DO UPDATE SET
      google_sub = EXCLUDED.google_sub,
      email_address = EXCLUDED.email_address,
      status = 'connected',
      demo = false,
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      granted_scopes = EXCLUDED.granted_scopes,
      history_id = CASE WHEN c.demo THEN NULL ELSE c.history_id END,
      backfill_state = CASE WHEN c.demo THEN 'pending' ELSE c.backfill_state END,
      backfill_after = CASE WHEN c.demo THEN NULL ELSE c.backfill_after END,
      backfill_total = CASE WHEN c.demo THEN NULL ELSE c.backfill_total END,
      backfill_done = CASE WHEN c.demo THEN 0 ELSE c.backfill_done END,
      last_sync_ok_at = CASE WHEN c.demo THEN NULL ELSE c.last_sync_ok_at END,
      last_error_code = NULL,
      last_error_at = NULL,
      consecutive_failures = 0,
      next_sync_at = now(),
      updated_at = now()`;
  forgetAccessTokens(userId);
}

/**
 * Disconnect: deletes the stored token and marks the connection disconnected, in one statement.
 * Answers the stored (encrypted) token it removed, or null when there was none: no connection,
 * already disconnected, or a demo connection. Idempotent. The row stays, with the sync position,
 * the backfill state and the ledger, so connecting again continues without duplicates.
 */
export async function clearConnection(db: Db, userId: string): Promise<string | null> {
  const rows = await db<{ removed: string | null }[]>`
    WITH old AS (
      SELECT refresh_token_enc FROM inbox_connections WHERE user_id = ${userId} FOR UPDATE
    )
    UPDATE inbox_connections c
    SET status = 'disconnected', refresh_token_enc = NULL, updated_at = now()
    FROM old
    WHERE c.user_id = ${userId}
    RETURNING old.refresh_token_enc AS removed`;
  forgetAccessTokens(userId);
  return rows[0]?.removed ?? null;
}

/**
 * Google no longer accepts the stored access (invalid_grant, a 401 straight after a refresh, the
 * scope removed, a token that does not decrypt): status needs_reconnect with the error code. The
 * scheduler skips the connection and Settings offers Reconnect. The token stays: only a new
 * connection replaces it.
 *
 * Only a connected row changes. A connection disconnected meanwhile (a sync that was running
 * when the user clicked Disconnect fails on the revoked token) stays disconnected.
 *
 * `token` (the sync engine passes the stored refresh_token_enc it read when the run started;
 * null for none): compare-and-set, the row changes only while it still holds that value. A run
 * on the old grant that fails after the owner reconnected (a new token stored meanwhile) must not
 * mark the new connection. Left out: no comparison.
 *
 * Answers whether the row changed; only then is the in-memory access token dropped.
 */
export async function markNeedsReconnect(
  db: Db,
  userId: string,
  code: string,
  opts: { token?: string | null } = {},
): Promise<boolean> {
  const compare = opts.token !== undefined;
  const rows = await db`
    UPDATE inbox_connections
    SET status = 'needs_reconnect', last_error_code = ${code.slice(0, 64)}, last_error_at = now(), updated_at = now()
    WHERE user_id = ${userId} AND status = 'connected'
      AND (NOT ${compare}::boolean OR refresh_token_enc IS NOT DISTINCT FROM ${opts.token ?? null}::text)
    RETURNING 1`;
  if (rows.length === 0) return false;
  forgetAccessTokens(userId);
  return true;
}

/**
 * The user's refresh token, decrypted, for the sync engine (createGmailSource's
 * getRefreshToken). A row written with INBOX_TOKEN_KEY_PREVIOUS is re-encrypted with the current
 * key on the way (compare-and-set, so a token stored meanwhile by a reconnect is never
 * overwritten); a failed re-encryption is logged and tried again next time.
 *
 * Throws MailSourceError:
 *   setup token_key_missing           INBOX_TOKEN_KEY is not set
 *   needs_reconnect token_unreadable  no stored token (a demo connection), or one that does not
 *                                     decrypt with the current or the previous key
 *   temporary stopped                 no connection, or it was disconnected (a running sync ends)
 * Database errors pass through unchanged.
 */
export async function getRefreshToken(userId: string, db: Db = getDb()): Promise<string> {
  const [row] = await db<{ status: string; refresh_token_enc: string | null }[]>`
    SELECT status, refresh_token_enc FROM inbox_connections WHERE user_id = ${userId}`;
  if (!row || row.status === "disconnected") throw inboxError("stopped");
  if (row.refresh_token_enc === null) throw inboxError("token_unreadable");

  let keys: TokenKeys;
  let token: string;
  let reencrypt: boolean;
  try {
    keys = requireTokenKeys();
    ({ token, reencrypt } = decryptToken(row.refresh_token_enc, userId, keys));
  } catch (err) {
    throw tokenError(err);
  }

  if (reencrypt) {
    try {
      const fresh = encryptToken(token, userId, keys);
      await db`
        UPDATE inbox_connections SET refresh_token_enc = ${fresh}, updated_at = now()
        WHERE user_id = ${userId} AND refresh_token_enc = ${row.refresh_token_enc}`;
    } catch (err) {
      // The token is still good; the row keeps the previous key until the next try.
      console.warn(`inbox: re-encrypting the stored token failed (${err instanceof Error ? err.name : "unknown"})`);
    }
  }
  return token;
}

/** A token decryption failure as a MailSourceError; the cause is not kept. */
function tokenError(err: unknown) {
  if (err instanceof TokenCryptoError) {
    if (err.problem === "no_key" || err.problem === "bad_key") return inboxError("token_key_missing");
    return inboxError("token_unreadable");
  }
  return inboxError("token_unreadable");
}

/**
 * True when another user's connection (connected or needs_reconnect) holds this Google account.
 * The connect callback then does not revoke a token it refuses: revoking ends the whole grant,
 * which would end that user's connection too.
 */
export async function hasLiveConnection(db: Db, googleSub: string, exceptUserId: string): Promise<boolean> {
  const rows = await db`
    SELECT 1 FROM inbox_connections
    WHERE google_sub = ${googleSub} AND user_id <> ${exceptUserId} AND status <> 'disconnected'
    LIMIT 1`;
  return rows.length > 0;
}
