// The public demo's frame (docs/plan/5-public-demo.md, "Step 7"): the banner at the top of every
// signed-in page, and the account menu's "Start over" and "Leave the demo" in place of "Sign out".
// Runs in the `demo` project against a server with DEMO_MODE=on. Every test enters the demo once
// (enterDemo), and "Start over" makes a second workspace: 5 entries in this file, against the
// demo's 30 a minute shared by every demo spec.
import { expect, test, type APIRequest, type BrowserContext, type Page } from "@playwright/test";
import type { Job, Me } from "@/lib/types";
import { DEMO_BASE_URL, enterDemo } from "./support/demo";

/** An address on the demo server, whatever the project's baseURL. */
const at = (path: string) => new URL(path, DEMO_BASE_URL).href;

/** Changing API requests need the app's Origin and JSON (src/lib/server/auth/guard.ts). */
const WRITE_HEADERS = { Origin: new URL(DEMO_BASE_URL).origin, "Content-Type": "application/json" };

async function me(page: Page): Promise<Me> {
  const res = await page.request.get(at("/api/me"));
  expect(res.status()).toBe(200);
  return (await res.json()) as Me;
}

async function jobs(page: Page): Promise<Job[]> {
  const res = await page.request.get(at("/api/jobs"));
  expect(res.status()).toBe(200);
  return (await res.json()) as Job[];
}

function banner(page: Page) {
  return page.getByRole("complementary", { name: "About this demo" });
}

/** Opens the account menu at the foot of the sidebar (a wide screen: the sidebar is open). */
async function openAccountMenu(page: Page, name: string) {
  await page.getByRole("button", { name: new RegExp(name) }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** What /api/me answers to a session saved earlier (its cookies, in a request context of their own). */
async function meStatusFor(requests: APIRequest, state: StorageState): Promise<number> {
  const request = await requests.newContext({ storageState: state });
  try {
    return (await request.get(at("/api/me"))).status();
  } finally {
    await request.dispose();
  }
}

test("the banner says the data is invented, private to this browser, when it is deleted, and to keep real data out", async ({
  page,
}) => {
  await enterDemo(page);
  const { demo } = await me(page);
  expect(demo).toBeDefined();
  const expiresAt = demo!.expiresAt;
  // A fixed lifetime of 24 hours from entering.
  const left = Date.parse(expiresAt) - Date.now();
  expect(left).toBeGreaterThan(23 * 3_600_000);
  expect(left).toBeLessThanOrEqual(24 * 3_600_000 + 60_000);

  const notice = banner(page);
  await expect(notice).toContainText("Demo with invented data, private to this browser and deleted");
  await expect(notice).toContainText("Don't enter real personal data.");
  // The deletion time in the browser's own time zone, the exact date and time as a tooltip.
  const time = notice.locator("time");
  await expect(time).toHaveAttribute("datetime", expiresAt);
  await expect(time).toHaveAttribute("title", /^\d{1,2} [A-Z][a-z]{2}( \d{4})?, \d{2}:\d{2}$/);
  const hhmm = await page.evaluate((iso) => new Date(iso).toTimeString().slice(0, 5), expiresAt);
  await expect(time).toHaveText(new RegExp(`^(today|tomorrow) at ${hhmm}$`));

  // On every signed-in page, not only the board.
  await page.goto(at("/settings"));
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(banner(page)).toContainText("Demo with invented data");

  // On a phone it wraps inside the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(banner(page)).toBeVisible();
  const box = await banner(page).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

test("the account menu offers Start over and Leave the demo instead of Sign out", async ({ page }) => {
  await enterDemo(page);
  const { name } = await me(page);

  const menu = await openAccountMenu(page, name);
  await expect(menu.getByRole("menuitem")).toHaveText(["Start over", /^Leave the demo/]);
  await expect(menu.getByRole("menuitem", { name: "Leave the demo", exact: true })).toHaveAccessibleDescription(
    "Deletes this workspace",
  );
  await expect(menu.getByRole("menuitem", { name: "Sign out" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("Start over asks first, then replaces the workspace: a deleted job is back and the old session is gone", async ({
  page,
  context,
  playwright,
}) => {
  await enterDemo(page);
  const { name } = await me(page);
  const seeded = await jobs(page);
  expect(seeded.length).toBeGreaterThan(1);
  const gone = seeded[0];
  const deleted = await page.request.delete(at(`/api/jobs/${encodeURIComponent(gone.id)}`), {
    headers: WRITE_HEADERS,
  });
  expect(deleted.status()).toBeLessThan(300);
  await page.reload();
  await expect(page.getByText(`${seeded.length - 1} jobs tracked.`)).toBeVisible();
  const before = await context.storageState();

  // Cancel changes nothing.
  await (await openAccountMenu(page, name)).getByRole("menuitem", { name: "Start over" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Start over?" });
  await expect(dialog).toContainText(
    "Everything you changed in this demo is deleted, and you get a fresh copy of the invented jobs and emails.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`${seeded.length - 1} jobs tracked.`)).toBeVisible();

  // Confirmed: a plain form post, and the server's 303 back to the board.
  await (await openAccountMenu(page, name)).getByRole("menuitem", { name: "Start over" }).click();
  const posted = page.waitForRequest((req) => new URL(req.url()).pathname === "/auth/demo" && req.method() === "POST");
  await dialog.getByRole("button", { name: "Start over" }).click();
  await posted;

  await expect(page).toHaveURL(at("/"));
  await expect(page.getByText(`${seeded.length} jobs tracked.`)).toBeVisible();
  const fresh = await jobs(page);
  expect(fresh.map((j) => `${j.company} · ${j.title}`)).toContain(`${gone.company} · ${gone.title}`);
  // A new workspace, not the old one patched up: the old session no longer opens anything.
  expect(fresh.map((j) => j.id)).not.toContain(gone.id);
  expect(await meStatusFor(playwright.request, before)).toBe(401);
  await expect(banner(page)).toBeVisible();
});

test("Leave the demo deletes the workspace and lands on the demo's entry page", async ({
  page,
  context,
  playwright,
}) => {
  await enterDemo(page);
  const { name } = await me(page);
  const before = await context.storageState();

  await (await openAccountMenu(page, name)).getByRole("menuitem", { name: "Leave the demo", exact: true }).click();
  await expect(page).toHaveURL(/\/login\/demo$/);
  await expect(page.getByRole("button", { name: "Try the demo" })).toBeVisible();

  // Gone on the server (the old cookie opens nothing) and in this browser (signed out).
  expect(await meStatusFor(playwright.request, before)).toBe(401);
  expect((await page.request.get(at("/api/me"))).status()).toBe(401);
  await page.goto(at("/"));
  await expect(page).toHaveURL(/\/login\/demo/);
});
