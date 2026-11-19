// Helpers for the public demo's specs (tests/e2e/demo, the `demo` project in
// playwright.config.ts): the demo server's origin, entering a workspace as a visitor does, and
// the session cookie that workspace gets.
//
//   import { DEMO_BASE_URL, enterDemo } from "./support/demo";
//
//   test("…", async ({ page }) => {
//     await enterDemo(page);          // a fresh workspace (the invented jobs and emails) for this
//     …                               // browser context, signed in, on the board
//   });
//
// Every workspace goes through the demo's entry gate: at most 30 per minute per server, across
// ALL demo specs and retries (src/lib/server/demo/entry-gate.ts). An entry over the limit lands
// on /login/demo?error=busy, and enterDemo fails saying so. Enter once per test unless the test is
// about entering, and keep a spec's total small: the specs' header says how many it uses.
//
// The demo server is the same build as the e2e server, started with DEMO_MODE=on and no Google
// values (tests/e2e/support/serve.mjs). Its data lives in its own schema; these helpers use the
// browser and the API only, never the database.
import { expect, type BrowserContext, type Cookie, type Page } from "@playwright/test";
import { DEMO_BASE_URL, SESSION_COOKIE } from "../../support/settings";

export { DEMO_BASE_URL };

/** The entry page's button (src/components/auth/demo-entry.tsx). */
export const TRY_THE_DEMO = "Try the demo";

/** The board's region on / (the default view of a fresh workspace). */
const BOARD = "Applications board";

/**
 * Enters the demo as a visitor: opens /login/demo, presses "Try the demo" (a plain form post to
 * /auth/demo) and waits until the board of the new workspace has loaded. Pressing it while
 * already in a workspace starts over: the old workspace is replaced. Uses one entry of the gate.
 * Absolute URLs throughout, so it works in a context of the test's own (browser.newContext()).
 */
export async function enterDemo(page: Page): Promise<void> {
  await page.goto(`${DEMO_BASE_URL}/login/demo`);
  const [answer] = await Promise.all([
    page.waitForResponse((res) => res.url() === `${DEMO_BASE_URL}/auth/demo` && res.request().method() === "POST"),
    page.getByRole("button", { name: TRY_THE_DEMO }).click(),
  ]);
  const location = answer.headers().location ?? "";
  if (answer.status() !== 303 || location !== `${DEMO_BASE_URL}/`) {
    // ?error=busy: more than the gate's 30 entries a minute (or the demo is full).
    throw new Error(`entering the demo answered ${answer.status()} to ${location || "nowhere"}`);
  }
  await page.waitForURL(`${DEMO_BASE_URL}/`);
  await expect(page.getByRole("region", { name: BOARD })).toBeVisible();
}

/** The context's demo session cookie, or undefined (signed out). Its value is the session token. */
export async function demoSession(context: BrowserContext): Promise<Cookie | undefined> {
  return (await context.cookies(DEMO_BASE_URL)).find((c) => c.name === SESSION_COOKIE);
}

/**
 * Posts an empty form from the current page, as a plain HTML form does (the browser adds the
 * page's Origin), and waits for the page the answer leads to (`landsOn`, a path; it must differ
 * from the current one). "Start over" is POST /auth/demo (landing on /), "Leave the demo"
 * POST /auth/signout (landing on /login/demo), as the account menu's items will post them.
 */
export async function postForm(
  page: Page,
  action: "/auth/demo" | "/auth/signout",
  landsOn: string,
): Promise<void> {
  if (new URL(page.url()).pathname === landsOn) throw new Error("postForm: start from another page than landsOn");
  await page.evaluate((path) => {
    const form = document.createElement("form");
    form.method = "post";
    form.action = path;
    document.body.append(form);
    form.submit();
  }, action);
  await page.waitForURL(`${DEMO_BASE_URL}${landsOn}`);
}
