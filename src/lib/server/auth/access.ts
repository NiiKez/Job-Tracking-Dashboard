import "server-only";
import { isDemoSub } from "@/lib/server/demo/marker";
import { type Env, getEnv, signInMode } from "@/lib/server/env";
import { isAllowed } from "./allowlist";

/**
 * Who may use this copy of the app, in each sign-in mode (docs/plan/5-public-demo.md, "Three
 * sign-in modes"). route() and authenticate() ask mayUse() on every request, after the session
 * lookup, so a user who may not use the app is signed out at once, whatever mode they signed in
 * under.
 *
 *   isDemoUser(user)          the user is a public demo's workspace (users.google_sub "demo:…")
 *   mayUse(user, env?)        google: on ALLOWED_EMAILS and not a demo user; demo: demo users
 *                             only; locked: nobody
 *   refuseInDemo(message, env?)
 *                             in demo mode a 403 { error: message } for a route() handler to
 *                             return (a part the demo switches off); null in the other modes
 *   EXTENSION_OFF_IN_DEMO     that message for the Chrome extension's cookie routes
 *
 * Why google mode refuses demo users even on the allowlist (interlock 4): the real app's database
 * never holds one, but if a demo user ever reached it (a restored dump, a mistaken DATABASE_URL),
 * a session nobody signed in with Google for must not open it. Demo addresses are under
 * demo.invalid, which nobody would put on ALLOWED_EMAILS; the check does not rely on that.
 */

/** True for a public demo's user: its google_sub carries the demo marker (src/lib/server/demo/marker.ts). */
export function isDemoUser(user: { googleSub: string }): boolean {
  return isDemoSub(user.googleSub);
}

/** True when `user` may use the app in the current sign-in mode (see the top of this file). */
export function mayUse(user: { email: string; googleSub: string }, env: Env = getEnv()): boolean {
  switch (signInMode(env)) {
    case "google":
      return !isDemoUser(user) && isAllowed(user.email, env);
    case "demo":
      return isDemoUser(user);
    case "locked":
      return false;
  }
}

/** What the extension's cookie routes answer in the demo (Settings and the connect page show it). */
export const EXTENSION_OFF_IN_DEMO = "The Chrome extension isn't available in the demo.";

/**
 * In demo mode, the answer for a route() handler that the demo switches off: 403 { error:
 * message } (route() adds no-store). Null in the other modes, where the handler goes on:
 *
 *   export const GET = route(({ user }) => refuseInDemo(EXTENSION_OFF_IN_DEMO) ?? overview(user.id));
 *
 * 403, not 409: the connect page reads a 409 from POST /api/extension/keys as "too many keys".
 */
export function refuseInDemo(message: string, env: Env = getEnv()): Response | null {
  return env.demoMode ? Response.json({ error: message }, { status: 403 }) : null;
}
