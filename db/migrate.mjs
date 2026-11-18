// Migration runner: applies db/migrations/NNNN_*.sql in order, once each, and records them in
// schema_migrations with the SHA-256 of the file. Each file runs in its own transaction.
//
//   npm run migrate        (deploy: the server's environment file is loaded)
//   npm run migrate:dev    (here: DATABASE_URL from .env.local, the development database)
//
// Rules for every migration (also in docs/plan/1-backend-core.md, "Migrations"):
//
// - Never edit an applied migration: put the change in a new one. Before it applies anything, a
//   run compares every applied file with the checksum recorded when it ran, and stops at the
//   first that differs. The checksum covers the file's bytes (what `sha256sum` prints), so a
//   changed comment or line ending counts too. Don't rename or delete one either: a missing
//   file is only reported (a release built from an older commit lacks the newer files), and a
//   renamed one would run again under its new name.
// - Every migration must keep the previous release working. The deploy runs it while the old
//   release still serves, which keeps serving if a later step fails, and a rollback switches the
//   code back but not the schema. So change the schema in two steps: first add what the new
//   release needs (new tables, nullable or defaulted columns, widened checks), then remove what
//   the old release used in a later release.
// - Every new migration needs an upgrade case in tests/db/migrate-upgrade.test.ts: rows as the
//   previous release wrote them, and what the migration must make of them. A test there fails
//   until it has one.
//
// Plain .mjs on the production client: the release has no devDependencies, so
// no tsx. tests/helpers/test-db.ts imports runMigrations().
//
// Prints migration names only. CI logs of this public repo are public, so neither the
// connection string nor anything built from it may ever be printed.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

const FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Serialises concurrent runners on the same schema (two deploys, or a deploy and a run from
 * here) until the transaction ends. Keyed on the schema so parallel test schemas don't wait.
 *
 * @param {import("postgres").TransactionSql} tx
 */
async function lockSchema(tx) {
  await tx`SELECT pg_advisory_xact_lock(hashtext('job-tracker-migrate:' || current_schema()))`;
}

/**
 * Throws when an applied migration's file no longer has the checksum recorded when it ran. The
 * message names the file only: never its contents.
 *
 * @param {string} name
 * @param {string} recorded
 * @param {string} checksum the file's as it is now
 */
function assertUnchanged(name, recorded, checksum) {
  if (recorded !== checksum) {
    throw new Error(
      `${name} was changed after it was applied (its SHA-256 differs from the one in schema_migrations). ` +
        "Never edit an applied migration: restore the file and add a new migration for the change.",
    );
  }
}

/**
 * Applies every pending migration through `sql` and returns the names applied.
 *
 * @param {import("postgres").Sql} sql
 * @param {{ dir?: string, log?: (line: string) => void }} [options]
 * @returns {Promise<string[]>}
 */
export async function runMigrations(sql, { dir = MIGRATIONS_DIR, log = console.log } = {}) {
  /** @type {Map<string, { body: string, checksum: string }>} */
  const files = new Map();
  for (const name of (await readdir(dir)).filter((f) => FILE.test(f)).sort()) {
    const bytes = await readFile(join(dir, name));
    files.set(name, { body: bytes.toString("utf8"), checksum: createHash("sha256").update(bytes).digest("hex") });
  }

  // Under the lock too: two runners creating the table at once on a fresh schema fail with a
  // duplicate key in pg_type. The checksum column came later, so databases migrated before it
  // get it here, in place.
  //
  // Every applied file is checked before anything pending runs, so an edited migration stops the
  // deploy with nothing changed, and the old release keeps serving.
  const { filled, missing } = await sql.begin(async (tx) => {
    await lockSchema(tx);
    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await tx`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`;
    const rows = await tx`SELECT name, checksum FROM schema_migrations ORDER BY name`;
    /** @type {string[]} */
    const filled = [];
    /** @type {string[]} */
    const missing = [];
    for (const { name, checksum } of rows) {
      const file = files.get(name);
      if (!file) {
        // Not an error: deploying an older commit (a reverted pull request) runs a release
        // without the newer files, and the schema they made has to keep working for it anyway.
        missing.push(name);
      } else if (checksum === null) {
        // Applied before checksums were recorded: the file as it is now is trusted, once.
        await tx`UPDATE schema_migrations SET checksum = ${file.checksum} WHERE name = ${name}`;
        filled.push(name);
      } else {
        assertUnchanged(name, checksum, file.checksum);
      }
    }
    return { filled, missing };
  });
  // Only now: a changed file above rolls the filled-in checksums back with it.
  for (const name of filled) log(`migrate: recorded the checksum of ${name}, applied before checksums were kept`);
  for (const name of missing) log(`migrate: ${name} is applied but not in this release; not checked`);

  /** @type {string[]} */
  const applied = [];
  for (const [name, file] of files) {
    const done = await sql.begin(async (tx) => {
      await lockSchema(tx);
      const [row] = await tx`SELECT checksum FROM schema_migrations WHERE name = ${name}`;
      if (row) {
        // Checked again: another runner, with its own copy of the file, may have applied it since.
        if (row.checksum !== null) assertUnchanged(name, row.checksum, file.checksum);
        return false;
      }
      await tx.unsafe(file.body);
      await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${name}, ${file.checksum})`;
      return true;
    });
    if (done) {
      applied.push(name);
      log(`migrate: applied ${name}`);
    }
  }
  if (applied.length === 0) log("migrate: up to date");
  return applied;
}

/** Run as a script (`node db/migrate.mjs`, also through a symlinked path), not imported. */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    // import.meta.url is the real path; argv[1] keeps symlinks (e.g. a release's "current" link).
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("migrate: DATABASE_URL is not set");
    process.exit(1);
  }
  /** @type {import("postgres").Sql | undefined} */
  let sql;
  try {
    // Inside the try: postgres() parses the URL right away, and an uncaught parse error would be
    // printed with the whole connection string (Node shows a TypeError's `input`).
    sql = postgres(url, { max: 1, onnotice: () => {}, connection: { application_name: "job-tracker-migrate" } });
    await runMigrations(sql);
  } catch (err) {
    // The message only (no stack, no error object): a driver error never needs the URL to
    // be understood, and this masks it anyway in case one ever echoes it.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`migrate: failed: ${message.split(url).join("<DATABASE_URL>")}`);
    process.exitCode = 1;
  } finally {
    await sql?.end({ timeout: 5 });
  }
}
