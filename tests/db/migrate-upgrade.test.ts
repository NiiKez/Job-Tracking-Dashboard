import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Sql } from "@/lib/server/db/client";
import { MIGRATIONS_DIR, runMigrations } from "../../db/migrate.mjs";
import { describeDb, testSql, withEmptySchema } from "../helpers/test-db";

// Every migration after 0001 applied to a database with data in it, as the deploy applies it to
// production. A schema is migrated up to the file before it and filled with rows as that release
// wrote them (SEEDS), the migration runs, and then:
// - every row is still there with every column it had, value for value;
// - the migration's own case (UPGRADES) checks what it made of them: the values new columns and
//   constraints have for old rows;
// - the previous release can still write its rows: it serves while the migration runs, and again
//   after a rollback (the rules at the top of db/migrate.mjs).
//
// A new migration needs two entries here, and the first test below fails until both exist:
//   UPGRADES["NNNN_name.sql"]  what the migration must make of the rows already there
//   SEEDS["NNNN_name.sql"]     rows in every table as the release with that migration writes them:
//                              the next migration's upgrade case starts from these
//
// The first migration that removes a column or table (the second of the two steps) will need a
// way to leave it out of the row comparison.

const FILES = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

/** Writes rows as one release wrote them. `n` keeps the rows of several calls apart. */
type Seed = (sql: Sql, n: number) => Promise<void>;

/** Checks, after the migration, what it made of the rows a Seed wrote before it. */
type Upgrade = (sql: Sql) => Promise<void>;

/**
 * Rows as the release with 0001_core.sql wrote them, for one user: settings, keyword rules, a
 * session, two jobs with their history, and mail (linked to a job, waiting for review with each
 * reason of the time, and dismissed). Returns the user's id.
 */
