// Real-PostgreSQL harness for database tests.
//
//   import { describeDb, testSql } from "../helpers/test-db";
//
//   describeDb("jobs repository", () => {
//     it("inserts", async () => {
//       const sql = testSql();                   // the test client, or call code that uses getDb()
//       await sql`INSERT INTO users (google_sub, email) VALUES ('sub-1', 'a@example.com')`;
//     });
//   });
//
// Each describeDb block (use one per test file) gets its own throwaway schema
// (test_<pid>_<random>) in the database from TEST_DATABASE_URL: created and migrated with
// db/migrate.mjs before the block, every table emptied before each test, dropped after the block.
// getDb() and withTx() use the test client meanwhile (setDbForTests), so code under test needs
// no changes. The client only has the test schema on its search_path, so the database's own
// tables are never touched.
//
// TEST_DATABASE_URL comes from the CI workflow (the PostgreSQL service) or from .env.local via
// vitest.config.mts. When it is empty the block is skipped here, and fails in CI (CI is set).
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import postgres from "postgres";
import { createSql, setDbForTests, type Sql } from "@/lib/server/db/client";
import { runMigrations } from "../../db/migrate.mjs";

let current: Sql | undefined;

/** The current block's client (search_path = its schema). Only inside a describeDb block's tests. */
export function testSql(): Sql {
  if (!current) throw new Error("testSql() is only available inside a describeDb() block, once it has started");
  return current;
}

/**
 * Runs fn with a client on a new, empty schema next to the block's own, for tests that migrate a
 * schema themselves (step by step, or from another directory). The schema is named after the
 * block's plus `suffix`, and dropped with the client afterwards. Only inside a describeDb block's
 * tests.
 */
export async function withEmptySchema<T>(suffix: string, fn: (sql: Sql, schema: string) => Promise<T>): Promise<T> {
  const [{ s }] = await testSql()<{ s: string }[]>`SELECT current_schema() AS s`;
  const schema = `${s}_${suffix}`;
  await testSql().unsafe(`CREATE SCHEMA "${schema}"`);
  const sql = createSql(process.env.TEST_DATABASE_URL!, { max: 1, searchPath: schema });
  try {
    return await fn(sql, schema);
  } finally {
    await sql.end({ timeout: 5 });
    await testSql().unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  }
}

/** describe() with its own migrated schema; skipped without TEST_DATABASE_URL, failed in CI. */
export function describeDb(name: string, fn: () => void): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url && !process.env.CI) {
    describe.skip(`${name} (skipped: TEST_DATABASE_URL is not set)`, fn);
    return;
  }
  describe(name, () => {
    setupTestDb(url);
    fn();
  });
}

function setupTestDb(url: string | undefined): void {
  const schema = `test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  let admin: postgres.Sql | undefined;
  let sql: Sql | undefined;
  let tables: string[] = [];

  beforeAll(async () => {
    if (!url) {
      throw new Error("The database tests need TEST_DATABASE_URL. In CI it comes from the PostgreSQL service.");
    }
    admin = postgres(url, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    sql = createSql(url, { max: 3, searchPath: schema });
    await runMigrations(sql, { log: () => {} });
    const rows = await admin<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = ${schema} AND tablename <> 'schema_migrations'`;
    tables = rows.map((r) => r.tablename);
    current = sql;
    setDbForTests(sql);
  }, 30_000);

  beforeEach(async () => {
    if (sql && tables.length) await sql.unsafe(`TRUNCATE ${tables.map((t) => `"${schema}"."${t}"`).join(", ")}`);
  });

  afterAll(async () => {
    current = undefined;
    setDbForTests(undefined);
    await sql?.end({ timeout: 5 });
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end({ timeout: 5 });
    }
  });
}
