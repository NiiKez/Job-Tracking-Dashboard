// Signing in and out as a browser goes through it against the running server: signed-out deep
// links, the trip to Google (stopped before it leaves this machine), Google's way back with a
// failure, signing out from the account menu, and sessions that are bad or end while a page is
// open. The handlers' own answers, including a successful callback with a stubbed Google, are in
// tests/handlers/auth-routes.test.ts and guard.test.ts; these tests check what only a browser
// shows: redirects followed, cookies kept or dropped, and the pages' 401 handling.
import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { DEFAULT_USER_SETTINGS } from "@/lib/domain/defaults";
import type { Account } from "./support/db";
import { db } from "./support/db";
import {
  codeChallenge,
  countSessions,
  deleteSessions,
  expireSessions,
  GOOGLE_CLIENT_ID,
  GOOGLE_STAND_IN,
  loginAlert,
  sessionCookie,
  setSessionCookie,
  signInFlow,
  stopAtGoogle,
  unknownSessionToken,
} from "./support/auth";
import { expect, test } from "./support/fixtures";
import { BASE_URL, SESSION_COOKIE } from "./support/settings";

const FAILED = "Sign-in was cancelled or didn't finish. Try again.";

function continueWithGoogle(page: Page) {
  return page.getByRole("link", { name: "Continue with Google" });
}

/** The link's href once the page has read ?next= (before hydration it is the plain fallback). */
function signInHref(next?: string) {
  return next ? `/auth/google?next=${encodeURIComponent(next)}` : "/auth/google";
}

/** From /login?next=…, follows "Continue with Google" up to the stand-in; returns Google's URL. */
async function startSignIn(page: Page, context: BrowserContext, next: string): Promise<URL> {
  const google = await stopAtGoogle(context);
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  const link = continueWithGoogle(page);
  // Clicking the server-rendered fallback would start the flow without `next`.
  await expect(link).toHaveAttribute("href", signInHref(next));
  await link.click();
  await expect(page.getByRole("heading", { name: GOOGLE_STAND_IN })).toBeVisible();
  expect(google.urls).toHaveLength(1);
  return google.urls[0];
}

test.describe("signed out", () => {
  test("a deep link goes to the login page, which keeps where it was going", async ({ page }) => {
    const job = `/jobs/${randomUUID()}?view=timeline&from=invented`;
    const cases = [
      { path: "/settings", next: "/settings" },
      { path: job, next: job },
      // Unknown paths too: the proxy does not tell a signed-out visitor which pages exist.
      { path: "/no-such-page", next: "/no-such-page" },
      // The Gmail connect link is an API route the browser navigates to; it comes back to Settings.
      { path: "/api/inbox/connect", next: "/settings" },
    ];
    for (const { path, next } of cases) {
      await page.goto(path);
      await expect(page).toHaveURL(`/login?next=${encodeURIComponent(next)}`);
      await expect(continueWithGoogle(page)).toHaveAttribute("href", signInHref(next));
    }
    await expect(page).toHaveTitle("Sign in · Job Tracker");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await expect(page.getByText("Use the Google account this tracker belongs to.")).toBeVisible();

    // The API answers 401 instead of redirecting.
    const me = await page.request.get("/api/me");
    expect(me.status()).toBe(401);
    expect(await me.json()).toEqual({ error: "Not signed in" });
  });

  test("the privacy policy loads without a session and links to the login page and back", async ({ page }) => {
    // Google's consent screen links here, so it must not redirect to sign-in.
    const res = await page.goto("/privacy");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL("/privacy");
    await expect(page).toHaveTitle("Privacy · Job Tracker");
    await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();

    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/login");
    await expect(continueWithGoogle(page)).toHaveAttribute("href", "/auth/google");
    await page.getByRole("link", { name: "Privacy" }).click();
    await expect(page).toHaveURL("/privacy");
  });
});

