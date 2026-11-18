import "server-only";
import { signInConfig } from "@/lib/server/env";

/**
 * Who may sign in: the addresses in ALLOWED_EMAILS (already lower-cased by env.ts).
 * Checked at sign-in and again on every request by route(), so removing an address from the
 * environment ends that account's sessions at its next request.
 */

/** Lower-cased and trimmed, as ALLOWED_EMAILS and users.email store it. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True when `email` is on the allowlist. Always false while sign-in is locked. */
export function isAllowed(email: string): boolean {
  const config = signInConfig();
  if (!config) return false;
  return config.allowedEmails.has(normalizeEmail(email));
}
