// The signed-in app's frame: the sidebar's four destinations (heading, document title, the item
// marked as current), the job page inside that frame, a job that does not exist, a path that does
// not exist, and the sidebar as a sheet on a phone. The pages' own content is tested elsewhere.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";

const DESTINATIONS = [
  { link: "Applications", path: "/" },
  { link: "Needs review", path: "/review" },
  { link: "Email activity", path: "/activity" },
  { link: "Settings", path: "/settings" },
] as const;

/**
 * The sidebar's list of destinations. It has no landmark of its own, so it is found as the list
 * that holds the "Email activity" link (pages have links named "Applications" or "Settings" too).
 */
function sidebarNav(page: Page) {
  return page.getByRole("list").filter({ has: page.getByRole("link", { name: "Email activity", exact: true }) });
}

/** Exactly `current` is marked active (the component sets data-active; there is no aria-current). */
async function expectCurrent(page: Page, current: string) {
  const nav = sidebarNav(page);
  for (const { link } of DESTINATIONS) {
    await expect(nav.getByRole("link", { name: link, exact: true })).toHaveAttribute(
      "data-active",
      String(link === current),
    );
  }
}

test("the sidebar moves between the four pages and marks the current one", async ({ page, account }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible();
  await expect(page).toHaveTitle("Applications · Job Tracker");
  await expectCurrent(page, "Applications");

  // Round the four destinations and back to the start.
  for (const { link, path } of [...DESTINATIONS.slice(1), DESTINATIONS[0]]) {
    await sidebarNav(page).getByRole("link", { name: link, exact: true }).click();
    await expect(page).toHaveURL(path);
    await expect(page.getByRole("heading", { level: 1, name: link })).toBeVisible();
    await expect(page).toHaveTitle(`${link} · Job Tracker`);
    await expectCurrent(page, link);
  }

  // The name in the sidebar's header leads home as well.
  await sidebarNav(page).getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL("/settings");
  await page.getByRole("link", { name: "Job Tracker" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible();
  // The account the session belongs to is named at the foot of the sidebar.
  await expect(page.getByRole("button", { name: new RegExp(account.name) })).toContainText(account.email);
});

test("a job's page sits under Applications, and an unknown job shows the not-found state", async ({
  page,
  api,
}) => {
  const job = await api.createJob({ title: "Invented Systems Engineer", company: "Invented Lighthouse AG" });
  await page.goto(`/jobs/${job.id}`);
  await expect(page.getByRole("article", { name: "Invented Systems Engineer at Invented Lighthouse AG" })).toBeVisible();
  await expect(page).toHaveTitle("Job details · Job Tracker");
  await expect(page.getByRole("heading", { level: 1, name: "Job details" })).toBeVisible();
  await expectCurrent(page, "Applications");

  for (const id of [randomUUID(), "not-a-job-id"]) {
    await page.goto(`/jobs/${id}`);
    await expect(page.getByText("This job doesn't exist anymore")).toBeVisible();
    await expect(page.getByText("It may have been deleted, or the link is out of date.")).toBeVisible();
  }
  await page.getByRole("link", { name: "Back to Applications" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible();
});

test("a path that does not exist answers with Next's 404 page", async ({ page, account }) => {
  void account; // signed in: signed out, the proxy would send this path to the login page
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
  // No document title: the page carries Next's "404: …" <title> and the root layout's, and which
  // one the browser shows depends on the order they arrive in.
  await expect(page.getByRole("heading", { level: 1, name: "404" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "This page could not be found." })).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the sidebar opens as a sheet and closes once a page is chosen", async ({ page, account }) => {
    await page.goto("/");
    // Drawn in the browser from fetched data: the page is hydrated, so the toggle responds.
    await expect(page.getByText("Add your first job")).toBeVisible();
    const sheet = page.getByRole("dialog", { name: "Sidebar" });
    await expect(sheet).toBeHidden();
    // Hidden behind the toggle at this width: the same links as on a wide screen.
    await expect(page.getByRole("link", { name: "Email activity", exact: true })).toBeHidden();

    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: new RegExp(account.name) })).toContainText(account.email);
    await sheet.getByRole("link", { name: "Email activity", exact: true }).click();

    await expect(page).toHaveURL("/activity");
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Email activity" })).toBeVisible();
  });
});