async function seedCore(sql: Sql, n: number): Promise<string> {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    INSERT INTO users (google_sub, email, name, picture_url, last_login_at)
    VALUES (${`upgrade-sub-${n}`}, ${`person${n}@example.com`}, ${`Test Person ${n}`},
            'https://example.com/avatars/person.png', now() - interval '2 days')
    RETURNING id`;
  await sql`
    INSERT INTO user_settings (user_id, no_response_days, create_from_confirmation, review_uncertain, languages,
                               inbox_interval_minutes)
    VALUES (${userId}, 45, false, true, '{en}', 30)`;
  await sql`
    INSERT INTO keyword_rules (user_id, status, phrase, phrase_norm, language) VALUES
      (${userId}, 'rejected', 'Unfortunately', 'unfortunately', 'en'),
      (${userId}, 'interview', 'Einladung zum Gespräch', 'einladung zum gesprach', 'de')`;
  await sql`
    INSERT INTO sessions (user_id, token_hash, last_seen_at, expires_at)
    VALUES (${userId}, ${createHash("sha256").update(`upgrade-session-${n}`).digest()}, now() - interval '1 hour',
            now() + interval '30 days')`;

  const [interview] = await sql<{ id: string }[]>`
    INSERT INTO jobs (user_id, title, company, location, url, description, url_norm, company_slug, title_norm,
                      search_text, status, status_source, capture_method, applied_at, last_activity_at,
                      next_interview_at, next_interview_round)
    VALUES (${userId}, 'Frontend Engineer', 'Parcelwerk', 'Berlin', 'https://jobs.example.com/parcelwerk/42?ref=board',
            'Build the parcel tracking pages.', 'jobs.example.com/parcelwerk/42', 'parcelwerk', 'frontend engineer',
            'parcelwerk frontend engineer', 'interview', 'email', 'paste', now() - interval '20 days',
            now() - interval '5 days', now() + interval '3 days', 'Technical interview')
    RETURNING id`;
  const [rejected] = await sql<{ id: string }[]>`
    INSERT INTO jobs (user_id, title, company, company_slug, title_norm, search_text, status, status_source,
                      status_locked, capture_method)
    VALUES (${userId}, 'Platform Engineer', 'Nordlicht Labs GmbH', 'nordlichtlabs', 'platform engineer',
            'nordlicht labs gmbh platform engineer', 'rejected', 'manual', true, 'paste')
    RETURNING id`;

  const [confirmation] = await sql<{ id: string }[]>`
    INSERT INTO emails (user_id, job_id, from_name, from_address, subject, body, received_at, language, outcome,
                        detected_status, matched_keywords, change_from, change_to, confidence)
    VALUES (${userId}, ${interview.id}, 'Parcelwerk Recruiting', 'jobs@parcelwerk.example.com',
            'Thank you for applying', 'Thank you for applying for Frontend Engineer at Parcelwerk.',
            now() - interval '20 days', 'en', 'matched', 'applied', '{thank you for applying}', 'saved', 'applied', 0.93)
    RETURNING id`;
  const [invitation] = await sql<{ id: string }[]>`
    INSERT INTO emails (user_id, job_id, from_name, from_address, subject, body, received_at, language, outcome,
                        detected_status, matched_keywords, change_from, change_to, confidence)
    VALUES (${userId}, ${interview.id}, 'Parcelwerk Recruiting', 'jobs@parcelwerk.example.com',
            'Einladung zum Gespräch', 'Wir möchten Sie gerne zu einem Gespräch einladen.', now() - interval '5 days',
            'de', 'matched', 'interview', '{einladung zum gesprach}', 'applied', 'interview', 0.88)
    RETURNING id`;
  const reasons = ["ambiguous_job", "unknown_job", "no_keyword", "conflicting_keywords"];
  for (const [i, reason] of reasons.entries()) {
    await sql`
      INSERT INTO emails (user_id, from_name, from_address, subject, body, received_at, language, outcome,
                          review_reason, suggested_job_ids, suggested_status, confidence)
      VALUES (${userId}, 'Talent Team', 'talent@example.com', 'About your application',
              'Thank you for your interest. Unfortunately we have decided to move forward with other candidates.',
              now() - make_interval(days => ${i + 1}), 'en', 'review', ${reason},
              ${reason === "ambiguous_job" ? [interview.id, rejected.id] : []}::uuid[],
              ${reason === "no_keyword" ? null : "rejected"}, 0.45)`;
  }
  await sql`
    INSERT INTO emails (user_id, from_name, from_address, subject, received_at, language, outcome, confidence)
    VALUES (${userId}, 'Job Alerts', 'alerts@example.com', 'New jobs for you', now() - interval '3 days', 'en',
            'dismissed', 0.2)`;

  await sql`
    INSERT INTO job_status_events (user_id, job_id, from_status, to_status, at, source, email_id, note) VALUES
      (${userId}, ${interview.id}, NULL, 'saved', now() - interval '21 days', 'paste', NULL, NULL),
      (${userId}, ${interview.id}, 'saved', 'applied', now() - interval '20 days', 'email', ${confirmation.id}, NULL),
      (${userId}, ${interview.id}, 'applied', 'interview', now() - interval '5 days', 'email', ${invitation.id}, NULL),
      (${userId}, ${rejected.id}, NULL, 'saved', now() - interval '9 days', 'paste', NULL, NULL),
      (${userId}, ${rejected.id}, 'saved', 'rejected', now() - interval '2 days', 'manual', NULL, 'Told on the phone')`;
  return userId;
}

/**
 * Rows the release with 0002_inbox.sql adds for a user: a connected Gmail mailbox after its first
 * scan, mail from Gmail (with the two newer review reasons), and the ledger.
 */
async function seedInbox(sql: Sql, n: number, userId: string): Promise<void> {
  // An invented token in the stored format, "v1.<key id>.<iv>.<ciphertext and tag>".
  await sql`
    INSERT INTO inbox_connections (user_id, google_sub, email_address, status, refresh_token_enc, granted_scopes,
                                   history_id, backfill_state, backfill_after, backfill_total, backfill_done,
                                   last_sync_ok_at, next_sync_at)
    VALUES (${userId}, ${`upgrade-sub-${n}`}, ${`person${n}@example.com`}, 'connected',
            'v1.k1.bm90LWEtcmVhbC1pdg.bm90LWEtcmVhbC10b2tlbg', '{https://www.googleapis.com/auth/gmail.readonly}',
            '4815162342', 'done', now() - interval '180 days', 3, 3, now() - interval '10 minutes',
            now() + interval '5 minutes')`;
  const [job] = await sql<{ id: string }[]>`SELECT id FROM jobs WHERE user_id = ${userId} AND status = 'interview'`;
  const id = (k: number) => `19a6d2c4e8f1${n}00${k}`;
  await sql`
    INSERT INTO emails (user_id, from_name, from_address, subject, body, received_at, language, outcome, review_reason,
                        suggested_job_ids, suggested_status, confidence, gmail_message_id, gmail_thread_id,
                        body_truncated)
    VALUES
      (${userId}, 'Parcelwerk Recruiting', 'jobs@parcelwerk.example.com', 'Your application',
       'Thank you for applying for Frontend Engineer.', now() - interval '1 day', 'en', 'review', 'status_mismatch',
       ${[job.id]}::uuid[], 'applied', 0.6, ${id(1)}, ${id(0)}, false),
      (${userId}, 'Careers Newsletter', 'news@example.com', 'Unfortunately, these roles are closed',
       ${"Unfortunately ".repeat(2000)}, now() - interval '2 days', 'en', 'review', 'bulk_mail',
       '{}', 'rejected', 0.3, ${id(2)}, ${id(2)}, true)`;
  await sql`
    INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result, attempts, internal_date) VALUES
      (${userId}, ${id(1)}, 'stored', 0, now() - interval '1 day'),
      (${userId}, ${id(2)}, 'stored', 0, now() - interval '2 days'),
      (${userId}, ${id(3)}, 'ignored', 0, now() - interval '2 days'),
      (${userId}, ${id(4)}, 'retry', 1, NULL)`;
}

/**
 * Rows the release with 0003_email_bulk.sql adds for a user with a mailbox: mail from Gmail with
 * its bulk-mail headers recorded, one with and one without.
 */
async function seedBulk(sql: Sql, n: number, userId: string): Promise<void> {
  const id = (k: number) => `19a6d2c4e8f1${n}00${k}`;
  await sql`
    INSERT INTO emails (user_id, from_name, from_address, subject, body, received_at, language, outcome, review_reason,
                        suggested_status, confidence, gmail_message_id, gmail_thread_id, body_truncated, bulk)
    VALUES
      (${userId}, 'Parcelwerk Shop', 'shop@parcelwerk.example.com', 'Sold out',
       'We cannot consider your order.', now() - interval '3 hours', 'en', 'review', 'bulk_mail',
       'rejected', 0.5, ${id(5)}, ${id(5)}, false, true),
      (${userId}, 'Parcelwerk Recruiting', 'jobs@parcelwerk.example.com', 'Your documents',
       'We received your application documents.', now() - interval '2 hours', 'en', 'review', 'no_keyword',
       NULL, 0.5, ${id(6)}, ${id(6)}, false, false)`;
  await sql`
    INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result, attempts, internal_date) VALUES
      (${userId}, ${id(5)}, 'stored', 0, now() - interval '3 hours'),
      (${userId}, ${id(6)}, 'stored', 0, now() - interval '2 hours')`;
}

/**
 * Rows the release with 0004_extension_keys.sql adds for a user: two browsers connected to the
 * Chrome extension, one used since and one not yet. The hashes stand in for keys' (32 bytes).
 */
async function seedExtensionKeys(sql: Sql, n: number, userId: string): Promise<void> {
  const hash = (k: number) => createHash("sha256").update(`upgrade-extension-key-${n}-${k}`).digest();
  await sql`
    INSERT INTO extension_keys (user_id, token_hash, label, created_at, last_used_at) VALUES
      (${userId}, ${hash(1)}, 'Chrome on Linux', now() - interval '3 days', now() - interval '10 minutes'),
      (${userId}, ${hash(2)}, 'Chrome on macOS', now() - interval '1 hour', NULL)`;
}

/** SEEDS[name]: rows for a schema migrated up to and including `name`. */
const SEEDS: Partial<Record<string, Seed>> = {
  "0001_core.sql": async (sql, n) => {
    await seedCore(sql, n);
  },
  "0002_inbox.sql": async (sql, n) => {
    await seedInbox(sql, n, await seedCore(sql, n));
  },
  "0003_email_bulk.sql": async (sql, n) => {
    const userId = await seedCore(sql, n);
    await seedInbox(sql, n, userId);
    await seedBulk(sql, n, userId);
  },
  "0004_extension_keys.sql": async (sql, n) => {
    const userId = await seedCore(sql, n);
    await seedInbox(sql, n, userId);
    await seedBulk(sql, n, userId);
    await seedExtensionKeys(sql, n, userId);
  },
};

/** UPGRADES[name]: what the migration `name` must make of the rows written before it. */
const UPGRADES: Partial<Record<string, Upgrade>> = {
  "0002_inbox.sql": async (sql) => {
    // Mail from before Gmail ingest has no Gmail ids, so the new unique key holds for it, and none
    // of it was cut.
    expect([...(await sql`SELECT DISTINCT gmail_message_id, gmail_thread_id, body_truncated FROM emails`)]).toEqual([
      { gmail_message_id: null, gmail_thread_id: null, body_truncated: false },
    ]);
    // Nobody has a mailbox until they connect one.
    const [counts] = await sql`
      SELECT (SELECT count(*)::int FROM inbox_connections) AS connections,
             (SELECT count(*)::int FROM inbox_seen_messages) AS seen`;
    expect(counts).toEqual({ connections: 0, seen: 0 });
    // The widened check keeps the old reasons, and mail waiting for review can take a new one.
    const moved = await sql`UPDATE emails SET review_reason = 'status_mismatch' WHERE review_reason = 'ambiguous_job'`;
    expect(moved.count).toBeGreaterThan(0);
    // A user from before connects their mailbox, and mail from Gmail joins theirs.
    const [{ id: userId }] = await sql<{ id: string }[]>`SELECT id FROM users WHERE google_sub = 'upgrade-sub-1'`;
    await seedInbox(sql, 1, userId);
  },
  "0003_email_bulk.sql": async (sql) => {
    // Nothing recorded the headers of mail stored before: unknown, also for mail that waits in
    // review as a mass mailing (the review re-check leaves that mail alone).
    expect([...(await sql`SELECT DISTINCT bulk FROM emails`)]).toEqual([{ bulk: null }]);
    expect((await sql`SELECT 1 FROM emails WHERE review_reason = 'bulk_mail'`).length).toBeGreaterThan(0);
    // Mail ingested from now on records them.
    const [{ id: userId }] = await sql<{ id: string }[]>`SELECT id FROM users WHERE google_sub = 'upgrade-sub-1'`;
    await seedBulk(sql, 1, userId);
    const flags = await sql<{ bulk: boolean | null }[]>`SELECT DISTINCT bulk FROM emails ORDER BY bulk`;
    expect(flags.map((f) => f.bulk)).toEqual([false, true, null]);
  },
  "0004_extension_keys.sql": async (sql) => {
    // A new table: no browser is connected until someone connects one.
    expect([...(await sql`SELECT count(*)::int AS n FROM extension_keys`)]).toEqual([{ n: 0 }]);
    // A user from before connects the extension.
    const [{ id: userId }] = await sql<{ id: string }[]>`SELECT id FROM users WHERE google_sub = 'upgrade-sub-1'`;
    await seedExtensionKeys(sql, 1, userId);
    const keys = await sql<{ label: string; used: boolean }[]>`
      SELECT label, last_used_at IS NOT NULL AS used FROM extension_keys WHERE user_id = ${userId} ORDER BY label`;
    expect([...keys]).toEqual([
      { label: "Chrome on Linux", used: true },
      { label: "Chrome on macOS", used: false },
    ]);
  },
};

type Snapshot = Record<string, { columns: string[]; rows: Record<string, unknown>[] }>;

/**
 * Every table's rows but schema_migrations', in a fixed order. With `like` (an earlier snapshot),
 * only its tables and columns: what was there before a migration, read after it.
 */
async function snapshot(sql: Sql, like?: Snapshot): Promise<Snapshot> {
  let tables: Array<[string, string[]]>;
  if (like) {
    tables = Object.entries(like).map(([table, { columns }]) => [table, columns]);
  } else {
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name <> 'schema_migrations'
      ORDER BY table_name, ordinal_position`;
    const byTable = new Map<string, string[]>();
    for (const r of rows) byTable.set(r.table_name, [...(byTable.get(r.table_name) ?? []), r.column_name]);
    tables = [...byTable];
  }
  const result: Snapshot = {};
  for (const [table, columns] of tables) {
    const rows = await sql.unsafe<Record<string, unknown>[]>(
      `SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM "${table}"`,
    );
    // Sorted by content, which works for every column type: the same rows give the same order.
    const key = (row: Record<string, unknown>) => JSON.stringify(row);
    result[table] = { columns, rows: [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)) };
  }
  return result;
}

