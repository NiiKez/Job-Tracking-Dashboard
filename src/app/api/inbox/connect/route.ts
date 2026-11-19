import { connection, type NextRequest } from "next/server";
import { handleConnectStart } from "@/lib/server/inbox/oauth/connect";

/**
 * "Connect Gmail" (and Reconnect): a browser navigation from Settings, so not route()-wrapped.
 * It checks the session itself (authenticate(): locked mode, session, allowlist) and answers a
 * redirect instead of a 401: signed out → /login?next=/settings. Signed in → 303 to Google's
 * consent screen with a short-lived state cookie (src/lib/server/inbox/oauth/connect.ts).
 * In demo mode it connects the demo inbox directly, so there it acts only on a navigation from
 * this site or a typed address (Sec-Fetch-Site); another site's link just lands on Settings.
 */
export async function GET(req: NextRequest) {
  await connection();
  return handleConnectStart(req);
}