test.describe("the login page", () => {
  test("it explains each sign-in error, and shows none without one", async ({ page }) => {
    const messages = {
      not_allowed: "That Google account isn't allowed to sign in here. Try another account.",
      not_configured: "Sign-in isn't set up on this server yet.",
      failed: FAILED,
      "invented-code": "Sign-in failed. Try again.",
    };
    for (const [code, message] of Object.entries(messages)) {
      await page.goto(`/login?error=${encodeURIComponent(code)}`);
      await expect(loginAlert(page)).toHaveText(message);
    }
    await page.goto("/login?next=%2Fsettings");
    // The href with ?next= shows the page has read its URL, so a missing alert is really missing.
    await expect(continueWithGoogle(page)).toHaveAttribute("href", signInHref("/settings"));
    await expect(loginAlert(page)).toHaveCount(0);
  });

  test("a next that leaves the site or loops back to sign-in is dropped", async ({ page, context }) => {
    for (const next of ["//evil.example.com/steal", "https://evil.example.com/", "/\\evil.example.com", "/login"]) {
      // ?error= makes the page render its alert, which shows the URL has been read.
      await page.goto(`/login?error=failed&next=${encodeURIComponent(next)}`);
      await expect(loginAlert(page)).toBeVisible();
      await expect(continueWithGoogle(page)).toHaveAttribute("href", "/auth/google");
    }

    // A hand-made link straight to /auth/google: the server drops it as well.
    const google = await stopAtGoogle(context);
    await page.goto(`/auth/google?next=${encodeURIComponent("//evil.example.com/steal")}`);
    await expect(page.getByRole("heading", { name: GOOGLE_STAND_IN })).toBeVisible();
    expect((await signInFlow(context))?.next).toBeNull();
    await page.goto(`/auth/google/callback?error=access_denied&state=${google.urls[0].searchParams.get("state")}`);
    await expect(page).toHaveURL("/login?error=failed");
  });

  test("a signed-in visitor sees it as it is, and the session stays", async ({ page, account }) => {
    // /login is a static page and the proxy lets it through: there is no "already signed in"
    // redirect. Signing in again would replace this browser's session (the callback deletes it).
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await expect(continueWithGoogle(page)).toBeVisible();

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible();
    expect(await countSessions(account.userId)).toBe(1);
  });
});

