// The public demo's way in and out (docs/plan/5-public-demo.md, "Step 6"), in the `demo` project
// against a server with DEMO_MODE=on: the entry page, "Try the demo", the seeded board, "Sync
// now" with the invented mail, starting over, leaving, two browsers kept apart, and the proxy's
// redirects and X-Robots-Tag. The route's own answers are in tests/handlers/auth-demo.test.ts.
//
// Workspace entries (the demo's gate allows 30 a minute per server, across every demo spec):
// 1 (board and sync) + 2 (start over, then leave) + 2 (two browsers) = 5 in this file.
import { expect, test, type APIRequestContext, type Cookie, type Page } from "@playwright/test";
import type { Job, Me } from "@/lib/types";
import { DEMO_BASE_URL, demoSession, enterDemo, postForm, TRY_THE_DEMO } from "./support/demo";

const at = (path: string) => new URL(path, DEMO_BASE_URL).href;
/** Changing API requests need the app's Origin and JSON (src/lib/server/auth/guard.ts). */
const WRITE_HEADERS = { Origin: DEMO_BASE_URL, "Content-Type": "application/json" };
const NO_INDEX = "noindex, nofollow";

/** The browser must not leave the demo server (no Google, no other site). */
test.beforeEach(async ({ context }) => {
  await context.route(
    (url) => /^(https?|wss?):$/.test(url.protocol) && url.origin !== DEMO_BASE_URL,
    (route) => route.abort("blockedbyclient"),
  );
});

async function me(page: Page): Promise<{ status: number; body: Me | null }> {
  const res = await page.request.get(at("/api/me"));
  return { status: res.status(), body: res.ok() ? ((await res.json()) as Me) : null };
}

async function jobs(page: Page): Promise<Job[]> {
  const res = await page.request.get(at("/api/jobs"));
  expect(res.status()).toBe(200);
  return (await res.json()) as Job[];
}

/** Renames a job through the API, as an edit in the job's page does. */
async function rename(page: Page, job: Job, company: string): Promise<void> {
  const res = await page.request.patch(at(`/api/jobs/${job.id}`), { headers: WRITE_HEADERS, data: { company } });
  expect(res.status()).toBe(200);
}

const board = (page: Page) => page.getByRole("region", { name: "Applications board" });
/** The sidebar's footer, where "Sync now" sits. */
const sidebarSync = (page: Page) => page.locator("[data-sidebar=footer]").getByRole("button", { name: "Sync now" });
const toasts = (page: Page) => page.getByRole("region", { name: /^Notifications/ });

test.describe("signed out", () => {
  test("every way in leads to the entry page, which says what the demo is", async ({ page }) => {
    for (const path of ["/", "/login", "/login?next=%2Fsettings", "/settings", "/jobs/0190f5a2-0000-7000-8000-000000000000"]) {
      await page.goto(at(path));
      await expect(page, path).toHaveURL(at("/login/demo"));
    }
    // The Google routes have nothing to do here: back to /login, which is the entry page.
    await page.goto(at("/auth/google?next=%2Fsettings"));
    await expect(page).toHaveURL(at("/login/demo"));

    await expect(page).toHaveTitle("Try the demo · Job Tracker");
    await expect(page.getByRole("heading", { level: 1, name: "Try the demo" })).toBeVisible();
    await expect(page.getByText("Explore the tracker with invented jobs and emails.")).toBeVisible();
    await expect(
      page.getByText(
        "Your workspace is private to this browser. It is deleted when you leave, or after 24 hours at the latest (sooner if the demo gets very busy).",
      ),
    ).toBeVisible();
    await expect(page.getByText("Don't enter real personal data.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue with Google" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    // A plain form: it works without JavaScript.
    const form = page.locator("form");
    await expect(form).toHaveAttribute("method", "post");
    await expect(form).toHaveAttribute("action", "/auth/demo");
    expect(await demoSession(page.context())).toBeUndefined();
  });

  test("the entry page explains a busy demo", async ({ page }) => {
    await page.goto(at("/login/demo?error=busy"));
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("The demo is busy right now. Try again in a minute.");
    await expect(page.getByRole("button", { name: TRY_THE_DEMO })).toBeEnabled();
  });

  test("after a busy Start over, the entry page links back to the workspace instead", async ({ page }) => {
    await page.goto(at("/login/demo?error=busy_kept"));
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      "The demo is busy right now, so your workspace was not replaced.",
    );
    await expect(page.getByRole("link", { name: "Back to your workspace" })).toHaveAttribute("href", "/");
    await expect(page.getByRole("button", { name: TRY_THE_DEMO })).toHaveCount(0);
  });

  test("search engines are told to stay away, and the API answers 401", async ({ page }) => {
    for (const path of ["/login/demo", "/privacy"]) {
      const res = await page.goto(at(path));
      expect(res?.status(), path).toBe(200);
      expect(res?.headers()["x-robots-tag"], path).toBe(NO_INDEX);
    }
    const redirect = await page.request.get(at("/"), { maxRedirects: 0 });
    expect(redirect.status()).toBe(307);
    expect(redirect.headers()["x-robots-tag"]).toBe(NO_INDEX);
    // Built from APP_URL; Next sends a Location on the request's own host as a relative one.
    expect(new URL(redirect.headers().location, DEMO_BASE_URL).href).toBe(at("/login/demo"));
    const api = await page.request.get(at("/api/jobs"));
    expect(api.status()).toBe(401);
    expect(api.headers()["x-robots-tag"]).toBe(NO_INDEX);
  });

  test("entering takes a post from the demo's own pages only", async ({ page }) => {
    const other = await page.request.post(at("/auth/demo"), {
      headers: { Origin: "https://elsewhere.example.com" },
      maxRedirects: 0,
    });
    expect(other.status()).toBe(403);
    const get = await page.request.get(at("/auth/demo"), { maxRedirects: 0 });
    expect(get.status()).toBe(405);
    expect(await demoSession(page.context())).toBeUndefined();
  });
});

test("Try the demo opens a workspace of invented jobs, and Sync now files the invented mail", async ({ page }) => {
  await enterDemo(page);
  const cookie = await demoSession(page.context());
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });

  const { status, body } = await me(page);
  expect(status).toBe(200);
  expect(body).toMatchObject({ name: "Alex Demo", email: expect.stringMatching(/@demo\.invalid$/) });
  const expiresAt = Date.parse(body!.demo!.expiresAt);
  expect(expiresAt - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
  expect(expiresAt - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);

  // The seed: a board with jobs in it, Northwind Labs' interview among them.
  const seeded = await jobs(page);
  expect(seeded.length).toBeGreaterThan(10);
  await expect(board(page).getByRole("button", { name: /^Northwind Labs, Senior Frontend Engineer\./ })).toBeVisible();

  // The demo inbox is connected; nothing synced it yet (no timed syncs in the demo).
  const sync = sidebarSync(page);
  await expect(sync).toBeEnabled();
  await sync.click();
  await expect(toasts(page).getByText("Inbox checked")).toBeVisible({ timeout: 30_000 });
  const after = await jobs(page);
  // The invented mail moved jobs or started applications: the board is not as seeded.
  const changed = after.length !== seeded.length || after.some((job) => {
    const before = seeded.find((j) => j.id === job.id);
    return !before || before.status !== job.status;
  });
  expect(changed).toBe(true);
});