/** Fails, naming the seed, unless every table has rows: an empty table proves nothing. */
function expectRowsEverywhere(before: Snapshot, seed: string) {
  for (const [table, { rows }] of Object.entries(before)) {
    expect(rows.length, `SEEDS["${seed}"] writes no rows to ${table}: add some`).toBeGreaterThan(0);
  }
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A migrations directory of its own under the system's temp directory, with copies of `names`. */
function migrationsDir(names: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "migrate-upgrade-"));
  tempDirs.push(dir);
  for (const name of names) copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
  return dir;
}

describe("upgrade cases", () => {
  it("exist for every migration", () => {
    for (const [i, name] of FILES.entries()) {
      if (i > 0) {
        expect(
          UPGRADES[name],
          `${name} has no upgrade case. Add UPGRADES["${name}"] in tests/db/migrate-upgrade.test.ts: what it must make of the rows already there.`,
        ).toBeDefined();
      }
      expect(
        SEEDS[name],
        `${name} has no seed. Add SEEDS["${name}"] in tests/db/migrate-upgrade.test.ts: rows in every table as the release with ${name} writes them.`,
      ).toBeDefined();
    }
    // A case under a name that is no file (a typo, a renamed file) would never run.
    expect([...Object.keys(UPGRADES), ...Object.keys(SEEDS)].filter((name) => !FILES.includes(name))).toEqual([]);
  });
});