test.describe("the trip to Google", () => {
  test("Continue with Google asks Google for openid, email and profile with state and PKCE", async ({
    page,
    context,
  }) => {
    const next = "/settings?section=invented";
    const google = await startSignIn(page, context, next);

    expect(`${google.origin}${google.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = google.searchParams;
    expect(q.get("client_id")).toBe(GOOGLE_CLIENT_ID);
    expect(q.get("redirect_uri")).toBe(`${BASE_URL}/auth/google/callback`);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")?.split(" ").sort()).toEqual(["email", "openid", "profile"]);
    // Sign-in never asks for offline access: no refresh token.
    expect(q.get("access_type")).toBe("online");
    expect(q.get("prompt")).toBe("select_account");
    expect(q.get("code_challenge_method")).toBe("S256");

    // The browser now holds the flow: the same state, the verifier behind the challenge, and
    // `next`, in a short-lived cookie sent to /auth only.
    const flow = await signInFlow(context);
    expect(flow).toBeDefined();
    expect(q.get("state")).toBe(flow!.state);
    expect(q.get("code_challenge")).toBe(codeChallenge(flow!.codeVerifier));
    expect(flow!.next).toBe(next);
    expect(flow!.cookie).toMatchObject({ path: "/auth", httpOnly: true, sameSite: "Lax" });
    const minutesLeft = (flow!.cookie.expires * 1000 - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(8);
    expect(minutesLeft).toBeLessThanOrEqual(10);
  });

  test("cancelling at Google comes back to the login page with the reason, still going to the same page", async ({
    page,
    context,
  }) => {
    const google = await startSignIn(page, context, "/activity");
    // What Google sends back when the user cancels on its consent screen.
    await page.goto(`/auth/google/callback?error=access_denied&state=${google.searchParams.get("state")}`);

    await expect(page).toHaveURL("/login?error=failed&next=%2Factivity");
    await expect(loginAlert(page)).toHaveText(FAILED);
    await expect(continueWithGoogle(page)).toHaveAttribute("href", signInHref("/activity"));
    // The state cookie is single-use, whatever the outcome.
    expect(await signInFlow(context)).toBeUndefined();
  });

  test("a way back whose state is not this browser's is refused", async ({
    page,
    context,
  }) => {
    await startSignIn(page, context, "/settings");
    // A forged callback: someone else's code and state. A wrong state fails before the server
    // would call Google's token endpoint, so nothing leaves this machine.
    await page.goto("/auth/google/callback?code=invented-code-not-a-secret&state=invented-other-state");

    await expect(page).toHaveURL("/login?error=failed&next=%2Fsettings");
    await expect(loginAlert(page)).toHaveText(FAILED);
    expect(await signInFlow(context)).toBeUndefined();
  });

  test("a way back in a browser that never started sign-in is refused", async ({ page }) => {
    // No state cookie: the link was opened elsewhere, or the cookie's 10 minutes ran out.
    await page.goto("/auth/google/callback?code=invented-code-not-a-secret&state=invented-state");

    await expect(page).toHaveURL("/login?error=failed");
    await expect(loginAlert(page)).toHaveText(FAILED);
    await expect(continueWithGoogle(page)).toHaveAttribute("href", "/auth/google");
  });
});

test.describe("signing out", () => {
  test("the account menu names the account and signs out on the server and in the browser", async ({
    page,
    context,
    account,
  }) => {
    await page.goto("/settings");
    const menuButton = page.getByRole("button", { name: new RegExp(account.name) });
    await expect(menuButton).toContainText(account.email);
    await menuButton.click();
    const menu = page.getByRole("menu");
    await expect(menu).toContainText(account.name);
    await expect(menu).toContainText(account.email);

    await menu.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/login");
    expect(await countSessions(account.userId)).toBe(0);
    expect(await sessionCookie(context)).toBeUndefined();

    await page.goto("/settings");
    await expect(page).toHaveURL("/login?next=%2Fsettings");
    expect((await page.request.get("/api/me")).status()).toBe(401);
  });
});

test.describe("a session cookie the server does not accept", () => {
  const cases: { kind: string; arrange: (context: BrowserContext, account: Account) => Promise<void> }[] = [
    { kind: "a malformed one", arrange: (context) => setSessionCookie(context, "invented-not-a-session-token") },
    { kind: "an unknown one", arrange: (context) => setSessionCookie(context, unknownSessionToken()) },
    { kind: "an expired one", arrange: (_context, account) => expireSessions(account.userId) },
  ];
  for (const { kind, arrange } of cases) {
    test(`${kind} gets 401 from the API, sends pages to sign-in and is dropped`, async ({
      page,
      context,
      account,
      request,
    }) => {
      await arrange(context, account);
      const value = (await sessionCookie(context))!.value;

      // Through a separate request context, so the browser keeps the cookie for the page below.
      const me = await request.get("/api/me", { headers: { Cookie: `${SESSION_COOKIE}=${value}` } });
      expect(me.status()).toBe(401);
      expect(await me.json()).toEqual({ error: "Not signed in" });

      // The proxy only checks that a cookie exists, so the page loads; its first API call answers
      // 401, and the page's own handling (src/lib/api/client.ts) sends the browser to sign in.
      await page.goto("/settings");
      await expect(page).toHaveURL("/login?next=%2Fsettings");
      // That 401 also cleared the cookie, so from now on the proxy redirects right away.
      expect(await sessionCookie(context)).toBeUndefined();
      const res = await page.goto("/activity");
      expect(res?.request().redirectedFrom()?.url()).toBe(`${BASE_URL}/activity`);
      await expect(page).toHaveURL("/login?next=%2Factivity");
    });
  }
});

test.describe("the session ends while a page is open", () => {
  function apiResponse(page: Page, method: string, pathname: string) {
    return page.waitForResponse((r) => r.request().method() === method && new URL(r.url()).pathname === pathname);
  }

  /**
   * Opens Settings and waits for its first API answers, its own and the sidebar's, so the session
   * can end without one of them being the call that notices. (The load state is no help: these
   * calls start after hydration, which can be well after "networkidle" on a busy machine.)
   */
  async function openSettings(page: Page) {
    const loaded = ["/api/settings", "/api/rules", "/api/me", "/api/stats"].map((p) => apiResponse(page, "GET", p));
    await page.goto("/settings");
    for (const res of await Promise.all(loaded)) expect(res.status()).toBe(200);
  }

  test("the next save sends the browser to sign in, coming back to the same page", async ({ page, account }) => {
    await openSettings(page);
    const toggle = page.getByRole("switch", { name: "Create an application from confirmation emails" });
    await expect(toggle).toBeEnabled();
    await deleteSessions(account.userId);

    const save = apiResponse(page, "PATCH", "/api/settings");
    await toggle.click();
    expect((await save).status()).toBe(401);
    await expect(page).toHaveURL("/login?next=%2Fsettings");
    await expect(continueWithGoogle(page)).toHaveAttribute("href", signInHref("/settings"));
    const [row] = await db()<{ create_from_confirmation: boolean }[]>`
      SELECT create_from_confirmation FROM user_settings WHERE user_id = ${account.userId}`;
    expect(row.create_from_confirmation).toBe(DEFAULT_USER_SETTINGS.createFromConfirmation);
  });

  test("an expired session is noticed on the next page opened from the sidebar", async ({ page, account }) => {
    await openSettings(page);
    await expireSessions(account.userId);

    // A client-side navigation: the proxy sees the cookie and lets it through; the review list's
    // fetch is what finds the session gone.
    const reviewList = apiResponse(page, "GET", "/api/emails");
    await page.getByRole("link", { name: "Needs review" }).click();
    expect((await reviewList).status()).toBe(401);
    await expect(page).toHaveURL("/login?next=%2Freview");
  });
});
