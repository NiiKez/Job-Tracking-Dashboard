import { connection, type NextRequest } from "next/server";
import { isDemoUser } from "@/lib/server/auth/access";
import { loginPath } from "@/lib/server/auth/google";
import { redirectTo } from "@/lib/server/auth/guard";
import { clearedSessionCookie, endSession, lookupSession } from "@/lib/server/auth/session";
import { type Db, getDb } from "@/lib/server/db/client";
import { deleteWorkspace } from "@/lib/server/demo/workspaces";
import { appOrigin, getEnv } from "@/lib/server/env";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Sign-out: a form post from the account menu. Origin must be APP_URL's origin (browsers send it
 * on form posts), so another site cannot sign the user out. Deletes the session row, clears the
 * cookie and answers 303 to /login. No JSON requirement: it is a plain form post.
 *
 * In the public demo (DEMO_MODE=on) this is "Leave the demo": the visitor's whole workspace is
 * deleted at once, not only the session (see leaveWorkspace). /login then leads on to the demo's
 * entry page (the proxy).
 */
export async function POST(req: NextRequest) {
  await connection();
  const expected = appOrigin();
  if (!expected || req.headers.get("origin") !== expected) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
  }
  try {
    const db = getDb();
    if (getEnv().demoMode) await leaveWorkspace(db, req);
    else await endSession(db, req);
  } catch (err) {
    // The cookie is cleared below anyway; the row then only expires (in the demo, the workspace
    // with it: the scheduler's purge).
    console.error(err);
  }
  return redirectTo(loginPath(), [clearedSessionCookie()]);
}

/**
 * The demo's sign-out: deletes the workspace of the session the cookie names (its user, and with
 * the user every row of theirs, sessions included). A cookie that names no live session only has
 * its row deleted, if any, as outside the demo; so does a user that is not a demo user, whom
 * deleteWorkspace never deletes.
 */
async function leaveWorkspace(db: Db, req: NextRequest): Promise<void> {
  const found = await lookupSession(db, req);
  if (found.status === "valid" && isDemoUser(found.user) && (await deleteWorkspace(db, found.user.id))) return;
  await endSession(db, req);
}

/** Signing out changes state, so only POST does it. */
export async function GET() {
  await connection();
  return Response.json(
    { error: "Method not allowed" },
    { status: 405, headers: { ...NO_STORE, Allow: "POST" } },
  );
}
