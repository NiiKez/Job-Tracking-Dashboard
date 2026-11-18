// Values the Playwright config, the test fixtures and the server launcher (serve.mjs, which gets
// them through its environment) must agree on. Plain Node: no app code, no "@/" imports.
//
//   E2E_PORT     the e2e server's port (default 3810; the dev server uses 3800)
//   E2E_SCHEMA   the schema of the test database the e2e server runs in (default "e2e"). It is
//                dropped and created again on every run, so two runs at once need two names.
//   TEST_DATABASE_URL  from the environment (CI) or .env.local, as for Vitest
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const ROOT = path.resolve(__dirname, "../../..");

export const E2E_PORT = Number(process.env.E2E_PORT || 3810);
if (!Number.isInteger(E2E_PORT) || E2E_PORT < 1024 || E2E_PORT > 65535) {
  throw new Error("E2E_PORT must be a port number from 1024 to 65535");
}

/** The app's origin in the tests: APP_URL of the e2e server, and Playwright's baseURL. */
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

export const E2E_SCHEMA = process.env.E2E_SCHEMA || "e2e";
// Interpolated into DROP SCHEMA / CREATE SCHEMA, and kept apart from Vitest's test_* schemas.
if (!/^e2e[a-z0-9_]{0,40}$/.test(E2E_SCHEMA)) {
  throw new Error('E2E_SCHEMA must start with "e2e" and hold only a-z, 0-9 and _');
}

/**
 * One account per Playwright worker (testInfo.parallelIndex), all on the server's ALLOWED_EMAILS.
 * More workers than accounts is an error in the fixture.
 */
export const MAX_ACCOUNTS = 16;

export function accountEmail(index: number): string {
  return `e2e-${index}@example.com`;
}

export const ALLOWED_EMAILS = Array.from({ length: MAX_ACCOUNTS }, (_, i) => accountEmail(i)).join(",");

/** The e2e server's invented Google client: sign-in tests find it in the redirect to Google. */
export const GOOGLE_CLIENT_ID = "e2e-invented-client-id.apps.googleusercontent.com";

/** The session cookie's name over http (src/lib/server/auth/session.ts SESSION_COOKIE_PLAIN). */
export const SESSION_COOKIE = "jt_session";

/** TEST_DATABASE_URL from the environment, else from .env.local. Throws when neither has it. */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const envFile = path.join(ROOT, ".env.local");
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  if (fromFile.TEST_DATABASE_URL) return fromFile.TEST_DATABASE_URL;
  throw new Error("The e2e tests need TEST_DATABASE_URL (in the environment or in .env.local).");
}

/** TEST_DATABASE_URL with search_path set to the e2e schema (postgres.js sends it at connect). */
export function e2eDatabaseUrl(): string {
  const url = new URL(testDatabaseUrl());
  url.searchParams.set("search_path", E2E_SCHEMA);
  return url.href;
}
