// The `npm run db:seed` command's logic (scripts/seed-dev.ts is the command; tests/db/seed.test.ts
// runs the same functions). Writing the demo data is seedUser, which moved into the app's source
// tree (src/lib/server/demo/seed.ts) so the Next build compiles it for the public demo; it is
// re-exported here for the command and the tests that import it from this path.
//
//   runSeed(sql, { email?, now? })  the whole command: checks the database name, finds the user,
//                                   then seedUser in one transaction
//   seedUser(tx, userId, now?)      replaces the user's jobs and emails with the fixtures
//   findSeedUser(db, email?)        the named user (any case), or the oldest one
//   isSeedableDatabase(name)        the name ends in _dev or _test
//
// The modules imported here start with `import "server-only"`. The command runs under the
// react-server export condition (tsx --conditions=react-server), where that import is empty;
// the tests alias it (vitest.config.mts).
import type { Db, Sql } from "@/lib/server/db/client";
import { seedUser } from "@/lib/server/demo/seed";

export { seedUser };

/** A refusal or a missing user: the command prints the message and exits non-zero. */
export class SeedError extends Error {
  override name = "SeedError";
}

/** Only development and test databases may be seeded: the seed deletes the user's jobs and emails. */
export function isSeedableDatabase(name: string): boolean {
  return /_(dev|test)$/.test(name);
}

export interface SeedUser {
  id: string;
  email: string;
}

/** The user with this email (matched lower-cased, as sign-in stores it), or the oldest user. Null if none. */
export async function findSeedUser(db: Db, email?: string): Promise<SeedUser | null> {
  const [user] = email
    ? await db<SeedUser[]>`SELECT id, email FROM users WHERE email = ${email.trim().toLowerCase()}`
    : await db<SeedUser[]>`SELECT id, email FROM users ORDER BY created_at, id LIMIT 1`;
  return user ?? null;
}

export interface SeedResult {
  database: string;
  user: SeedUser;
  jobs: number;
  emails: number;
}

/**
 * The command: refuses a database whose name does not end in _dev or _test (asked from the
 * server, so it is the database actually connected to), finds the user, and replaces their jobs
 * and emails in one transaction. Throws SeedError for a refusal or a missing user.
 */
export async function runSeed(sql: Sql, opts: { email?: string; now?: number } = {}): Promise<SeedResult> {
  const [{ database }] = await sql<{ database: string }[]>`SELECT current_database() AS database`;
  if (!isSeedableDatabase(database)) {
    throw new SeedError(
      `refusing to seed the database "${database}": only databases whose name ends in _dev or _test are seeded`,
    );
  }
  const user = await findSeedUser(sql, opts.email);
  if (!user) {
    throw new SeedError(
      opts.email
        ? `no user with the email ${opts.email.trim().toLowerCase()}. Sign in once with that account first, then seed again.`
        : "there is no user yet. Sign in to the app once first, then seed again.",
    );
  }
  const counts = await sql.begin((tx) => seedUser(tx, user.id, opts.now));
  return { database, user, ...counts };
}
