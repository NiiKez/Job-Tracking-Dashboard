// Helpers for the sign-in specs (auth.spec.ts, app-shell.spec.ts): starting Google sign-in in the
// browser without ever reaching Google, reading the flow's state cookie, and the session rows and
// cookies the tests break on purpose.
import { createHash, randomBytes } from "node:crypto";
import type { BrowserContext, Cookie, Page } from "@playwright/test";
import { db } from "./db";
import { BASE_URL, SESSION_COOKIE } from "./settings";

export { GOOGLE_CLIENT_ID } from "./settings";

/** The sign-in flow's state cookie over http (src/lib/server/auth/google.ts SIGN_IN_STATE_COOKIE). */
export const STATE_COOKIE = "jt_oauth";

/** The heading of the page the browser sees in place of Google's account chooser. */
export const GOOGLE_STAND_IN = "Google stand-in";

const ORIGIN = new URL(BASE_URL).origin;

/**
 * Lets the browser start Google sign-in without any request leaving this machine, and records
 * where the server sent it.
 *
 * Routing accounts.google.com is not enough: Playwright's routes never see the hops of a redirect,
 * so the browser would follow the server's 303 (and fail there: playwright.config.ts lets it
 * resolve no host but the e2e server). Instead /auth/google itself is routed: Playwright sends the request (sharing the context's cookies, not following redirects),
 * keeps the Location, and answers the browser with a stand-in page that carries the response's
 * Set-Cookie (the state cookie). Every other request off the app's origin is aborted as well.
 */
export async function stopAtGoogle(context: BrowserContext): Promise<{ urls: URL[] }> {
  const urls: URL[] = [];
  await context.route(
    (url) => url.origin !== ORIGIN,
    (route) => route.abort("blockedbyclient"),
  );
  await context.route(
    (url) => url.origin === ORIGIN && url.pathname === "/auth/google",
    async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      const { location, "set-cookie": setCookie } = response.headers();
      if (location) urls.push(new URL(location));
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          ...(setCookie ? { "set-cookie": setCookie } : {}),
        },
        body: `<!doctype html><title>${GOOGLE_STAND_IN}</title><h1>${GOOGLE_STAND_IN}</h1>`,
      });
    },
  );
  return { urls };
}

/** What the state cookie holds (src/lib/server/auth/oauth-state.ts, Stored). */
export interface SignInFlow {
  cookie: Cookie;
  state: string;
  codeVerifier: string;
  next: string | null;
}

/** The browser's sign-in state cookie, decoded; undefined when it has none. */
export async function signInFlow(context: BrowserContext): Promise<SignInFlow | undefined> {
  const cookie = (await context.cookies(BASE_URL)).find((c) => c.name === STATE_COOKIE);
  if (!cookie) return undefined;
  const stored = JSON.parse(Buffer.from(cookie.value, "base64url").toString("utf8")) as {
    s: string;
    c: string;
    n: string | null;
  };
  return { cookie, state: stored.s, codeVerifier: stored.c, next: stored.n };
}

/** PKCE S256 (RFC 7636): base64url(SHA-256(verifier)). */
export function codeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

/** The browser's session cookie, or undefined. */
export async function sessionCookie(context: BrowserContext): Promise<Cookie | undefined> {
  return (await context.cookies(BASE_URL)).find((c) => c.name === SESSION_COOKIE);
}

/** Puts `value` into the browser as the session cookie, replacing the one it has. */
export async function setSessionCookie(context: BrowserContext, value: string): Promise<void> {
  await context.addCookies([{ name: SESSION_COOKIE, value, url: BASE_URL, httpOnly: true, sameSite: "Lax" }]);
}

/** A well-formed session token (32 random bytes, base64url) that names no session. */
export function unknownSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function countSessions(userId: string): Promise<number> {
  const [row] = await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId}`;
  return row.n;
}

/** Ends the user's sessions on the server only: the browser keeps its cookie. */
export async function deleteSessions(userId: string): Promise<void> {
  await db()`DELETE FROM sessions WHERE user_id = ${userId}`;
}

/** Moves the user's sessions past their expiry; the rows stay. */
export async function expireSessions(userId: string): Promise<void> {
  await db()`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = ${userId}`;
}

/** The alert on the login page (Next's route announcer is a role="alert" too, outside <main>). */
export function loginAlert(page: Page) {
  return page.getByRole("main").getByRole("alert");
}
