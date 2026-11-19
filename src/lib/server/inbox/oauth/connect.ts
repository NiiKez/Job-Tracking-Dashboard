import "server-only";
import { decodeIdToken, OAuth2RequestError, type Google, type OAuth2Tokens } from "arctic";
import type { NextRequest } from "next/server";
import { googleClient, loginPath, validateIdTokenClaims } from "@/lib/server/auth/google";
import { authenticate, redirectTo, type AuthUser } from "@/lib/server/auth/guard";
import { finishOAuthState, startOAuthState, type OAuthStateCookie } from "@/lib/server/auth/oauth-state";
import { clearedSessionCookie } from "@/lib/server/auth/session";
import { getDb, type Db } from "@/lib/server/db/client";
import { getEnv, inboxTokenKeys, signInConfig } from "@/lib/server/env";
import { isErrorNamed } from "@/lib/server/errors";
import {
  clearConnection,
  hasLiveConnection,
  normalizeMailbox,
  normalizeScopes,
  saveConnection,
} from "@/lib/server/inbox/connection";
import { ensureDemoConnection } from "@/lib/server/inbox/repo";
import { createGmailSource } from "@/lib/server/inbox/source/gmail-source";
import type { FetchLike } from "@/lib/server/inbox/source/gmail-client";
import { abortSync } from "@/lib/server/inbox/sync/engine";
import { isMailSourceError } from "@/lib/server/inbox/sync/errors";
import { createPacer } from "@/lib/server/inbox/sync/pace";
import { decryptToken, TokenCryptoError } from "./token-crypto";
import {
  fixedAccessToken,
  GMAIL_READONLY_SCOPE,
  INBOX_REDIRECT_PATH,
  revokeToken,
  TOKEN_TIMEOUT_MS,
  type TokenClient,
} from "./google-tokens";

/**
 * Connecting Gmail (docs/plan/2-gmail-ingest.md, "Connecting"): the flows behind
 * GET /api/inbox/connect, GET /api/inbox/callback and POST /api/inbox/disconnect.
 *
 *   handleConnectStart(req)       → 303 to Google's consent screen (or straight to Settings)
 *   handleConnectCallback(req)    → 303 to /settings?inbox=connected or ?inbox=error&reason=…
 *   disconnectInbox(userId)       stops the sync, deletes the token, asks Google to revoke it;
 *                                 answers { revoked } (false: Google did not confirm)
 *   connectAuthorizationUrl(state, verifier, loginHint)
 *   isOwnNavigation(req)          Sec-Fetch-Site is same-origin or none (demo mode's connect)
 *   verifyGrant(code, verifier, user)   callback steps 2 to 5, without storing anything
 *   settingsPath(result)          "/settings?inbox=…"
 *   CONNECT_ERROR_REASONS         every `reason` Settings may receive
 *
 * The callback, in the plan's order (the account is checked before the rest of the token answer):
 * 1. a signed-in session (else /login?next=/settings), the state matches the cookie, Google's
 *    `error` parameter is handled;
 * 2. the code is exchanged with the PKCE verifier, within TOKEN_TIMEOUT_MS;
 * 3. the ID token's `sub` must be the signed-in user's Google `sub`. If not, the connect fails
 *    with account_mismatch, whatever else is wrong with the answer, and the grant just made is
 *    revoked (best effort): the refresh token if the answer has one, else the access token
 *    (revoking either ends the grant). So another account's grant is never left behind because
 *    its Gmail box was unticked or a token was missing. It is not revoked when another user of
 *    this app has that account connected, as revoking ends the whole grant and so that user's
 *    connection too. An answer without a readable ID token names no account: exchange_failed,
 *    nothing revoked (it could be the signed-in user's own live grant);
 * 4. the answer must carry a refresh token and list gmail.readonly in its scopes (the user can
 *    untick it on the consent screen), and the rest of the ID token must pass Google's checks;
 * 5. users.getProfile with the new access token: the mailbox address, and proof that the Gmail
 *    API is enabled (403 accessNotConfigured → gmail_api_disabled). The address is not compared
 *    with the signed-in email: the `sub` check already proves it is the same Google account, and
 *    the email saved at sign-in can be older than the account's address. Its history id is not
 *    stored: the first scan reads its own before listing (sync/engine.ts), and a reconnect keeps
 *    the old position, so mail that arrived while disconnected is still synced;
 * 6. the refresh token is encrypted and stored, a sync is requested (next_sync_at = now()), and
 *    the browser goes to /settings?inbox=connected.
 *
 * Never revokes an old token after storing a new one: revocation applies to the whole grant and
 * would end the new token as well. The access token is used once (step 5) and never stored.
 * Logged lines name the step and Google's error code, never a code, token, `sub` or address.
 *
 * Demo mode (MAIL_SOURCE=fixture): connect creates the demo connection (ensureDemoConnection)
 * without Google, but only for a click on this site or a typed address (Sec-Fetch-Site), since
 * a GET that changes state could otherwise be triggered by any other site. A user whose inbox is
 * a Gmail connection (connected or not) keeps it as it is, and Settings says why (demo_gmail).
 * The callback refuses (no flow was started); disconnect works as usual.
 */

