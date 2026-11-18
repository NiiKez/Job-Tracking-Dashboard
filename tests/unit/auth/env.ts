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
 * environment. Undo with restoreEnv() in afterEach.
 */
export function setEnv(values: Partial<Record<SignInVar, string>>): void {
  for (const name of Object.keys(SIGNED_IN_ENV) as SignInVar[]) vi.stubEnv(name, values[name] ?? "");
  resetEnvForTests();
}

/** setEnv(SIGNED_IN_ENV) with some values replaced (pass "" to remove one). */
export function signedInEnv(overrides: Partial<Record<SignInVar, string>> = {}): void {
  setEnv({ ...SIGNED_IN_ENV, ...overrides });
}

export function restoreEnv(): void {
  vi.unstubAllEnvs();
  resetEnvForTests();
}
