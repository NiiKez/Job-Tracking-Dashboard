import "server-only";
import {
  ArcticFetchError,
  OAuth2RequestError,
  UnexpectedErrorResponseBodyError,
  UnexpectedResponseError,
  type Google,
} from "arctic";
import { googleClient } from "@/lib/server/auth/google";
import type { AccessTokenProvider } from "@/lib/server/inbox/source/gmail-client";
import { inboxError, isMailSourceError, type MailSourceError } from "@/lib/server/inbox/sync/errors";
import { abortable } from "@/lib/server/inbox/sync/pace";

/**
 * The Gmail connection's calls to Google's token endpoints (Arctic 3.7, with
 * googleClient(INBOX_REDIRECT_PATH)), and the access-token cache Gmail requests use.
 *
 *   refreshAccessToken(refreshToken)   → { accessToken, expiresAt }, or MailSourceError:
 *                                        invalid_grant                       needs_reconnect token_revoked
 *                                        invalid_client, unauthorized_client  setup oauth_client_invalid
 *                                        no Google client configured         setup google_not_configured
 *                                        gmail.readonly not in the answer    needs_reconnect scope_missing
 *                                        network, timeout, 5xx, 429          temporary (retryable)
 *                                        any other answer (another OAuth     temporary token_refresh_failed,
 *                                        error, a status or body Arctic      not retried
 *                                        cannot read, no usable access token)
 *                                      Never bad_response: the refresh runs inside a Gmail request
 *                                      (gmail-client.ts), and the sync engine must not mistake a
 *                                      token endpoint's bad answer for one about the message being
 *                                      fetched (sync/engine.ts blames a message only for its own
 *                                      faults). token_refresh_failed ends the run, blaming nothing.
 *   revokeToken(token)                 best effort: never throws, gives up after REVOKE_TIMEOUT_MS,
 *                                      answers whether the grant is gone: Google confirmed, or
 *                                      answered 400 invalid_token (the token is already invalid,
 *                                      so the grant it named was dropped before)
 *   createAccessTokens(getRefreshToken)
 *                                      the per-connection cache: a token is reused until shortly
 *                                      before it expires, concurrent callers share one refresh,
 *                                      and a token Gmail rejected (401) is dropped
 *   connectionAccessTokens(userId, getRefreshToken)
 *                                      the cache of the user's connection in this process, kept
 *                                      across sync runs (one refresh an hour, not one a run)
 *   forgetAccessTokens(userId)         drops that cache, a refresh in flight included: called
 *                                      when the connection's token changes or goes (connect,
 *                                      reconnect, disconnect, needs_reconnect), so no run keeps
 *                                      using an access token of the old grant
 *   fixedAccessToken(token)            a provider for one token from a code exchange (the
 *                                      connect callback's getProfile)
 *
 * The access token lives only in memory (the cache), never in the database or a log. Arctic
 * sends its requests with the global fetch and takes no AbortSignal, so a timeout stops the
 * wait, not the request; Google answers or undici's own timeouts end it.
 */

export const INBOX_REDIRECT_PATH = "/api/inbox/callback";
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export const TOKEN_TIMEOUT_MS = 10_000;
export const REVOKE_TIMEOUT_MS = 5_000;
/** A cached token is refreshed this long before Google's expiry (at most half its lifetime). */
export const EXPIRY_MARGIN_MS = 60_000;
/** Google's tokens last an hour; an answer without a usable expires_in is trusted for this long. */
const FALLBACK_LIFETIME_S = 300;
const MAX_LIFETIME_S = 24 * 60 * 60;
const MAX_TOKEN_LENGTH = 8_192;

/** The part of Arctic's Google client used here; tests pass their own. */
export type TokenClient = Pick<Google, "refreshAccessToken" | "revokeToken">;

export interface AccessToken {
  accessToken: string;
  expiresAt: Date;
}

export interface TokenCallOptions {
  /** Default: googleClient(INBOX_REDIRECT_PATH), built when called. */
  client?: TokenClient;
  timeoutMs?: number;
  now?: () => number;
}

