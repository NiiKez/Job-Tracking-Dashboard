import { connection, type NextRequest } from "next/server";
import { isDemoUser } from "@/lib/server/auth/access";
import { redirectTo } from "@/lib/server/auth/guard";
import { lookupSession } from "@/lib/server/auth/session";
import { type Db, getDb } from "@/lib/server/db/client";
import { runEntry } from "@/lib/server/demo/entry-gate";
import { createWorkspace } from "@/lib/server/demo/workspaces";
import { appOrigin, getEnv } from "@/lib/server/env";

const NO_STORE = { "Cache-Control": "no-store" };

/** The entry page (src/app/login/demo/page.tsx) and the ?error= codes it shows. */
const ENTRY_PAGE = "/login/demo";
// Not exported: a route file may export its methods only (Next checks the build's exports).
const ENTRY_BUSY = `${ENTRY_PAGE}?error=busy`;
const ENTRY_BUSY_KEPT = `${ENTRY_PAGE}?error=busy_kept`;
const ENTRY_FAILED = `${ENTRY_PAGE}?error=failed`;

/**
 * "Try the demo" (docs/plan/5-public-demo.md, "Step 6"): a plain HTML form post from the entry
 * page /login/demo, which works without JavaScript (and under a form-action 'self' policy).
 *
 * - Outside demo mode (DEMO_MODE is not on, or the environment is malformed): 404 with an empty
 *   body to every method (interlock 3). Requests through the proxy never get here then: it
 *   rewrites /auth/demo to a path without a route, so they get Next's own 404 page, exactly as an
 *   unknown path does (src/proxy.ts). This is the second layer.
 * - POST only; in demo mode the other methods answer 405 (Allow: POST).
 * - Origin must be APP_URL's origin (browsers send it on form posts), else 403: another site
 *   cannot make a visitor's browser start over and lose its workspace.
 * - The visitor's current session, if it is a live demo user's, names the workspace to replace
 *   ("Start over": deleted in the same transaction as the new one is made).
 * - The workspace is created through the entry gate (one at a time, at most 10 waiting, 30 a
 *   minute: entry-gate.ts). A refusal of the gate or a full demo (createWorkspace's "busy")
 *   → 303 to /login/demo?error=busy, and the visitor's workspace, if any, stays as it was. When
 *   there is one (a refused "Start over"), ?error=busy_kept instead: the entry page then says so
 *   and links back to it.
 * - Success → 303 to / with the new session's Set-Cookie (same name as the old one, so it takes
 *   its place). No other cookie is set or cleared.
 * - Anything else that fails (the database) → logged, 303 to /login/demo?error=failed.
 *
 * Every answer is no-store. Not route()-wrapped (tests/unit/routes-use-route.test.ts): it runs
 * before there is a session, answers a form post (no JSON) and redirects instead of a 401. The
 * proxy keeps /auth/* open; nginx limits it per address and answers its own limit with the same
 * 303 to /login/demo?error=busy (the server runbook).
 */
export async function POST(req: NextRequest): Promise<Response> {
  await connection();
  if (!demoMode()) return notFound();
  const expected = appOrigin();
  if (!expected || req.headers.get("origin") !== expected) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
  }
  try {
    const db = getDb();
    const replaceUserId = await currentDemoUserId(db, req);
    const result = await runEntry(() => createWorkspace(db, { replaceUserId }));
    if (result === "busy" || !result.ok) return redirectTo(replaceUserId ? ENTRY_BUSY_KEPT : ENTRY_BUSY);
    return redirectTo("/", [result.setCookie]);
  } catch (err) {
    // As route() logs a 500. The visitor's workspace, if any, stays: the transaction rolled back.
    console.error(err);
    return redirectTo(ENTRY_FAILED);
  }
}

/** Every other method: 404 outside the demo, 405 in it. HEAD runs GET (Next). */
async function otherMethod(): Promise<Response> {
  await connection();
  if (!demoMode()) return notFound();
  return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
}

export const GET = otherMethod;
export const PUT = otherMethod;
export const PATCH = otherMethod;
export const DELETE = otherMethod;
// Next would answer OPTIONS itself with the list of methods, which names this route.
export const OPTIONS = otherMethod;

/** DEMO_MODE is on; false for a malformed environment (which cannot start: instrumentation.ts). */
function demoMode(): boolean {
  try {
    return getEnv().demoMode;
  } catch {
    return false;
  }
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: NO_STORE });
}

/**
 * The demo user of the request's session, for "Start over"; null without a cookie, for an
 * unknown or expired session (its workspace is gone or about to be purged), and for a user that
 * is not a demo user (createWorkspace would leave one alone anyway).
 */
async function currentDemoUserId(db: Db, req: NextRequest): Promise<string | null> {
  const found = await lookupSession(db, req);
  return found.status === "valid" && isDemoUser(found.user) ? found.user.id : null;
}