/**
 * GET /api/me with this cookie, outside the browser: a request context of its own, so the 401's
 * clearing Set-Cookie cannot touch the browser's cookies (page.request shares them).
 */
async function meWith(request: APIRequestContext, cookie: Cookie): Promise<number> {
  const res = await request.get(at("/api/me"), { headers: { Cookie: `${cookie.name}=${cookie.value}` } });
  return res.status();
}

test("Try the demo inside a workspace starts over, and leaving deletes the workspace", async ({ page, request }) => {
  await enterDemo(page);
  const first = await demoSession(page.context());
  const firstMe = (await me(page)).body!;
  const [job] = await jobs(page);
  await rename(page, job, "Renamed Before Starting Over");

  // Signed in, the entry page stays open; its button starts over (a second entry).
  await enterDemo(page);
  const second = await demoSession(page.context());
  expect(second?.value).not.toBe(first?.value);
  const secondMe = (await me(page)).body!;
  expect(secondMe.email).not.toBe(firstMe.email);
  const fresh = await jobs(page);
  expect(fresh.map((j) => j.company)).not.toContain("Renamed Before Starting Over");
  expect(fresh.map((j) => j.company)).toContain(job.company);
  // The old workspace is gone: its session names nothing any more.
  expect(await meWith(request, first!)).toBe(401);
  expect(await meWith(request, second!)).toBe(200);

  // "Leave the demo" posts the sign-out form: back on the entry page, the workspace deleted.
  await page.goto(at("/settings"));
  await postForm(page, "/auth/signout", "/login/demo");
  expect(await demoSession(page.context())).toBeUndefined();
  expect(await meWith(request, second!)).toBe(401);
  await page.goto(at("/"));
  await expect(page).toHaveURL(at("/login/demo"));
});

test("two browsers get workspaces of their own", async ({ browser }) => {
  const [a, b] = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [pageA, pageB] = await Promise.all([a.newPage(), b.newPage()]);
    // One after another: the gate takes one entry at a time anyway.
    await enterDemo(pageA);
    await enterDemo(pageB);
    const [meA, meB] = [(await me(pageA)).body!, (await me(pageB)).body!];
    expect(meA.email).not.toBe(meB.email);

    // Northwind Labs' card is on the seeded board (Interview), so the rename shows there.
    const jobA = (await jobs(pageA)).find((j) => j.company === "Northwind Labs")!;
    await rename(pageA, jobA, "Only In Browser A");
    const jobsB = await jobs(pageB);
    expect(jobsB.map((j) => j.id)).not.toContain(jobA.id);
    expect(jobsB.map((j) => j.company)).not.toContain("Only In Browser A");
    // A's job is not there for B, even by its id.
    expect((await pageB.request.get(at(`/api/jobs/${jobA.id}`))).status()).toBe(404);

    await pageA.reload();
    await expect(board(pageA).getByRole("button", { name: /^Only In Browser A, Senior Frontend Engineer\./ })).toBeVisible();
    await pageB.reload();
    await expect(board(pageB).getByRole("button", { name: /^Northwind Labs, Senior Frontend Engineer\./ })).toBeVisible();
    await expect(board(pageB).getByRole("button", { name: /^Only In Browser A, / })).toHaveCount(0);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