/** The connect flow's state cookie, separate from sign-in's (Path=/, `__Host-` under https: see oauth-state.ts). */
export const INBOX_STATE_COOKIE: OAuthStateCookie = { name: "jt_inbox_oauth" };

/** What the connect flow asks for. `email` makes login_hint and the ID token's email work. */
export const INBOX_SCOPES = ["openid", "email", GMAIL_READONLY_SCOPE] as const;

/** Where every flow ends: the Settings page reads ?inbox= and ?reason=. */
export const SETTINGS_PATH = "/settings";

/**
 * Every reason a failed connect reports, as /settings?inbox=error&reason=<reason>:
 *   denied              the user cancelled on Google's screen (or an admin policy refused)
 *   scope_missing       the Gmail permission was not ticked
 *   account_mismatch    a Google account other than the signed-in one was chosen (reported before
 *                       scope_missing and a missing token, for that account)
 *   gmail_api_disabled  the Gmail API is not enabled in the Google Cloud project
 *   state               the request expired, was already used, or came from another tab
 *   exchange_failed     Google refused the code, or its answer could not be used or checked
 *   not_configured      no INBOX_TOKEN_KEY, or Google sign-in is not configured
 *   demo_gmail          demo mode, and the user's inbox is a Gmail connection: it stays as it is
 */
export const CONNECT_ERROR_REASONS = [
  "denied",
  "scope_missing",
  "account_mismatch",
  "gmail_api_disabled",
  "state",
  "exchange_failed",
  "not_configured",
  "demo_gmail",
] as const;

export type ConnectErrorReason = (typeof CONNECT_ERROR_REASONS)[number];

/** Authorization codes are a few hundred characters; anything far longer is not one. */
const MAX_CODE_LENGTH = 4096;
/** Google's `error` values on the redirect that mean "the user (or their admin) said no". */
const DENIED_ERRORS = new Set(["access_denied", "admin_policy_enforced"]);

/* ------------------------------------------------------------- the paths */

/** "/settings?inbox=connected", or "/settings?inbox=error&reason=…". */
export function settingsPath(result: { ok: true } | { ok: false; reason: ConnectErrorReason }): string {
  if (result.ok) return `${SETTINGS_PATH}?inbox=connected`;
  return `${SETTINGS_PATH}?inbox=error&reason=${result.reason}`;
}

/** Where a signed-out browser goes: sign in, then back to Settings. */
const LOGIN_PATH = () => loginPath(undefined, SETTINGS_PATH);

/** Gmail can be connected: Google sign-in is configured and INBOX_TOKEN_KEY is set. */
export function gmailConnectConfigured(): boolean {
  return signInConfig() !== null && inboxTokenKeys() !== null;
}

/**
 * Google's consent URL for the Gmail connection: openid, email and gmail.readonly, PKCE S256,
 * offline access with prompt=consent (the only way to get a new refresh token every time),
 * include_granted_scopes, and login_hint with the signed-in address so Google offers that
 * account. The redirect URI is APP_URL + /api/inbox/callback.
 */
export function connectAuthorizationUrl(state: string, codeVerifier: string, loginHint: string): URL {
  const url = googleClient(INBOX_REDIRECT_PATH).createAuthorizationURL(state, codeVerifier, [...INBOX_SCOPES]);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  if (loginHint) url.searchParams.set("login_hint", loginHint);
  return url;
}

/* --------------------------------------------------------- the handlers */

/**
 * A navigation the user started on this site (a click in Settings: same-origin) or by typing the
 * address (none). Browsers send Sec-Fetch-Site on every request to an https or localhost origin;
 * without it, or from another site (cross-site, same-site), the answer is no.
 */
export function isOwnNavigation(req: Pick<NextRequest, "headers">): boolean {
  const site = req.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
}