/** A fresh access token for `refreshToken`. Throws MailSourceError (see the header). */
export async function refreshAccessToken(refreshToken: string, opts: TokenCallOptions = {}): Promise<AccessToken> {
  const now = opts.now ?? Date.now;
  const client = opts.client ?? inboxGoogleClient();
  let data: { accessToken: string; expiresIn: number | null; scopes: string[] | null };
  try {
    const tokens = await withTimeout(client.refreshAccessToken(refreshToken), opts.timeoutMs ?? TOKEN_TIMEOUT_MS);
    const expiresIn = (tokens.data as { expires_in?: unknown }).expires_in;
    data = {
      accessToken: tokens.accessToken(),
      expiresIn: typeof expiresIn === "number" ? expiresIn : null,
      scopes: tokens.hasScopes() ? tokens.scopes() : null,
    };
  } catch (err) {
    throw classifyTokenError(err);
  }
  if (data.accessToken === "" || data.accessToken.length > MAX_TOKEN_LENGTH || /\s/.test(data.accessToken)) {
    throw inboxError("token_refresh_failed");
  }
  // Google lists the granted scopes. Without gmail.readonly every Gmail call would be refused.
  if (data.scopes && !data.scopes.includes(GMAIL_READONLY_SCOPE)) throw inboxError("scope_missing");
  const lifetime =
    data.expiresIn !== null && Number.isFinite(data.expiresIn) && data.expiresIn > 0
      ? Math.min(data.expiresIn, MAX_LIFETIME_S)
      : FALLBACK_LIFETIME_S;
  return { accessToken: data.accessToken, expiresAt: new Date(now() + lifetime * 1000) };
}

/**
 * Asks Google to revoke `token` (refresh or access token; either ends the whole grant).
 * Best effort: never throws, gives up after REVOKE_TIMEOUT_MS. True when the grant is gone:
 * Google confirmed, or answered invalid_token (already invalid: e.g. a needs_reconnect inbox
 * whose access the owner removed in their Google account). False for anything else.
 */
export async function revokeToken(token: string, opts: Omit<TokenCallOptions, "now"> = {}): Promise<boolean> {
  try {
    const client = opts.client ?? googleClient(INBOX_REDIRECT_PATH);
    await withTimeout(client.revokeToken(token), opts.timeoutMs ?? REVOKE_TIMEOUT_MS);
    return true;
  } catch (err) {
    return err instanceof OAuth2RequestError && err.code === "invalid_token";
  }
}

function inboxGoogleClient(): TokenClient {
  try {
    return googleClient(INBOX_REDIRECT_PATH);
  } catch (err) {
    throw inboxError("google_not_configured", { cause: err });
  }
}

