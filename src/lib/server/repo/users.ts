import "server-only";
import type { Db, Tx } from "@/lib/server/db/client";
import { isUniqueViolation } from "@/lib/server/db/client";
import { DEFAULT_RULES, DEFAULT_USER_SETTINGS } from "@/lib/domain/defaults";
import { normalize } from "@/lib/domain/normalize";
import { ConflictError } from "@/lib/server/errors";

/**
 * Users: one row per Google account that has signed in.
 *
 *   upsertUserOnSignIn(tx, profile)  by google_sub; a first sign-in also creates the settings
 *                                    row and the default keyword rules (same transaction)
 *   insertDefaults(tx, userId)       a new user's settings row and default keyword rules
 *   getUser(db, id)                  the user, or null
 */

/** A signed-in user, as route() hands it to handlers. */
export interface User {
  id: string;
  email: string;
  /** The ID token's `sub`: Google's stable account id. */
  googleSub: string;
  name: string;
  pictureUrl: string | null;
}

/** What sign-in learned from Google's ID token (see validateIdTokenClaims). */
export interface SignInProfile {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  google_sub: string;
  name: string;
  picture_url: string | null;
}

export function userFromRow(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    googleSub: row.google_sub,
    name: row.name,
    pictureUrl: row.picture_url,
  };
}

const EMAIL_TAKEN = "This email address belongs to a different Google account";

/**
 * Creates or updates the user for a sign-in, matched by google_sub. A returning user gets the
 * current email, name and picture and a new last_login_at. A first sign-in also inserts the
 * user_settings row and the default keyword rules.
 *
 * Throws ConflictError when the email already belongs to a different Google account (another
 * `sub`): accounts are never merged by email. The caller's transaction then rolls back as a whole.
 *
 * Safe under concurrent first sign-ins of the same account (READ COMMITTED, as withTx runs): the
 * losing INSERT waits for the winner's commit, does nothing, and the UPDATE then sees the row.
 */
export async function upsertUserOnSignIn(
  tx: Tx,
  profile: SignInProfile,
): Promise<{ user: User; created: boolean }> {
  const email = profile.email.trim().toLowerCase();
  try {
    // DO NOTHING on any unique constraint (google_sub or email). A target of google_sub alone let
    // a concurrent first sign-in of the same account fail on users_email_key instead.
    const [inserted] = await tx<UserRow[]>`
      INSERT INTO users (google_sub, email, name, picture_url)
      VALUES (${profile.sub}, ${email}, ${profile.name}, ${profile.picture})
      ON CONFLICT DO NOTHING
      RETURNING id, email, google_sub, name, picture_url`;
    if (inserted) {
      await insertDefaults(tx, inserted.id);
      return { user: userFromRow(inserted), created: true };
    }
    const [updated] = await tx<UserRow[]>`
      UPDATE users
      SET email = ${email}, name = ${profile.name}, picture_url = ${profile.picture}, last_login_at = now()
      WHERE google_sub = ${profile.sub}
      RETURNING id, email, google_sub, name, picture_url`;
    // No row for this sub, yet the insert conflicted: the email belongs to another sub.
    if (!updated) throw new ConflictError(EMAIL_TAKEN);
    return { user: userFromRow(updated), created: false };
  } catch (err) {
    // A returning sub whose new email another sub already holds.
    if (isUniqueViolation(err, "users_email_key")) throw new ConflictError(EMAIL_TAKEN);
    throw err;
  }
}

/**
 * Inserts a new user's user_settings row (DEFAULT_USER_SETTINGS) and the default keyword rules
 * (DEFAULT_RULES): what a first sign-in gives every user. Call it once, right after inserting the
 * users row and in the same transaction; a second call fails on the settings row's primary key.
 * Exported for code that creates users without a Google sign-in (the public demo's workspaces).
 */
export async function insertDefaults(tx: Tx, userId: string): Promise<void> {
  const s = DEFAULT_USER_SETTINGS;
  await tx`
    INSERT INTO user_settings
      (user_id, no_response_days, create_from_confirmation, review_uncertain, languages, inbox_interval_minutes)
    VALUES
      (${userId}, ${s.noResponseDays}, ${s.createFromConfirmation}, ${s.reviewUncertain},
       ${[...s.languages]}::text[], ${s.inboxIntervalMinutes})`;
  const rules = DEFAULT_RULES.map((r) => ({
    user_id: userId,
    status: r.status,
    phrase: r.phrase,
    phrase_norm: normalize(r.phrase),
    language: r.language,
  }));
  await tx`INSERT INTO keyword_rules ${tx(rules, "user_id", "status", "phrase", "phrase_norm", "language")}`;
}

/** The user with this id, or null. */
export async function getUser(db: Db, id: string): Promise<User | null> {
  const [row] = await db<UserRow[]>`
    SELECT id, email, google_sub, name, picture_url FROM users WHERE id = ${id}`;
  return row ? userFromRow(row) : null;
}