/**
 * GET /api/inbox/connect. Signed out → /login?next=/settings. Demo mode → the demo connection,
 * then /settings?inbox=connected (or ?inbox=error&reason=demo_gmail when the user's inbox is a
 * Gmail connection, which stays as it is); but a navigation from another site (isOwnNavigation
 * false) only goes to /settings, connecting nothing: the session cookie is SameSite=Lax, so it
 * comes along on another site's link, and without a Google round trip no state proves the click.
 * Not configured → /settings?inbox=error&reason=not_configured. Otherwise a 303 to Google, with
 * the state cookie (10 minutes).
 */
export async function handleConnectStart(req: NextRequest): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return redirectTo(LOGIN_PATH(), auth.clearCookie ? [clearedSessionCookie()] : []);
  const cookies = auth.setCookie ? [auth.setCookie] : [];

  if (getEnv().mailSource === "fixture") {
    if (!isOwnNavigation(req)) return redirectTo(SETTINGS_PATH, cookies);
    try {
      await ensureDemoConnection(getDb(), auth.user.id);
    } catch (err) {
      // A navigation, not route(): the refusal becomes a redirect Settings can explain.
      if (isErrorNamed(err, "ConflictError")) return redirectTo(settingsPath({ ok: false, reason: "demo_gmail" }), cookies);
      throw err;
    }
    return redirectTo(settingsPath({ ok: true }), cookies);
  }
  if (!gmailConnectConfigured()) return redirectTo(settingsPath({ ok: false, reason: "not_configured" }), cookies);

  const flow = startOAuthState(INBOX_STATE_COOKIE, null);
  const url = connectAuthorizationUrl(flow.state, flow.codeVerifier, auth.user.email);
  const headers = new Headers({ Location: url.href, "Cache-Control": "no-store" });
  for (const cookie of [flow.setCookie, ...cookies]) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export interface ConnectDeps {
  /** Google's token endpoints. Default: googleClient(INBOX_REDIRECT_PATH), built when called. */
  client?: Pick<Google, "validateAuthorizationCode"> & TokenClient;
  /** Gmail requests (users.getProfile). Default: the global fetch. */
  fetch?: FetchLike;
  /** Per call to Google. Default TOKEN_TIMEOUT_MS. */
  timeoutMs?: number;
  db?: Db;
}

/**
 * GET /api/inbox/callback: the steps in the header, in that order. The state cookie is cleared
 * on every outcome; every failure is a 303 to /settings?inbox=error&reason=….
 */
export async function handleConnectCallback(req: NextRequest, deps: ConnectDeps = {}): Promise<Response> {
  const params = req.nextUrl.searchParams;
  const flow = finishOAuthState(req, INBOX_STATE_COOKIE, params.get("state"));

  // 1. Session, state, Google's error.
  const auth = await authenticate(req);
  if (!auth.ok) {
    return redirectTo(LOGIN_PATH(), [flow.clearCookie, ...(auth.clearCookie ? [clearedSessionCookie()] : [])]);
  }
  const cookies = [flow.clearCookie, ...(auth.setCookie ? [auth.setCookie] : [])];
  const fail = (reason: ConnectErrorReason, detail: string) => {
    if (reason !== "denied" && reason !== "not_configured") console.warn(`inbox: connect refused (${reason}: ${detail})`);
    return redirectTo(settingsPath({ ok: false, reason }), cookies);
  };

  // Demo mode starts no Google flow, so a callback here was not started by this server's mode.
  if (getEnv().mailSource === "fixture") return fail("state", "demo mode starts no Google flow");
  if (!gmailConnectConfigured()) return fail("not_configured", "Gmail is not set up");
  if (!flow.ok) return fail("state", `state ${flow.problem}`);
  const error = params.get("error");
  if (error !== null) {
    if (DENIED_ERRORS.has(error)) return fail("denied", error);
    // The value comes from the URL: logged only when it looks like one of Google's codes.
    return fail("exchange_failed", `Google returned ${/^[a-z_]{1,40}$/.test(error) ? error : "an unknown error"}`);
  }
  const code = params.get("code");
  if (!code || code.length > MAX_CODE_LENGTH) return fail("exchange_failed", "missing code");

  // 2 to 5.
  const user = auth.user;
  const db = deps.db ?? getDb();
  const verified = await verifyGrant(code, flow.codeVerifier, user, {
    ...deps,
    revokeUnless: (sub) => hasLiveConnection(db, sub, user.id),
  });
  if (!verified.ok) return fail(verified.reason, verified.detail);

  // 6. Store, request a sync, back to Settings.
  try {
    await saveConnection(db, user.id, verified.grant);
  } catch (err) {
    if (err instanceof TokenCryptoError) return fail("not_configured", `token key ${err.problem}`);
    console.error(`inbox: storing the connection failed (${err instanceof Error ? err.name : "unknown"})`);
    return fail("exchange_failed", "could not store the connection");
  }
  return redirectTo(settingsPath({ ok: true }), cookies);
}

