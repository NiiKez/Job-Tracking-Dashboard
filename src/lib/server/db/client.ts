import "server-only";
import postgres from "postgres";
import { getEnv } from "@/lib/server/env";

/**
 * The PostgreSQL client (postgres.js 3).
 *
 *   getDb()                  the shared pool, created on first use (never at import or build time)
 *   withTx(async (tx) => …)  one transaction; commits when fn resolves, rolls back when it throws
 *   isUniqueViolation(err, "jobs_user_id_url_norm_key")
 *
 * Every repository function takes a `Db` first: the pool or a transaction, so the same function
 * runs alone or inside withTx().
 *
 * The schema lives in db/migrations. The deploy runs `npm run migrate` before it switches to a
 * new release, so the app never creates or changes tables itself.
 *
 * postgres.js returns timestamptz as Date, bigint and numeric as string (cast count(*) to int),
 * and uuid[] / text[] as string arrays.
 */

/** The pool. */
export type Sql = postgres.Sql;
/** A transaction from withTx() or sql.begin(). */
export type Tx = postgres.TransactionSql;
/** The pool or a transaction: what every repository function accepts as its first argument. */
export type Db = postgres.ISql;

export function createSql(url: string, opts: { max?: number; searchPath?: string } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 5,
    idle_timeout: 60,
    connect_timeout: 10,
    // Unnamed statements: a migration that runs while the old release still serves would
    // otherwise break its cached `SELECT *` plans ("cached plan must not change result type").
    prepare: false,
    onnotice: () => {},
    connection: {
      application_name: "job-tracker",
      // Tests point each file at its own throwaway schema.
      ...(opts.searchPath ? { search_path: opts.searchPath } : {}),
    },
  });
}

// On globalThis, so Next dev's hot reloads reuse the pool instead of opening a new one each time.
const g = globalThis as unknown as { __jobTrackerSql?: Sql };

/** The shared pool. Created on first use, so `next build` never needs DATABASE_URL. */
export function getDb(): Sql {
  if (!g.__jobTrackerSql) {
    const url = getEnv().databaseUrl;
    if (!url) throw new Error("DATABASE_URL is not set");
    g.__jobTrackerSql = createSql(url);
  }
  return g.__jobTrackerSql;
}

/** Test seam: route getDb() to a test client (see tests/helpers/test-db.ts). */
export function setDbForTests(sql: Sql | undefined): void {
  g.__jobTrackerSql = sql;
}

/**
 * Runs fn in one transaction on the shared pool. Inside, pass `tx` (not getDb()) to every
 * repository call. Transactions do not nest: use tx.savepoint() for a partial rollback.
 */
export function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  // begin()'s declared result unwraps arrays of promises; fn already returns plain values.
  return getDb().begin(fn) as Promise<T>;
}

/** True if `err` is a unique violation of the given constraint or unique index. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  // By fields, not instanceof postgres.PostgresError: the pool lives on globalThis, and the bundle
  // that created it (a route's, or the inbox scheduler's, which Next.js bundles with its own copy
  // of postgres) decides whose class every query error has. The class name is minified in a build.
  const e = err as { code?: unknown; constraint_name?: unknown };
  return err instanceof Error && e.code === "23505" && e.constraint_name === constraint;
}
