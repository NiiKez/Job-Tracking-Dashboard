import "server-only";
import { decodeIdToken, Google } from "arctic";
import { isSitePath, safeNextPath } from "@/lib/domain/safe-next";
import { isDemoSub } from "@/lib/server/demo/marker";
import { signInConfig } from "@/lib/server/env";
import type { SignInProfile } from "@/lib/server/repo/users";
import type { OAuthStateCookie } from "./oauth-state";

/**
 * Google OpenID Connect for sign-in (Arctic 3.7: authorization URL with state and PKCE S256,
 * code exchange).
 *
 *   googleClient(redirectPath)             an Arctic Google client whose redirect URI is
 *                                          APP_URL + redirectPath (area 2 uses "/api/inbox/callback")
 *   signInAuthorizationUrl(state, verifier)  Google's consent URL for sign-in
 *   exchangeSignInCode(code, verifier)     code → validated profile (ClaimsCheck)
 *   validateIdTokenClaims(claims, opts)    the ID token checks, pure
 *   loginPath(error?, next?)               "/login?error=…&next=…"
 *
 * Sign-in asks for `openid email profile` only, never offline access, and keeps none of Google's
 * tokens: the profile is read from the ID token and the tokens are dropped.
 */

export const SIGN_IN_REDIRECT_PATH = "/auth/google/callback";
export const SIGN_IN_SCOPES = ["openid", "email", "profile"] as const;
/** The sign-in flow's state cookie (Path=/, `__Host-` under https: see oauth-state.ts). */
export const SIGN_IN_STATE_COOKIE: OAuthStateCookie = { name: "jt_oauth" };

/** Google's token endpoint answers within a few seconds; a hanging exchange fails the sign-in. */
const EXCHANGE_TIMEOUT_MS = 10_000;
/** Clock skew allowed on `exp`. */
const EXP_SKEW_SECONDS = 60;
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/**
 * An Arctic Google client for this app, with redirect URI APP_URL + redirectPath.
 * Throws when sign-in is locked (no Google client, allowlist or APP_URL): check signInConfig() first.
 * Throws unless redirectPath is a path on this site (isSitePath: one leading "/", no "\", no
 * control characters) that stays on APP_URL's origin.
 */
export function googleClient(redirectPath: string): Google {
  const config = signInConfig();
  if (!config) throw new Error("Google sign-in is not configured");
  const redirectUri = isSitePath(redirectPath) ? new URL(redirectPath, config.appUrl) : null;
  if (!redirectUri || redirectUri.origin !== config.appUrl.origin) {
    throw new Error("googleClient: redirectPath must be a path on this site");
  }
  return new Google(config.clientId, config.clientSecret, redirectUri.href);
}

/** Google's authorization URL for sign-in: openid email profile, account chooser, PKCE S256. */
export function signInAuthorizationUrl(state: string, codeVerifier: string): URL {
  const url = googleClient(SIGN_IN_REDIRECT_PATH).createAuthorizationURL(state, codeVerifier, [...SIGN_IN_SCOPES]);
  url.searchParams.set("prompt", "select_account");
  // Arctic adds no access_type; Google's default is "online" (no refresh token). Say so anyway.
  url.searchParams.set("access_type", "online");
  return url;
}

/**
 * Exchanges the authorization code (with the PKCE verifier) at Google's token endpoint and checks
 * the ID token's claims. Throws on a network, timeout or OAuth error (the caller fails the
 * sign-in); a token with bad claims comes back as { ok: false }.
 *
 * The ID token's signature is not verified: it comes straight from Google's token endpoint over
 * TLS in this server's own request, which Google's OpenID Connect documentation accepts in place
 * of a signature check ("Obtain user information from the ID token"). docs/plan/1-backend-core.md
 * notes it under "Risks". The access token is never used and nothing is stored.
 */
