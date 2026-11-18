import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { createSql, isUniqueViolation, type Sql } from "@/lib/server/db/client";
import { MIGRATIONS_DIR, runMigrations } from "../../db/migrate.mjs";
import { describeDb, testSql, withEmptySchema } from "../helpers/test-db";

const REPO = path.resolve(__dirname, "../..");
const FILES = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

const TABLES = [
  "emails",
  "extension_keys",
  "inbox_connections",
  "inbox_seen_messages",
  "job_status_events",
  "jobs",
  "keyword_rules",
  "sessions",
  "user_settings",
  "users",
];

async function insertUser(n: number): Promise<string> {
  const [row] = await testSql()<{ id: string }[]>`
    INSERT INTO users (google_sub, email) VALUES (${`sub-${n}`}, ${`user${n}@example.com`}) RETURNING id`;
  return row.id;
}

async function insertJob(userId: string, fields: { url?: string | null; urlNorm?: string | null } = {}) {
  const [row] = await testSql()<{ id: string }[]>`
    INSERT INTO jobs (user_id, title, company, url, url_norm, company_slug, title_norm, search_text,
                      status, status_source, capture_method)
    VALUES (${userId}, 'Frontend Engineer', 'Acme', ${fields.url ?? null}, ${fields.urlNorm ?? null},
            'acme', 'frontend engineer', 'acme frontend engineer', 'saved', 'paste', 'paste')
    RETURNING id`;
  return row.id;
}

async function insertEmail(userId: string, jobId: string | null, gmailMessageId: string | null = null) {
  const [row] = await testSql()<{ id: string }[]>`
    INSERT INTO emails (user_id, job_id, subject, received_at, outcome, confidence, gmail_message_id)
    VALUES (${userId}, ${jobId}, 'Your application', now(), 'matched', 0.9, ${gmailMessageId})
    RETURNING id`;
  return row.id;
}

/** A connected mailbox (demo-style: no token) and one ledger row for the user. */
async function insertInbox(userId: string, n: number) {
  await testSql()`
    INSERT INTO inbox_connections (user_id, google_sub, email_address, status)
    VALUES (${userId}, ${`sub-${n}`}, ${`user${n}@example.com`}, 'connected')`;
  await testSql()`
    INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result, internal_date)
    VALUES (${userId}, ${`19a6d2c4e8f1a0${n}0`}, 'ignored', now())`;
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/** A file of db/migrations, byte for byte. */
function migration(name: string): Buffer {
  return readFileSync(path.join(MIGRATIONS_DIR, name));
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A migrations directory of its own under the system's temp directory: file name -> contents. */
function migrationsDir(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "migrate-test-"));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) writeFileSync(path.join(dir, name), contents);
  return dir;
}

/** schema_migrations as [name, checksum] pairs, in order. */
async function recorded(sql: Sql): Promise<Array<[string, string | null]>> {
  const rows = await sql<{ name: string; checksum: string | null }[]>`
    SELECT name, checksum FROM schema_migrations ORDER BY name`;
  return rows.map((r) => [r.name, r.checksum]);
}

async function tableNames(sql: Sql): Promise<string[]> {
  const rows = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`;
  return rows.map((r) => r.tablename);
}

async function columnNames(sql: Sql, table: string): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table}
    ORDER BY ordinal_position`;
  return rows.map((r) => r.column_name);
}

/**
 * `npm run migrate` as the deploy runs it, on `schema` of the test database. Check `showsUrl`
 * before anything that prints the output: a failing toContain() would print the connection string.
 */
