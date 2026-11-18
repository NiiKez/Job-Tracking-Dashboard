import { connection, type NextRequest } from "next/server";
import { handleConnectCallback } from "@/lib/server/inbox/oauth/connect";

/**
 * Google's redirect back after the Gmail consent screen: a browser navigation, so not
 * route()-wrapped. It checks the session itself (authenticate()), then the state cookie and PKCE
 * verifier, and always answers a redirect: /settings?inbox=connected, /settings?inbox=error&
 * reason=…, or /login?next=/settings when signed out. The steps and their order are in
 * src/lib/server/inbox/oauth/connect.ts.
 */
export async function GET(req: NextRequest) {
  await connection();
  return handleConnectCallback(req);
}
