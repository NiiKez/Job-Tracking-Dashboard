/**
 * How the public demo marks its users (docs/plan/5-public-demo.md, "How a demo user is marked").
 * No column and no migration: a demo user's users.google_sub is "demo:" + a random UUID. Google's
 * `sub` is a string of digits, never of that shape, and sign-in refuses one that starts with the
 * prefix (validateIdTokenClaims), so a real account can never become a demo user or the other
 * way round.
 *
 * No "server-only" import: the values are not secret, and pure helpers stay usable anywhere.
 *
 *   DEMO_SUB_PREFIX                  "demo:"
 *   isDemoSub(googleSub)             true for a demo user's google_sub
 *   WORKSPACE_LIFETIME_SECONDS       24 hours from users.created_at, fixed (not extended by use)
 */

export const DEMO_SUB_PREFIX = "demo:";

/** A workspace lives this long from its user's created_at; its session ends with it. */
export const WORKSPACE_LIFETIME_SECONDS = 24 * 60 * 60;

/** True when `googleSub` is a demo user's marker. */
export function isDemoSub(googleSub: string): boolean {
  return googleSub.startsWith(DEMO_SUB_PREFIX);
}