function migrateCli(schema: string) {
  const url = process.env.TEST_DATABASE_URL!;
  // postgres.js passes URL parameters it does not know on to the server as settings.
  const databaseUrl = `${url}${url.includes("?") ? "&" : "?"}search_path=${schema}`;
  const result = spawnSync(process.execPath, [path.join(REPO, "db", "migrate.mjs")], {
    cwd: REPO,
    env: { NODE_ENV: "test", PATH: process.env.PATH, DATABASE_URL: databaseUrl },
    encoding: "utf8",
    timeout: 20_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  return { status: result.status, output, showsUrl: output.includes(url) };
}

/**
 * A migration whose statements all succeed but the last: it adds a check that the row from
 * 0001_things.sql breaks. The usual way a real one fails on production data after passing on a
 * fresh test schema.
 */
function halfway(check: string): string {
  return [
    "CREATE TABLE extras (id int PRIMARY KEY);",
    "INSERT INTO extras VALUES (1);",
    "ALTER TABLE things ADD COLUMN note text NOT NULL DEFAULT '';",
    "UPDATE things SET note = 'touched';",
    "INSERT INTO things (id, label) VALUES (2, 'added');",
    `ALTER TABLE things ADD CONSTRAINT things_label_check CHECK (${check});`,
    "",
  ].join("\n");
}

describeDb("migrations", () => {
  it("applies every migration file to a fresh schema", async () => {
    const applied = await testSql()<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    expect(applied.map((r) => r.name)).toEqual(FILES);
    expect(FILES[0]).toBe("0001_core.sql");

    const tables = await testSql()<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`;
    expect(tables.map((r) => r.tablename).sort()).toEqual([...TABLES, "schema_migrations"].sort());
  });

  it("lets concurrent runners on a fresh schema apply each file exactly once", async () => {
    const url = process.env.TEST_DATABASE_URL!;
    // Creating schema_migrations used to race outside the lock (duplicate key in pg_type), so
    // several rounds: a single one can pass by timing.
    for (let round = 0; round < 5; round++) {
      const schema = `${(await testSql()<{ s: string }[]>`SELECT current_schema() AS s`)[0].s}_race${round}`;
      await testSql().unsafe(`CREATE SCHEMA "${schema}"`);
      const runners = Array.from({ length: 4 }, () => createSql(url, { max: 1, searchPath: schema }));
      try {
        await Promise.all(runners.map((sql) => sql`SELECT 1`));
        const results = await Promise.all(runners.map((sql) => runMigrations(sql, { log: () => {} })));
        // Each file once, across all runners. Not necessarily by one runner: every file has its
        // own transaction, so one runner may apply 0001 while another goes on to 0002.
        expect(results.flat().sort()).toEqual(FILES);
      } finally {
        await Promise.all(runners.map((sql) => sql.end({ timeout: 5 })));
        await testSql().unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      }
    }
  });

  it("applies nothing on a second run", async () => {
    const lines: string[] = [];
    expect(await runMigrations(testSql(), { log: (line) => lines.push(line) })).toEqual([]);
    expect(lines).toEqual(["migrate: up to date"]);
  });

  it("gives every table a uuidv7 id by default", async () => {
    const userId = await insertUser(1);
    const jobId = await insertJob(userId);
    for (const id of [userId, jobId]) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("creates settings with today's defaults and enforces their ranges", async () => {
    const userId = await insertUser(1);
    const [row] = await testSql()`INSERT INTO user_settings (user_id) VALUES (${userId}) RETURNING *`;
    expect(row).toMatchObject({
      no_response_days: 30,
      create_from_confirmation: true,
      review_uncertain: true,
      languages: ["en", "de"],
      inbox_interval_minutes: 15,
    });
    await expect(testSql()`UPDATE user_settings SET no_response_days = 6`).rejects.toMatchObject({
      constraint_name: "user_settings_no_response_days_check",
    });
    await expect(testSql()`UPDATE user_settings SET inbox_interval_minutes = 1441`).rejects.toMatchObject({
      constraint_name: "user_settings_inbox_interval_minutes_check",
    });
  });

  it("keeps a child from pointing at another user's job", async () => {
    const alice = await insertUser(1);
    const bob = await insertUser(2);
    const alicesJob = await insertJob(alice);
    await expect(
      testSql()`
        INSERT INTO job_status_events (user_id, job_id, to_status, source)
        VALUES (${bob}, ${alicesJob}, 'saved', 'paste')`,
    ).rejects.toMatchObject({ code: "23503", constraint_name: "job_status_events_user_id_job_id_fkey" });
    await expect(insertEmail(bob, alicesJob)).rejects.toMatchObject({
      code: "23503",
      constraint_name: "emails_user_id_job_id_fkey",
    });
  });

  it("allows one job per normalized link and user, and any number without a link", async () => {
    const alice = await insertUser(1);
    const bob = await insertUser(2);
    const link = { url: "https://example.com/jobs/1", urlNorm: "example.com/jobs/1" };
    await insertJob(alice, link);
    const duplicate = await insertJob(alice, link).catch((err: unknown) => err);
    expect(isUniqueViolation(duplicate, "jobs_user_id_url_norm_key")).toBe(true);
    await insertJob(bob, link); // another user's jobs never collide
    await insertJob(alice);
    await insertJob(alice);
    const [{ count }] = await testSql()<{ count: number }[]>`SELECT count(*)::int AS count FROM jobs`;
    expect(count).toBe(4);
  });

  it("keeps the mail of a deleted job and drops its history", async () => {
    const userId = await insertUser(1);
    const jobId = await insertJob(userId);
    const emailId = await insertEmail(userId, jobId);
    await testSql()`
      INSERT INTO job_status_events (user_id, job_id, to_status, source, email_id)
      VALUES (${userId}, ${jobId}, 'applied', 'email', ${emailId})`;

    await testSql()`DELETE FROM jobs WHERE id = ${jobId}`;

    const [email] = await testSql()`SELECT user_id, job_id FROM emails WHERE id = ${emailId}`;
    expect(email).toEqual({ user_id: userId, job_id: null });
    const [{ count }] = await testSql()<{ count: number }[]>`SELECT count(*)::int AS count FROM job_status_events`;
    expect(count).toBe(0);
  });

  it("keeps the history of a deleted email", async () => {
    const userId = await insertUser(1);
    const jobId = await insertJob(userId);
    const emailId = await insertEmail(userId, jobId);
    await testSql()`
      INSERT INTO job_status_events (user_id, job_id, to_status, source, email_id)
      VALUES (${userId}, ${jobId}, 'applied', 'email', ${emailId})`;

    await testSql()`DELETE FROM emails WHERE id = ${emailId}`;

    const [event] = await testSql()`SELECT user_id, job_id, email_id FROM job_status_events`;
    expect(event).toEqual({ user_id: userId, job_id: jobId, email_id: null });
  });

  it("deletes everything of a user with the user, and nothing of anyone else", async () => {
    const alice = await insertUser(1);
    const bob = await insertUser(2);
    for (const userId of [alice, bob]) {
      const jobId = await insertJob(userId);
      const emailId = await insertEmail(userId, jobId);
      await testSql()`
        INSERT INTO job_status_events (user_id, job_id, to_status, source, email_id)
        VALUES (${userId}, ${jobId}, 'applied', 'email', ${emailId})`;
      await testSql()`
        INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (${userId}, ${Buffer.alloc(32, userId === alice ? 1 : 2)}, now() + interval '30 days')`;
      await testSql()`
        INSERT INTO extension_keys (user_id, token_hash, label)
        VALUES (${userId}, ${Buffer.alloc(32, userId === alice ? 1 : 2)}, 'Chrome on Linux')`;
      await testSql()`INSERT INTO keyword_rules (user_id, status, phrase, phrase_norm, language)
                      VALUES (${userId}, 'rejected', 'Leider', 'leider', 'de')`;
      await testSql()`INSERT INTO user_settings (user_id) VALUES (${userId})`;
      await insertInbox(userId, userId === alice ? 1 : 2);
    }

    await testSql()`DELETE FROM users WHERE id = ${alice}`;

    for (const table of TABLES) {
      const rows = await testSql().unsafe<{ user_id: string }[]>(
        table === "users" ? "SELECT id AS user_id FROM users" : `SELECT user_id FROM ${table}`,
      );
      expect(rows.map((r) => r.user_id), table).toEqual([bob]);
    }
  });

  it("rejects values outside the types' unions and malformed rows", async () => {
    const userId = await insertUser(1);
    const jobId = await insertJob(userId);
    const sql = testSql();
    const cases: Array<[string, Promise<unknown>]> = [
      ["users_email_check", sql`INSERT INTO users (google_sub, email) VALUES ('sub-x', 'Upper@Example.com')`],
      ["jobs_status_check", sql`UPDATE jobs SET status = 'ghosted'`],
      ["jobs_status_source_check", sql`UPDATE jobs SET status_source = 'robot'`],
      ["jobs_capture_method_check", sql`UPDATE jobs SET capture_method = 'manual'`],
      ["jobs_title_check", sql`UPDATE jobs SET title = '  '`],
      ["jobs_url_norm_check", sql`UPDATE jobs SET url_norm = 'example.com/x'`], // a key without a link
      [
        "jobs_next_interview_at_next_interview_round_check",
        sql`UPDATE jobs SET next_interview_at = now()`, // the round must be set with it
      ],
      ["job_status_events_to_status_check", sql`
        INSERT INTO job_status_events (user_id, job_id, to_status, source)
        VALUES (${userId}, ${jobId}, 'hired', 'manual')`],
      ["emails_outcome_check", sql`
        INSERT INTO emails (user_id, received_at, outcome, confidence)
        VALUES (${userId}, now(), 'spam', 0.5)`],
      ["emails_review_reason_check", sql`
        INSERT INTO emails (user_id, received_at, outcome, review_reason, confidence)
        VALUES (${userId}, now(), 'review', 'bored', 0.5)`],
      ["emails_confidence_check", sql`
        INSERT INTO emails (user_id, received_at, outcome, confidence)
        VALUES (${userId}, now(), 'review', 1.5)`],
      ["keyword_rules_status_check", sql`
        INSERT INTO keyword_rules (user_id, status, phrase, phrase_norm, language)
        VALUES (${userId}, 'saved', 'saved it', 'saved it', 'en')`],
      ["sessions_token_hash_check", sql`
        INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (${userId}, ${Buffer.alloc(16)}, now())`],
      ["emails_gmail_message_id_check", sql`
        INSERT INTO emails (user_id, received_at, outcome, confidence, gmail_message_id)
        VALUES (${userId}, now(), 'review', 0.5, '')`],
      ["emails_gmail_thread_id_check", sql`
        INSERT INTO emails (user_id, received_at, outcome, confidence, gmail_thread_id)
        VALUES (${userId}, now(), 'review', 0.5, ${"t".repeat(65)})`],
      ["inbox_connections_email_address_check", sql`
        INSERT INTO inbox_connections (user_id, google_sub, email_address, status)
        VALUES (${userId}, 'sub-1', 'User1@Example.com', 'connected')`],
      ["inbox_connections_status_check", sql`
        INSERT INTO inbox_connections (user_id, google_sub, email_address, status)
        VALUES (${userId}, 'sub-1', 'user1@example.com', 'paused')`],
      ["inbox_connections_refresh_token_enc_check", sql`
        INSERT INTO inbox_connections (user_id, google_sub, email_address, status, refresh_token_enc)
        VALUES (${userId}, 'sub-1', 'user1@example.com', 'disconnected', 'v1.k.iv.data')`],
      ["inbox_connections_demo_check", sql`
        INSERT INTO inbox_connections (user_id, google_sub, email_address, status, demo, refresh_token_enc)
        VALUES (${userId}, 'sub-1', 'user1@example.com', 'connected', true, 'v1.k.iv.data')`],
      ["inbox_connections_backfill_state_check", sql`
        INSERT INTO inbox_connections (user_id, google_sub, email_address, status, backfill_state)
        VALUES (${userId}, 'sub-1', 'user1@example.com', 'connected', 'halfway')`],
      ["inbox_connections_lease_owner_lease_until_check", sql`
        INSERT INTO inbox_connections (user_id, google_sub, email_address, status, lease_owner)
        VALUES (${userId}, 'sub-1', 'user1@example.com', 'connected', 'pid-1')`],
      ["inbox_seen_messages_result_check", sql`
        INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result)
        VALUES (${userId}, '19a6d2c4e8f1a001', 'pending')`],
      ["inbox_seen_messages_gmail_message_id_check", sql`
        INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result)
        VALUES (${userId}, '', 'ignored')`],
    ];
    for (const [constraint, query] of cases) {
      await expect(query, constraint).rejects.toMatchObject({ code: "23514", constraint_name: constraint });
    }
  });
  it("keeps one email per Gmail message and user, any number without one, and the new review reasons", async () => {
    const alice = await insertUser(1);
    const bob = await insertUser(2);
    await insertEmail(alice, null, "19a6d2c4e8f1a001");
    const duplicate = await insertEmail(alice, null, "19a6d2c4e8f1a001").catch((err: unknown) => err);
    expect(isUniqueViolation(duplicate, "emails_user_id_gmail_message_id_key")).toBe(true);
    await insertEmail(bob, null, "19a6d2c4e8f1a001"); // another user's mail never collides
    await insertEmail(alice, null);
    await insertEmail(alice, null);
    const [{ count }] = await testSql()<{ count: number }[]>`SELECT count(*)::int AS count FROM emails`;
    expect(count).toBe(4);

    const [row] = await testSql()`
      INSERT INTO emails (user_id, received_at, outcome, review_reason, confidence)
      VALUES (${alice}, now(), 'review', 'status_mismatch', 0.5)
      RETURNING body_truncated, gmail_message_id, gmail_thread_id`;
    expect(row).toEqual({ body_truncated: false, gmail_message_id: null, gmail_thread_id: null });
    const [bulk] = await testSql()`
      INSERT INTO emails (user_id, received_at, outcome, review_reason, confidence)
      VALUES (${alice}, now(), 'review', 'bulk_mail', 0.5)
      RETURNING review_reason`;
    expect(bulk).toEqual({ review_reason: "bulk_mail" });
  });

  it("gives an inbox connection its defaults and one row per user", async () => {
    const userId = await insertUser(1);
    const [row] = await testSql()`
      INSERT INTO inbox_connections (user_id, google_sub, email_address, status)
      VALUES (${userId}, 'sub-1', 'user1@example.com', 'connected')
      RETURNING demo, refresh_token_enc, granted_scopes, history_id, backfill_state, backfill_total, backfill_done,
                consecutive_failures, lease_owner, lease_until`;
    expect(row).toEqual({
      demo: false,
      refresh_token_enc: null,
      granted_scopes: [],
      history_id: null,
      backfill_state: "pending",
      backfill_total: null,
      backfill_done: 0,
      consecutive_failures: 0,
      lease_owner: null,
      lease_until: null,
    });
    const second = await testSql()`
      INSERT INTO inbox_connections (user_id, google_sub, email_address, status)
      VALUES (${userId}, 'sub-1', 'user1@example.com', 'connected')`.catch((err: unknown) => err);
    expect(isUniqueViolation(second, "inbox_connections_user_id_key")).toBe(true);

    const [seen] = await testSql()`
      INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result)
      VALUES (${userId}, '19a6d2c4e8f1a001', 'retry')
      RETURNING attempts, internal_date, seen_at`;
    expect(seen).toMatchObject({ attempts: 0, internal_date: null, seen_at: expect.any(Date) });
  });

  it("records the SHA-256 of every file it applies", async () => {
    expect(await recorded(testSql())).toEqual(FILES.map((name) => [name, sha256(migration(name))]));
  });

  it("adds the checksum to a schema_migrations table from before it, trusting the files once", async () => {
    await withEmptySchema("old", async (sql) => {
      // What the runner before checksums left behind: its table, and the files it applied (all
      // but the newest here, so the same run also applies one).
      await sql`
        CREATE TABLE schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      const earlier = FILES.slice(0, -1);
      const appliedAt = new Date("2026-11-01T00:00:00Z");
      for (const name of earlier) {
        await sql.begin(async (tx) => {
          await tx.unsafe(migration(name).toString("utf8"));
          await tx`INSERT INTO schema_migrations (name, applied_at) VALUES (${name}, ${appliedAt})`;
        });
      }

      const lines: string[] = [];
      expect(await runMigrations(sql, { log: (line) => lines.push(line) })).toEqual(FILES.slice(-1));
      expect(lines).toEqual([
        ...earlier.map((name) => `migrate: recorded the checksum of ${name}, applied before checksums were kept`),
        `migrate: applied ${FILES.at(-1)}`,
      ]);
      expect(await recorded(sql)).toEqual(FILES.map((name) => [name, sha256(migration(name))]));
      // Recorded, not applied again.
      const rows = await sql<{ applied_at: Date }[]>`
        SELECT applied_at FROM schema_migrations WHERE name IN ${sql(earlier)}`;
      expect(rows.map((r) => r.applied_at)).toEqual(earlier.map(() => appliedAt));

      // From now on they are checked like any other.
      lines.length = 0;
      expect(await runMigrations(sql, { log: (line) => lines.push(line) })).toEqual([]);
      expect(lines).toEqual(["migrate: up to date"]);
    });
  });

  it("refuses an applied migration that was edited, before applying anything pending", async () => {
    const original = "-- The first version.\nCREATE TABLE a (id int PRIMARY KEY);\n";
    const edits = [
      "-- The first version.\nCREATE TABLE a (id int PRIMARY KEY, edited_marker text);\n",
      original.replaceAll("\n", "\r\n"), // the bytes count, line endings too
    ];
    for (const [i, edited] of edits.entries()) {
      await withEmptySchema(`edited${i}`, async (sql) => {
        const dir = migrationsDir({ "0001_a.sql": original });
        await runMigrations(sql, { dir, log: () => {} });
        writeFileSync(path.join(dir, "0001_a.sql"), edited);
        writeFileSync(path.join(dir, "0002_b.sql"), "CREATE TABLE b (id int PRIMARY KEY);\n");

        const lines: string[] = [];
        const err = await runMigrations(sql, { dir, log: (line) => lines.push(line) }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        const { message } = err as Error;
        expect(message).toMatch(/^0001_a\.sql was changed after it was applied /);
        expect(message).toContain("add a new migration");
        expect(message).not.toContain("edited_marker"); // the file's name, never its contents
        expect(lines).toEqual([]);
        expect(await recorded(sql)).toEqual([["0001_a.sql", sha256(original)]]);
        expect(await tableNames(sql)).toEqual(["a", "schema_migrations"]);

        // Restored, it goes on with what is pending.
        writeFileSync(path.join(dir, "0001_a.sql"), original);
        expect(await runMigrations(sql, { dir, log: () => {} })).toEqual(["0002_b.sql"]);
      });
    }
  });

  it("refuses a file that a concurrent runner applied with other contents", async () => {
    const url = process.env.TEST_DATABASE_URL!;
    const first = "CREATE TABLE a (id int PRIMARY KEY);\n";
    const dirs = [
      migrationsDir({ "0001_a.sql": first, "0002_b.sql": "CREATE TABLE b (id int PRIMARY KEY);\n" }),
      migrationsDir({ "0001_a.sql": first, "0002_b.sql": "CREATE TABLE b (id bigint PRIMARY KEY);\n" }),
    ];
    // The loser finds 0002_b.sql applied either before it starts or only when it gets to the file
    // (another runner's transaction came in between), depending on timing: several rounds.
    for (let round = 0; round < 5; round++) {
      await withEmptySchema(`differ${round}`, async (sql, schema) => {
        const other = createSql(url, { max: 1, searchPath: schema });
        try {
          await Promise.all([sql`SELECT 1`, other`SELECT 1`]);
          const results = await Promise.allSettled(
            [sql, other].map((runner, i) => runMigrations(runner, { dir: dirs[i], log: () => {} })),
          );
          const failed = results.flatMap((r) => (r.status === "rejected" ? [r.reason as Error] : []));
          expect(failed).toHaveLength(1);
          expect(failed[0].message).toMatch(/^0002_b\.sql was changed after it was applied /);
          const winner = dirs[results.findIndex((r) => r.status === "fulfilled")];
          const [[, checksum]] = (await recorded(sql)).filter(([name]) => name === "0002_b.sql");
          expect(checksum).toBe(sha256(readFileSync(path.join(winner, "0002_b.sql"))));
        } finally {
          await other.end({ timeout: 5 });
        }
      });
    }
  });

  it("reports an applied migration that is not in this release, and goes on", async () => {
    await withEmptySchema("missing", async (sql) => {
      const a = "CREATE TABLE a (id int PRIMARY KEY);\n";
      await runMigrations(sql, {
        dir: migrationsDir({ "0001_a.sql": a, "0002_b.sql": "CREATE TABLE b (id int PRIMARY KEY);\n" }),
        log: () => {},
      });

      // A release built from an older commit, such as a reverted pull request, lacks 0002_b.sql.
      const lines: string[] = [];
      expect(await runMigrations(sql, { dir: migrationsDir({ "0001_a.sql": a }), log: (line) => lines.push(line) }))
        .toEqual([]);
      expect(lines).toEqual(["migrate: 0002_b.sql is applied but not in this release; not checked", "migrate: up to date"]);
      expect((await recorded(sql)).map(([name]) => name)).toEqual(["0001_a.sql", "0002_b.sql"]);
    });
  });

  it("leaves nothing of a migration that fails halfway, and applies it once fixed", async () => {
    await withEmptySchema("halfway", async (sql) => {
      const dir = migrationsDir({
        "0001_things.sql": "CREATE TABLE things (id int PRIMARY KEY, label text NOT NULL);\nINSERT INTO things VALUES (1, 'kept');\n",
        "0002_more.sql": halfway("label <> 'kept'"),
        "0003_later.sql": "CREATE TABLE later (id int PRIMARY KEY);\n",
      });

      const lines: string[] = [];
      // The error reaches the caller: the CLI prints it and exits 1, so the deploy stops.
      await expect(runMigrations(sql, { dir, log: (line) => lines.push(line) })).rejects.toMatchObject({
        code: "23514",
        constraint_name: "things_label_check",
      });
      // 0001 stays applied and recorded, nothing of 0002 is left (table, column, rows), and 0003
      // never ran.
      expect(lines).toEqual(["migrate: applied 0001_things.sql"]);
      expect((await recorded(sql)).map(([name]) => name)).toEqual(["0001_things.sql"]);
      expect(await tableNames(sql)).toEqual(["schema_migrations", "things"]);
      expect(await columnNames(sql, "things")).toEqual(["id", "label"]);
      expect([...(await sql`SELECT * FROM things`)]).toEqual([{ id: 1, label: "kept" }]);

      // Never recorded, so it may still be fixed in place: the next run applies it and what follows.
      writeFileSync(path.join(dir, "0002_more.sql"), halfway("label <> ''"));
      expect(await runMigrations(sql, { dir, log: () => {} })).toEqual(["0002_more.sql", "0003_later.sql"]);
      expect(await recorded(sql)).toEqual([
        ["0001_things.sql", expect.any(String)],
        ["0002_more.sql", sha256(halfway("label <> ''"))],
        ["0003_later.sql", expect.any(String)],
      ]);
      expect([...(await sql`SELECT * FROM things ORDER BY id`)]).toEqual([
        { id: 1, label: "kept", note: "touched" },
        { id: 2, label: "added", note: "" },
      ]);
    });
  });

  it("stops `npm run migrate` with exit 1 when a migration fails halfway", async () => {
    await withEmptySchema("cli_halfway", async (sql, schema) => {
      await runMigrations(sql, { dir: migrationsDir({ "0001_core.sql": migration("0001_core.sql") }), log: () => {} });
      // Named like an index that 0002_inbox.sql creates after its tables and the new email columns.
      await sql`CREATE TABLE emails_user_id_from_address_idx (id int)`;

      const { status, output, showsUrl } = migrateCli(schema);
      expect(showsUrl).toBe(false);
      expect(status).toBe(1);
      expect(output).toMatch(/^migrate: failed: relation "emails_user_id_from_address_idx" already exists$/m);
      expect(output).not.toContain("migrate: applied");
      expect((await recorded(sql)).map(([name]) => name)).toEqual(["0001_core.sql"]);
      expect(await tableNames(sql)).not.toContain("inbox_connections");
      expect(await columnNames(sql, "emails")).not.toContain("gmail_message_id");
    });
  });

  it("stops `npm run migrate` with exit 1 when an applied migration was edited", async () => {
    await withEmptySchema("cli_edited", async (sql, schema) => {
      await runMigrations(sql, { log: () => {} });
      // As if 0001_core.sql had changed since it was applied.
      await sql`UPDATE schema_migrations SET checksum = ${sha256("an earlier version")} WHERE name = '0001_core.sql'`;

      const { status, output, showsUrl } = migrateCli(schema);
      expect(showsUrl).toBe(false);
      expect(status).toBe(1);
      expect(output).toMatch(/^migrate: failed: 0001_core\.sql was changed after it was applied .*add a new migration/m);
    });
  });
});
