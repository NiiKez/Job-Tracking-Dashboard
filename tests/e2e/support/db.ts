// Direct access to the e2e server's database, for what a browser cannot do: making an account
// with a session (sign-in goes through Google, which the tests never reach) and reading rows back.
// Everything else should go through the browser, or through the API (see fixtures.ts `api`).
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { DEFAULT_RULES, DEFAULT_USER_SETTINGS } from "@/lib/domain/defaults";
import { normalize } from "@/lib/domain/normalize";
import { e2eDatabaseUrl } from "./settings";

let client: postgres.Sql | undefined;

/** A client on the e2e schema, one per worker process. */
export function db(): postgres.Sql {
  client ??= postgres(e2eDatabaseUrl(), { max: 2, onnotice: () => {}, prepare: false });
  return client;
}

export async function closeDb(): Promise<void> {
  await client?.end({ timeout: 5 });
  client = undefined;
}

export interface Account {
  userId: string;
  email: string;
  name: string;
  /** The session token: the value of the jt_session cookie. */
  token: string;
}

/**
 * Deletes the account with this email (every table cascades from users) and makes it again, as
 * a first sign-in does (src/lib/server/repo/users.ts upsertUserOnSignIn: the user, its settings
 * and the default keyword rules), plus a 30-day session (src/lib/server/auth/session.ts: a random
 * 32-byte token, only its SHA-256 stored).
 */
export async function resetAccount(email: string, name = "E2E Person"): Promise<Account> {
  const sql = db();
  const token = randomBytes(32);
  const userId = await sql.begin(async (tx) => {
    await tx`DELETE FROM users WHERE email = ${email}`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO users (google_sub, email, name)
      VALUES (${`e2e-sub-${email}-${token.subarray(0, 4).toString("hex")}`}, ${email}, ${name})
      RETURNING id`;
    const s = DEFAULT_USER_SETTINGS;
    await tx`
      INSERT INTO user_settings
        (user_id, no_response_days, create_from_confirmation, review_uncertain, languages, inbox_interval_minutes)
      VALUES
        (${user.id}, ${s.noResponseDays}, ${s.createFromConfirmation}, ${s.reviewUncertain},
         ${[...s.languages]}::text[], ${s.inboxIntervalMinutes})`;
    const rules = DEFAULT_RULES.map((r) => ({
      user_id: user.id,
      status: r.status,
      phrase: r.phrase,
      phrase_norm: normalize(r.phrase),
      language: r.language,
    }));
    await tx`INSERT INTO keyword_rules ${tx(rules, "user_id", "status", "phrase", "phrase_norm", "language")}`;
    await tx`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${user.id}, ${createHash("sha256").update(token).digest()}, now() + interval '30 days')`;
    return user.id;
  });
  return { userId, email, name, token: token.toString("base64url") };
}
