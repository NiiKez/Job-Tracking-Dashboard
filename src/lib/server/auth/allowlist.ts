import "server-only";
import { type Env, getEnv, signInConfig } from "@/lib/server/env";

/**
 * Who may sign in with Google: the addresses in ALLOWED_EMAILS (already lower-cased by env.ts).
 * Checked at sign-in and again on every request (route() through mayUse() in access.ts), so
 * removing an address from the environment ends that account's sessions at its next request.
 */

/** Lower-cased and trimmed, as ALLOWED_EMAILS and users.email store it. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True when `email` is on the allowlist. Always false while sign-in is locked, and in the demo. */
export function isAllowed(email: string, env: Env = getEnv()): boolean {
  const config = signInConfig(env);
  if (!config) return false;
  return config.allowedEmails.has(normalizeEmail(email));
}