describeDb("migrations over existing data", () => {
  for (const [i, name] of FILES.entries()) {
    if (i === 0) continue;
    const previous = FILES[i - 1];
    const seed = SEEDS[previous];
    const upgrade = UPGRADES[name];
    // Without either, the test above fails and says what to add.
    if (!seed || !upgrade) continue;
    it(`applies ${name} over the rows of the release before it`, async () => {
      await withEmptySchema(`upgrade${i}`, async (sql) => {
        const dir = migrationsDir(FILES.slice(0, i));
        await runMigrations(sql, { dir, log: () => {} });
        await seed(sql, 1);
        const before = await snapshot(sql);
        expectRowsEverywhere(before, previous);

        copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
        expect(await runMigrations(sql, { dir, log: () => {} })).toEqual([name]);

        expect(await snapshot(sql, before)).toEqual(before);
        await upgrade(sql);
        // The previous release goes on writing its rows as it did.
        await seed(sql, 2);
      });
    });
  }

  const newest = FILES.at(-1)!;
  const newestSeed = SEEDS[newest];
  if (!newestSeed) return;
  it("has rows for every table of the newest schema, kept by a run with nothing to apply", async () => {
    // The block's schema has every migration. Its rows are what the next migration's case starts from.
    await newestSeed(testSql(), 1);
    const before = await snapshot(testSql());
    expectRowsEverywhere(before, newest);
    expect(await runMigrations(testSql(), { log: () => {} })).toEqual([]);
    expect(await snapshot(testSql())).toEqual(before);
  });
});
