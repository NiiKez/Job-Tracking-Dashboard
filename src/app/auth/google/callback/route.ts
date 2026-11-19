import { connection, type NextRequest } from "next/server";
import { isAllowed } from "@/lib/server/auth/allowlist";
import { exchangeSignInCode, type LoginError, loginPath, SIGN_IN_STATE_COOKIE } from "@/lib/server/auth/google";
import { redirectTo } from "@/lib/server/auth/guard";
import { finishOAuthState } from "@/lib/server/auth/oauth-state";
import { createSession, hashSessionToken, readSessionToken } from "@/lib/server/auth/session";
import { withTx } from "@/lib/server/db/client";
import { getEnv, signInConfig } from "@/lib/server/env";
import { deleteExpiredSessions, deleteSessionByTokenHash } from "@/lib/server/repo/sessions";
import { upsertUserOnSignIn } from "@/lib/server/repo/users";

/** Authorization codes are a few hundred characters; anything far longer is not one. */
const MAX_CODE_LENGTH = 4096;

/**
 * Google's redirect back after sign-in (docs/plan/1-backend-core.md, "Flow"):
 * state compared in constant time → code exchanged with the PKCE verifier → ID token claims
 * checked → email on ALLOWED_EMAILS → in one transaction: user upserted by google_sub (first
 * sign-in: settings and default rules too), the user's expired sessions removed, a new session
 * created → 303 to the saved `next` or "/".
 *
 * Every failure goes to /login?error=failed (or not_allowed / not_configured), keeping `next`.
 * An account that is not allowed creates no user and no session. The state cookie is cleared on
 * every outcome. Logged lines name the step that failed, never codes, tokens or addresses.
 *
 * The public demo (DEMO_MODE=on) starts no Google sign-in, so nothing can come back here: 303 to
 * /login, before the state cookie or the query is read, and no Set-Cookie at all.
 */
export async function GET(req: NextRequest) {
  await connection();
  if (getEnv().demoMode) return redirectTo(loginPath());
  const params = req.nextUrl.searchParams;
  const flow = finishOAuthState(req, SIGN_IN_STATE_COOKIE, params.get("state"));
  const fail = (error: LoginError, reason: string) => {
    if (error !== "not_configured") console.warn(`auth: sign-in refused (${reason})`);
    return redirectTo(loginPath(error, flow.next), [flow.clearCookie]);
  };

  const config = signInConfig();
  if (!config) return fail("not_configured", "sign-in is locked");
  // Google reports a cancelled or refused consent as ?error=access_denied (etc.) without a code.
  if (params.has("error")) return fail("failed", "Google returned an error");
  if (!flow.ok) return fail("failed", `state ${flow.problem}`);
  const code = params.get("code");
  if (!code || code.length > MAX_CODE_LENGTH) return fail("failed", "missing code");

  let claims: Awaited<ReturnType<typeof exchangeSignInCode>>;
  try {
    claims = await exchangeSignInCode(code, flow.codeVerifier);
  } catch (err) {
    // Arctic's OAuth2RequestError carries Google's error code (e.g. invalid_grant), never a secret.
    const detail = (err as { code?: unknown })?.code ?? (err instanceof Error ? err.name : "unknown");
    return fail("failed", `code exchange failed: ${String(detail).slice(0, 80)}`);
  }
  if (!claims.ok) return fail("failed", `ID token ${claims.problem}`);
  if (!isAllowed(claims.profile.email)) return fail("not_allowed", "not on ALLOWED_EMAILS");

  const previous = readSessionToken(req);
  const previousHash = previous ? hashSessionToken(previous) : null;
  let setCookie: string;
  try {
    ({ setCookie } = await withTx(async (tx) => {
      const { user } = await upsertUserOnSignIn(tx, claims.profile);
      await deleteExpiredSessions(tx, user.id);
      // A new sign-in replaces whatever session this browser had.
      if (previousHash) await deleteSessionByTokenHash(tx, previousHash);
      return createSession(tx, user.id);
    }));
  } catch (err) {
    const detail = err instanceof Error ? err.name : "unknown";
    if (detail !== "ConflictError") console.error(err);
    return fail("failed", `could not save the sign-in: ${detail}`);
  }

  return redirectTo(flow.next ?? "/", [flow.clearCookie, setCookie]);
}