/* ------------------------------------------------------- steps 2 to 5 */

export interface VerifiedGrant {
  googleSub: string;
  emailAddress: string;
  refreshToken: string;
  grantedScopes: string[];
}

export type VerifyResult =
  | { ok: true; grant: VerifiedGrant }
  | { ok: false; reason: ConnectErrorReason; /** for the log: a step and Google's error code only */ detail: string };

export interface VerifyDeps extends Omit<ConnectDeps, "db"> {
  /**
   * Account mismatch: true keeps the refused token unrevoked (another user's connection holds
   * that Google account). Default: always revoke.
   */
  revokeUnless?: (googleSub: string) => Promise<boolean>;
}

/**
 * Callback steps 2 to 5: exchange the code, check the account, require a refresh token and
 * gmail.readonly, read the mailbox profile. Stores nothing. On an account mismatch the grant
 * just made is revoked (best effort) before the answer, whatever else the answer lacks.
 */
export async function verifyGrant(
  code: string,
  codeVerifier: string,
  user: Pick<AuthUser, "googleSub">,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  const config = signInConfig();
  if (!config) return { ok: false, reason: "not_configured", detail: "Google sign-in is not configured" };
  const client = deps.client ?? googleClient(INBOX_REDIRECT_PATH);
  const timeoutMs = deps.timeoutMs ?? TOKEN_TIMEOUT_MS;

  // 2. Exchange.
  let tokens: OAuth2Tokens;
  try {
    tokens = await withTimeout(client.validateAuthorizationCode(code, codeVerifier), timeoutMs);
  } catch (err) {
    // Arctic's OAuth2RequestError carries Google's error code (e.g. invalid_grant), never a secret.
    const detail = err instanceof OAuth2RequestError ? err.code : err instanceof Error ? err.name : "unknown";
    return { ok: false, reason: "exchange_failed", detail: `code exchange failed: ${String(detail).slice(0, 80)}` };
  }
  const fields = readTokens(tokens);

  // 3. The signed-in account. The answer came straight from Google's token endpoint, so
  // its `sub` names the account that consented even before the other claims are checked.
  let claims: unknown;
  try {
    claims = decodeIdToken(tokens.idToken());
  } catch {
    return { ok: false, reason: "exchange_failed", detail: "no readable ID token" };
  }
  const sub = subjectOf(claims);
  if (sub === null) return { ok: false, reason: "exchange_failed", detail: "ID token subject" };
  if (sub !== user.googleSub) {
    return { ok: false, reason: "account_mismatch", detail: await revokeRefused(sub, fields, deps, { client, timeoutMs }) };
  }
  const checked = validateIdTokenClaims(claims, { clientId: config.clientId, now: new Date() });
  if (!checked.ok) return { ok: false, reason: "exchange_failed", detail: `ID token ${checked.problem}` };

  // 4. A refresh token, and gmail.readonly among the granted scopes.
  const { accessToken, refreshToken, scopes } = fields;
  if (accessToken === null || refreshToken === null) {
    return { ok: false, reason: "exchange_failed", detail: "token answer without access or refresh token" };
  }
  if (!scopes.includes(GMAIL_READONLY_SCOPE)) {
    return { ok: false, reason: "scope_missing", detail: "gmail.readonly not granted" };
  }

  // 5. The mailbox profile: proves the Gmail API answers for this token.
  let emailAddress: string | null;
  try {
    const source = createGmailSource({
      accessTokens: fixedAccessToken(accessToken),
      // One attempt: the user is waiting on this redirect. A failure is reported, not retried.
      pacer: createPacer({ maxAttempts: 1 }),
      fetch: deps.fetch,
      timeoutMs,
    });
    emailAddress = normalizeMailbox((await source.getProfile()).emailAddress);
  } catch (err) {
    if (isMailSourceError(err) && err.code === "gmail_api_disabled") {
      return { ok: false, reason: "gmail_api_disabled", detail: "users.getProfile: Gmail API not enabled" };
    }
    if (isMailSourceError(err) && err.code === "scope_missing") {
      return { ok: false, reason: "scope_missing", detail: "users.getProfile: insufficient scope" };
    }
    const detail = isMailSourceError(err) ? err.code : err instanceof Error ? err.name : "unknown";
    return { ok: false, reason: "exchange_failed", detail: `users.getProfile failed: ${detail}` };
  }
  if (!emailAddress) return { ok: false, reason: "exchange_failed", detail: "users.getProfile: no usable address" };

  return { ok: true, grant: { googleSub: sub, emailAddress, refreshToken, grantedScopes: scopes } };
}

