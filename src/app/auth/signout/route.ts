import { connection, type NextRequest } from "next/server";
import { loginPath } from "@/lib/server/auth/google";
import { redirectTo } from "@/lib/server/auth/guard";
import { clearedSessionCookie, endSession } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/client";
import { appOrigin } from "@/lib/server/env";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Sign-out: a form post from the account menu. Origin must be APP_URL's origin (browsers send it
 * on form posts), so another site cannot sign the user out. Deletes the session row, clears the
 * cookie and answers 303 to /login. No JSON requirement: it is a plain form post.
 */
export async function POST(req: NextRequest) {
  await connection();
  const expected = appOrigin();
  if (!expected || req.headers.get("origin") !== expected) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
  }
  try {
    await endSession(getDb(), req);
  } catch (err) {
    // The cookie is cleared below anyway; the row then only expires.
    console.error(err);
  }
  return redirectTo(loginPath(), [clearedSessionCookie()]);
}

/** Signing out changes state, so only POST does it. */
export async function GET() {
  await connection();
  return Response.json(
    { error: "Method not allowed" },
    { status: 405, headers: { ...NO_STORE, Allow: "POST" } },
  );
}