class TokenTimeoutError extends Error {
  constructor() {
    super("Google's token endpoint did not answer in time");
    this.name = "TokenTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TokenTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A failed token call as MailSourceError (see the header). Only Arctic's error class and Google's
 * OAuth error code are read: the description Google sends is never kept, and the error's cause is
 * not set, so nothing that carried the request (and so the token) hangs off the result.
 */
export function classifyTokenError(err: unknown): MailSourceError {
  if (isMailSourceError(err)) return err;
  if (err instanceof TokenTimeoutError) return inboxError("timeout");
  if (err instanceof OAuth2RequestError) {
    if (err.code === "invalid_grant") return inboxError("token_revoked");
    if (err.code === "invalid_client" || err.code === "unauthorized_client") return inboxError("oauth_client_invalid");
    return inboxError("token_refresh_failed");
  }
  if (err instanceof ArcticFetchError) return inboxError("network");
  if (err instanceof UnexpectedResponseError || err instanceof UnexpectedErrorResponseBodyError) {
    if (err.status === 429) return inboxError("rate_limited");
    if (err.status >= 500 && err.status <= 599) return inboxError("google_unavailable");
    return inboxError("token_refresh_failed");
  }
  // OAuth2Tokens accessors throw a plain Error for a missing or mistyped field.
  return inboxError("token_refresh_failed");
}

/* ------------------------------------------------------------ token cache */

export interface AccessTokens extends AccessTokenProvider {
  /** Forget everything, including a refresh in flight (after a disconnect). */
  clear(): void;
}

export interface AccessTokensOptions {
  /** Default: refreshAccessToken with Google. */
  refresh?: (refreshToken: string) => Promise<AccessToken>;
  now?: () => number;
  marginMs?: number;
}

/**
 * The access-token cache of one connection. `getRefreshToken` is called only when a refresh is
 * due (it reads and decrypts the stored token; its errors pass through unchanged). Keep one per
 * connection for as long as the connection is in use; nothing in it is ever written anywhere.
 */
export function createAccessTokens(getRefreshToken: () => Promise<string>, opts: AccessTokensOptions = {}): AccessTokens {
  const refresh = opts.refresh ?? ((refreshToken: string) => refreshAccessToken(refreshToken));
  const now = opts.now ?? Date.now;
  const margin = opts.marginMs ?? EXPIRY_MARGIN_MS;

  let cached: { token: string; refreshAt: number } | null = null;
  let inFlight: Promise<string> | null = null;
  // Bumped by clear(): a refresh that started before it must not fill the cache.
  let generation = 0;

  function startRefresh(): Promise<string> {
    const gen = generation;
    const startedAt = now();
    const p = (async () => {
      const fresh = await refresh(await getRefreshToken());
      const lifetime = fresh.expiresAt.getTime() - startedAt;
      if (gen === generation) {
        cached = { token: fresh.accessToken, refreshAt: startedAt + Math.max(lifetime - margin, lifetime / 2) };
      }
      return fresh.accessToken;
    })();
    inFlight = p;
    // then(f, f), not finally(): finally would hand the rejection on to a promise nobody awaits.
    const settle = () => {
      if (inFlight === p) inFlight = null;
    };
    p.then(settle, settle);
    return p;
  }

  return {
    get(signal) {
      if (cached && now() < cached.refreshAt) return Promise.resolve(cached.token);
      return abortable(inFlight ?? startRefresh(), signal);
    },
    invalidate(token) {
      if (cached?.token === token) cached = null;
    },
    clear() {
      cached = null;
      inFlight = null;
      generation++;
    },
  };
}

// On globalThis, so a hot reload in development keeps the caches (as the sync registry does).
const g = globalThis as unknown as { __jobTrackerInboxAccessTokens?: Map<string, AccessTokens> };

function connectionCaches(): Map<string, AccessTokens> {
  g.__jobTrackerInboxAccessTokens ??= new Map();
  return g.__jobTrackerInboxAccessTokens;
}

/**
 * The access-token cache of the user's connection: created on first use with `getRefreshToken`
 * (it must read that user's stored token), then shared by every run of that user in this
 * process until forgetAccessTokens.
 */
export function connectionAccessTokens(userId: string, getRefreshToken: () => Promise<string>): AccessTokens {
  const caches = connectionCaches();
  let tokens = caches.get(userId);
  if (!tokens) {
    tokens = createAccessTokens(getRefreshToken);
    caches.set(userId, tokens);
  }
  return tokens;
}

/**
 * Forgets the user's access token. A run that still holds the cache gets its next token from a
 * fresh refresh, which reads the stored token again (gone after a disconnect: the run stops).
 */
export function forgetAccessTokens(userId: string): void {
  const caches = connectionCaches();
  caches.get(userId)?.clear();
  caches.delete(userId);
}

/**
 * A provider for one access token that cannot be refreshed, such as the token from the connect
 * callback's code exchange. Once Gmail rejects it, get() throws needs_reconnect/token_rejected.
 */
export function fixedAccessToken(token: string): AccessTokenProvider {
  let rejected = false;
  return {
    get() {
      return rejected ? Promise.reject(inboxError("token_rejected")) : Promise.resolve(token);
    },
    invalidate(t) {
      if (t === token) rejected = true;
    },
  };
}
