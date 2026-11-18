#!/usr/bin/env node
// The e2e server: Playwright's webServer command (playwright.config.ts), not run by hand.
//
// 1. Refuses to start without a production build, or with one older than the source it was built
//    from: run `npm run build` first. The tests always run against `next start`, as production
//    does, never `next dev`. The source includes extension/: the same build makes the zip and the
//    version the server hands out (extension/dist).
// 2. Drops and creates the e2e schema in the test database (E2E_DATABASE_URL carries it as
//    search_path) and applies every migration to it.
// 3. Runs `next start` on 127.0.0.1:E2E_PORT with a complete, invented production configuration:
//    NODE_ENV=production (the strict start), a dummy Google client, ALLOWED_EMAILS with the e2e
//    accounts, a fresh INBOX_TOKEN_KEY, MAIL_SOURCE=fixture (allowed in production only because
//    APP_URL is an http loopback origin) and INBOX_SCHEDULER=off (the inbox is checked only when
//    a test asks). Every variable .env.example names is set here, blank when unused: `next start`
//    reads .env.local too, and a value that is already in the environment wins over it, so
//    nothing from the development configuration leaks into the run.
//
// Reads from its environment (set by playwright.config.ts): E2E_PORT, E2E_SCHEMA,
// E2E_DATABASE_URL, E2E_TEST_DATABASE_URL, E2E_ALLOWED_EMAILS, E2E_GOOGLE_CLIENT_ID. Never prints
// a value from it.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { runMigrations } from "../../../db/migrate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function fail(message) {
  console.error(`e2e server: ${message}`);
  process.exit(1);
}

const port = process.env.E2E_PORT;
const schema = process.env.E2E_SCHEMA;
const databaseUrl = process.env.E2E_DATABASE_URL;
const adminUrl = process.env.E2E_TEST_DATABASE_URL;
const allowedEmails = process.env.E2E_ALLOWED_EMAILS;
const googleClientId = process.env.E2E_GOOGLE_CLIENT_ID;
if (!port || !schema || !databaseUrl || !adminUrl || !allowedEmails || !googleClientId) {
  fail("start it through Playwright (npm run test:e2e), which sets E2E_* for it");
}
if (!/^e2e[a-z0-9_]{0,40}$/.test(schema)) fail("E2E_SCHEMA is not a valid e2e schema name");

/* ------------------------------------------------------------- the build */

const buildId = path.join(ROOT, ".next", "BUILD_ID");
if (!existsSync(buildId)) fail("there is no production build. Run `npm run build` first.");

/** The newest modification time of a file under `dir` (0 when it does not exist). */
function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    newest = Math.max(newest, statSync(path.join(entry.parentPath, entry.name)).mtimeMs);
  }
  return newest;
}

if (process.env.E2E_ALLOW_STALE_BUILD !== "1") {
  const builtAt = statSync(buildId).mtimeMs;
  const sources = ["src", "db/migrations", "extension/src", "extension/icons"].map((d) => newestMtime(path.join(ROOT, d)));
  const configs = ["next.config.ts", "package-lock.json", "extension/manifest.json", "extension/build.mjs"].map((f) => {
    const p = path.join(ROOT, f);
    return existsSync(p) ? statSync(p).mtimeMs : 0;
  });
  if (Math.max(...sources, ...configs) > builtAt) {
    fail(
      "the production build is older than src/, db/migrations, extension/, next.config.ts or package-lock.json. " +
        "Run `npm run build` first (or set E2E_ALLOW_STALE_BUILD=1 to test the old build anyway).",
    );
  }
}

/* ------------------------------------------------------------ the schema */

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
try {
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
} catch (err) {
  fail(`could not create the schema: ${err instanceof Error ? err.message.split(adminUrl).join("<url>") : "error"}`);
} finally {
  await admin.end({ timeout: 5 });
}

const migrator = postgres(databaseUrl, { max: 1, onnotice: () => {} });
try {
  await runMigrations(migrator, { log: () => {} });
} catch (err) {
  fail(`migrations failed: ${err instanceof Error ? err.message.split(databaseUrl).join("<url>") : "error"}`);
} finally {
  await migrator.end({ timeout: 5 });
}

/* ------------------------------------------------------------ the server */

// Every name in .env.example, blank: see the header.
const names = readFileSync(path.join(ROOT, ".env.example"), "utf8")
  .split("\n")
  .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
  .filter(Boolean);
const blank = Object.fromEntries(names.map((name) => [name, ""]));

const env = {
  ...process.env,
  ...blank,
  NODE_ENV: "production",
  TZ: "UTC",
  HOST: "127.0.0.1",
  PORT: port,
  DATABASE_URL: databaseUrl,
  APP_URL: `http://127.0.0.1:${port}`,
  GOOGLE_CLIENT_ID: googleClientId,
  GOOGLE_CLIENT_SECRET: "e2e-not-a-secret",
  ALLOWED_EMAILS: allowedEmails,
  INBOX_TOKEN_KEY: randomBytes(32).toString("hex"),
  MAIL_SOURCE: "fixture",
  INBOX_SCHEDULER: "off",
};
for (const name of Object.keys(env)) if (name.startsWith("E2E_")) delete env[name];

const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", port], {
  cwd: ROOT,
  env,
  stdio: "inherit",
});

// Playwright stops this process when the run ends; take next-server with it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
