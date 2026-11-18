// Environment helpers for the auth tests (unit, database and handler). Invented values only.
import { vi } from "vitest";
import { resetEnvForTests } from "@/lib/server/env";

export const APP_ORIGIN = "https://jobs.example.com";
export const CLIENT_ID = "1234-test.apps.googleusercontent.com";
export const OWNER_EMAIL = "owner@example.com";

/** Sign-in fully configured over https. */
export const SIGNED_IN_ENV = {
  APP_URL: APP_ORIGIN,
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: "test-secret-not-real",
  ALLOWED_EMAILS: OWNER_EMAIL,
} as const;

type SignInVar = keyof typeof SIGNED_IN_ENV;

/**
 * Sets the sign-in variables (unlisted ones are blanked, i.e. missing) and forgets the memoized
 * environment. DEMO_MODE is blanked too, so a test can go from demoEnv() back to Google sign-in.
 * Undo with restoreEnv() in afterEach.
 */
export function setEnv(values: Partial<Record<SignInVar, string>>): void {
  for (const name of Object.keys(SIGNED_IN_ENV) as SignInVar[]) vi.stubEnv(name, values[name] ?? "");
  vi.stubEnv("DEMO_MODE", "");
  resetEnvForTests();
}

/** setEnv(SIGNED_IN_ENV) with some values replaced (pass "" to remove one). */
export function signedInEnv(overrides: Partial<Record<SignInVar, string>> = {}): void {
  setEnv({ ...SIGNED_IN_ENV, ...overrides });
}

/** The variables a demo must not have besides the Google ones (env.ts, NOT_IN_DEMO), and the two it defaults. */
const NOT_IN_DEMO = [
  "INBOX_TOKEN_KEY",
  "INBOX_TOKEN_KEY_PREVIOUS",
  "ALLOW_PARTIAL_SETUP",
  "DEMO_URL",
  "MAIL_SOURCE",
  "INBOX_SCHEDULER",
] as const;

/**
 * The public demo over https (DEMO_MODE=on): APP_URL is APP_ORIGIN, so request() and the
 * __Host- session cookie work as in Google mode; every Google value and the rest of NOT_IN_DEMO
 * are blanked (MAIL_SOURCE defaults to fixture). DATABASE_URL stays as vitest.config.mts leaves
 * it, blank, so the demo's database-name rule has nothing to check; database tests use the test
 * client anyway. Undo with restoreEnv().
 */
export function demoEnv(): void {
  setEnv({ APP_URL: APP_ORIGIN });
  for (const name of NOT_IN_DEMO) vi.stubEnv(name, "");
  vi.stubEnv("DEMO_MODE", "on");
  resetEnvForTests();
}

export function restoreEnv(): void {
  vi.unstubAllEnvs();
  resetEnvForTests();
}
