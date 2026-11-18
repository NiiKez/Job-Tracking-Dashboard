import { connection, type NextRequest } from "next/server";
import { loginPath, SIGN_IN_STATE_COOKIE, signInAuthorizationUrl } from "@/lib/server/auth/google";
import { startOAuthState } from "@/lib/server/auth/oauth-state";
import { signInConfig } from "@/lib/server/env";
import { redirectTo } from "@/lib/server/auth/guard";

/**
 * Starts Google sign-in: stores state, PKCE verifier and the sanitized ?next= in a cookie for
 * /auth (10 minutes) and sends the browser to Google's account chooser. While sign-in is locked it
 * goes back to /login?error=not_configured instead.
 */
export async function GET(req: NextRequest) {
  await connection();
  const next = req.nextUrl.searchParams.get("next");
  if (!signInConfig()) return redirectTo(loginPath("not_configured", next));

  const flow = startOAuthState(SIGN_IN_STATE_COOKIE, next);
  const url = signInAuthorizationUrl(flow.state, flow.codeVerifier);
  const headers = new Headers({ Location: url.href, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", flow.setCookie);
  return new Response(null, { status: 303, headers });
}
