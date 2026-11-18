// npm run db:seed [-- someone@example.com]
//
// Fills a development database with the demo jobs and emails (db/seed/fixtures.ts) for one
// account: the named one, or else the first user that signed in. That user's jobs and emails
// are replaced; keyword rules and settings stay. Sign in to the app once first, because the
// data belongs to an account.
//
// DATABASE_URL comes from the environment, else from .env.local. Only a database whose name ends
// in _dev or _test is seeded (see db/seed/seed.ts). Nothing printed here contains the connection
// string.
//
// Runs with tsx under the react-server export condition (see package.json), where the
// "server-only" imports of the app's server modules are empty. tsx resolves the "@/" paths from
// tsconfig.json.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { createSql } from "@/lib/server/db/client";
import { runSeed, SeedError } from "../db/seed/seed";

// npm runs scripts in the project folder.
const ENV_FILE = path.resolve(process.cwd(), ".env.local");

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (!existsSync(ENV_FILE)) return undefined;
  return parseEnv(readFileSync(ENV_FILE, "utf8")).DATABASE_URL || undefined;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((a) => a.startsWith("-"))) {
    console.error("usage: npm run db:seed [-- someone@example.com]");
    return 2;
  }
  const url = databaseUrl();
  if (!url) {
    console.error("db:seed: DATABASE_URL is not set. Put it in .env.local.");
    return 1;
  }

  // The client is created inside the try: postgres.js parses the URL right away, and a value it
  // cannot parse (an unencoded "/" in the password, a port out of range) would otherwise reject
  // main() with a TypeError that Node prints with the whole URL as `input`.
  let sql: ReturnType<typeof createSql> | undefined;
  try {
    sql = createSql(url, { max: 1 });
    const result = await runSeed(sql, { email: args[0] });
    console.log(
      `db:seed: ${result.jobs} jobs and ${result.emails} emails for ${result.user.email} in ${result.database}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof SeedError) {
      console.error(`db:seed: ${err.message}`);
    } else {
      // The message only (no stack, no error object), with the connection string masked in case
      // a driver message ever echoes it.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`db:seed: failed: ${message.split(url).join("<DATABASE_URL>")}`);
    }
    return 1;
  } finally {
    await sql?.end({ timeout: 5 });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // Never print the error object: it may carry the connection string.
    console.error("db:seed: failed");
    process.exitCode = 1;
  },
);