export async function exchangeSignInCode(code: string, codeVerifier: string): Promise<ClaimsCheck> {
  const config = signInConfig();
  if (!config) throw new Error("Google sign-in is not configured");
  const client = googleClient(SIGN_IN_REDIRECT_PATH);
  const tokens = await withTimeout(client.validateAuthorizationCode(code, codeVerifier), EXCHANGE_TIMEOUT_MS);
  const claims = decodeIdToken(tokens.idToken());
  return validateIdTokenClaims(claims, { clientId: config.clientId, now: new Date() });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Google's token endpoint did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ---------------------------------------------------------------- claims */

export type ClaimsProblem =
  | "malformed"
  | "issuer"
  | "audience"
  | "expired"
  | "subject"
  | "email"
  | "email_unverified";

export type ClaimsCheck = { ok: true; profile: SignInProfile } | { ok: false; problem: ClaimsProblem };

/**
 * The ID token checks from Google's OpenID Connect documentation:
 * - `iss` is https://accounts.google.com or accounts.google.com
 * - `aud` is the client id; a list of audiences must contain it, and then `azp` must be present.
 *   A present `azp` must be the client id.
 * - `exp` is in the future (60 s of clock skew allowed)
 * - `sub` is a non-empty string (at most 255 characters, as users.google_sub allows) that does not
 *   start with the public demo's marker "demo:" (src/lib/server/demo/marker.ts). Google's never
 *   does; refusing it means sign-in can neither reach a demo user's row nor create one
 * - `email` is a string and `email_verified` is the boolean true (not "true")
 * The profile carries the email lower-cased and trimmed, `name` ("" when absent, at most 200
 * characters) and `picture` (only an https URL, else null).
 */
export function validateIdTokenClaims(claims: unknown, opts: { clientId: string; now: Date }): ClaimsCheck {
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    return { ok: false, problem: "malformed" };
  }
  const c = claims as Record<string, unknown>;

  if (typeof c.iss !== "string" || !GOOGLE_ISSUERS.has(c.iss)) return { ok: false, problem: "issuer" };

  if (typeof c.aud === "string") {
    if (c.aud !== opts.clientId) return { ok: false, problem: "audience" };
  } else if (Array.isArray(c.aud)) {
    if (!c.aud.includes(opts.clientId) || c.azp === undefined) return { ok: false, problem: "audience" };
  } else {
    return { ok: false, problem: "audience" };
  }
  if (c.azp !== undefined && c.azp !== opts.clientId) return { ok: false, problem: "audience" };

  const nowSeconds = Math.floor(opts.now.getTime() / 1000);
  if (typeof c.exp !== "number" || !Number.isFinite(c.exp) || c.exp + EXP_SKEW_SECONDS <= nowSeconds) {
    return { ok: false, problem: "expired" };
  }

  if (typeof c.sub !== "string" || c.sub.trim() === "" || c.sub.length > 255 || isDemoSub(c.sub)) {
    return { ok: false, problem: "subject" };
  }

  if (typeof c.email !== "string") return { ok: false, problem: "email" };
  const email = c.email.trim().toLowerCase();
  if (email === "" || email.length > 320 || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    return { ok: false, problem: "email" };
  }
  if (c.email_verified !== true) return { ok: false, problem: "email_unverified" };

  const name = typeof c.name === "string" ? c.name.trim().slice(0, 200) : "";
  return { ok: true, profile: { sub: c.sub, email, name, picture: httpsUrl(c.picture) } };
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- redirects */

export type LoginError = "not_allowed" | "not_configured" | "failed";

/** "/login", with ?error= and ?next= (dropped unless safeNextPath keeps it), as the login page reads them. */
export function loginPath(error?: LoginError, next?: string | null): string {
  const params = new URLSearchParams();
  if (error) params.set("error", error);
  const safeNext = safeNextPath(next);
  if (safeNext) params.set("next", safeNext);
  const qs = params.toString();
  return qs ? `/login?${qs}` : "/login";
}
