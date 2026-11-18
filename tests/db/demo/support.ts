// Shared by the demo's database tests (workspaces, caps). Invented values only.
import { vi } from "vitest";
import { resetEnvForTests } from "@/lib/server/env";
import { testSql } from "../../helpers/test-db";

/**
 * Variables the demo refuses or decides itself (env.ts: NOT_IN_DEMO, MAIL_SOURCE and
 * INBOX_SCHEDULER), blanked whichever way a test goes, so the developer's shell or CI cannot
 * make parseEnv refuse DEMO_MODE=on.
 */
const BLANKED = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ALLOWED_EMAILS",
  "INBOX_TOKEN_KEY",
  "INBOX_TOKEN_KEY_PREVIOUS",
  "ALLOW_PARTIAL_SETUP",
  "DEMO_URL",
  "MAIL_SOURCE",
  "INBOX_SCHEDULER",
] as const;

/**
 * DEMO_MODE on or off, with everything else the demo refuses blanked. APP_URL is blank (http
 * cookies); DATABASE_URL stays as vitest.config.mts leaves it, blank, and the tests use the test
 * client. Undo with restoreDemoEnv() in afterEach.
 */
export function stubDemoMode(on: boolean): void {
  for (const name of BLANKED) vi.stubEnv(name, "");
  vi.stubEnv("APP_URL", "");
  vi.stubEnv("DEMO_MODE", on ? "on" : "");
  resetEnvForTests();
}

export function restoreDemoEnv(): void {
  vi.unstubAllEnvs();
  resetEnvForTests();
}

let seq = 0;

/**
 * Bare demo users (a users row only, google_sub with the marker), `minutesOld` before the
 * database's now(): cheap stand-ins for whole workspaces when a test needs hundreds of them.
 */
export async function insertBareDemoUsers(count: number, minutesOld = 0): Promise<string[]> {
  const base = ++seq;
  const rows = await testSql()<{ id: string }[]>`
    INSERT INTO users (google_sub, email, name, created_at)
    SELECT 'demo:bare-' || ${base}::int || '-' || i, 'bare' || ${base}::int || '-' || i || '@demo.invalid',
           'Alex Demo', now() - make_interval(mins => ${minutesOld}::int)
    FROM generate_series(1, ${count}::int) AS i
    RETURNING id`;
  return rows.map((r) => r.id);
}

/** Every user's id and google_sub, by id. */
export async function allUsers(): Promise<Map<string, string>> {
  const rows = await testSql()<{ id: string; google_sub: string }[]>`SELECT id, google_sub FROM users`;
  return new Map(rows.map((r) => [r.id, r.google_sub]));
}