/**
 * Account mismatch: revokes the grant another Google account just made, with the refresh token
 * if the answer has one, else the access token (revoking either ends the grant). Not when
 * `revokeUnless` says another user of this app holds that account (a failing check counts as
 * held). Answers the log detail.
 */
async function revokeRefused(
  sub: string,
  fields: TokenFields,
  deps: Pick<VerifyDeps, "revokeUnless">,
  opts: { client: TokenClient; timeoutMs: number },
): Promise<string> {
  const token = fields.refreshToken ?? fields.accessToken;
  if (token === null) return "another account, no token to revoke";
  const keep = deps.revokeUnless ? await deps.revokeUnless(sub).catch(() => true) : false;
  if (keep) return "another account, held by another user: not revoked";
  const revoked = await revokeToken(token, opts);
  return `another account, revoked${fields.refreshToken === null ? " (access token)" : ""}: ${revoked}`;
}

/** Bounds on a token from Google: anything else is not one. */
const MAX_TOKEN_LENGTH = 4_096;

/** The ID token's `sub` as validateIdTokenClaims accepts it (1 to 255 characters), or null. */
function subjectOf(claims: unknown): string | null {
  if (typeof claims !== "object" || claims === null) return null;
  const sub = (claims as Record<string, unknown>).sub;
  return typeof sub === "string" && sub.trim() !== "" && sub.length <= 255 ? sub : null;
}

interface TokenFields {
  /** null when missing or not shaped like a token. */
  accessToken: string | null;
  refreshToken: string | null;
  /** The granted scopes; empty when the answer has no `scope`. */
  scopes: string[];
}

/** The fields of the token answer this flow needs; a token that is missing or odd is null. */
function readTokens(tokens: OAuth2Tokens): TokenFields {
  const token = (v: unknown): string | null =>
    typeof v === "string" && v !== "" && v.length <= MAX_TOKEN_LENGTH && !/\s/.test(v) ? v : null;
  const data = tokens.data as Record<string, unknown>;
  // No `scope` in the answer: nothing proves gmail.readonly was granted.
  const scopes = typeof data.scope === "string" ? normalizeScopes([data.scope]) : [];
  return { accessToken: token(data.access_token), refreshToken: token(data.refresh_token), scopes };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Google's token endpoint did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ----------------------------------------------------------- disconnect */

export interface DisconnectDeps {
  /** Default: googleClient(INBOX_REDIRECT_PATH). */
  client?: TokenClient;
  timeoutMs?: number;
  db?: Db;
}

/**
 * POST /api/inbox/disconnect: stops a running sync, deletes the stored token and marks the
 * connection disconnected (one statement, before anything slow, so no new sync can start), then
 * asks Google to revoke the token: best effort, at most REVOKE_TIMEOUT_MS. Idempotent: without
 * a stored token (none, already disconnected, demo mode) nothing is revoked. Linked mail, the
 * ledger, the sync position and the connection record stay.
 *
 * Answers `revoked`, which the screen reports:
 *   true   Google confirmed the revocation, or no token was stored (nothing for the app to remove)
 *   false  a stored token was deleted, but Google did not confirm its revocation (no answer in
 *          time, an error, or a token that could not be decrypted to send): the grant may still
 *          be listed in the user's Google Account, and the screen points there
 */
export async function disconnectInbox(userId: string, deps: DisconnectDeps = {}): Promise<{ revoked: boolean }> {
  abortSync(userId);
  const stored = await clearConnection(deps.db ?? getDb(), userId);
  // Again: a run the scheduler started while the statement above was on its way still saw the
  // connection connected. Any run starting from now on finds it disconnected.
  abortSync(userId);
  if (stored === null) return { revoked: true };
  let token: string;
  try {
    ({ token } = decryptToken(stored, userId));
  } catch (err) {
    // Without the key the token cannot be revoked here; it is deleted all the same.
    const problem = err instanceof TokenCryptoError ? err.problem : "unknown";
    console.warn(`inbox: disconnect could not read the stored token to revoke it (${problem})`);
    return { revoked: false };
  }
  const revoked = await revokeToken(token, { client: deps.client, timeoutMs: deps.timeoutMs });
  if (!revoked) console.warn("inbox: disconnect could not confirm the revocation at Google");
  return { revoked };
}
