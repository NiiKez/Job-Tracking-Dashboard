// Job priority (High / Medium / Low): set it when adding a job, change it from the side sheet or
// the job page (with Undo), see a higher-priority job lead its column, and filter the board and
// the table by it. Jobs are arranged through the API; Medium is the default and isn't marked on
// cards, so the assertions read the cards' spoken names ("Company, Title. High priority. …").
import type { Locator, Page } from "@playwright/test";
import type { Job } from "@/lib/types";
import { expect, test } from "./support/fixtures";
import { card, column, POSTING, toast } from "./support/jobs";

/** The open-buttons of a column's cards, top to bottom. */
function cardsIn(page: Page, name: string): Locator {
  return column(page, name).locator("[data-card-open]");
}

/** A checkbox in an open filter popover: "High 2", the label then the count. */
function box(page: Page, label: string): Locator {
  return page.getByRole("checkbox", { name: new RegExp(`^${label} \\d`) });
}

test("raising a job's priority in the side sheet moves it to the top of its column", async ({ page, api }) => {
  // Three saved jobs; the one added first sits lowest by default.
  const first = await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await api.createJob({ title: "Data Analyst", company: "Lumen Freight" });
  await api.createJob({ title: "Platform Engineer", company: "Invented Harbor GmbH" });
  await page.goto("/");
  const saved = cardsIn(page, "Saved");
  await expect(saved).toHaveCount(3);
  await expect(saved.last()).toHaveAccessibleName(/^Parcelwerk, Frontend Engineer\. /);
  // Medium is the default: no mark, nothing spoken.
  await expect(saved.last()).not.toHaveAccessibleName(/priority/);

  await card(column(page, "Saved"), "Parcelwerk", "Frontend Engineer").click();
  const sheet = page.getByRole("dialog", { name: "Job details" });
  await sheet.getByRole("combobox", { name: "Priority: Medium. Change priority" }).click();
  await page.getByRole("option", { name: "High" }).click();

  await expect(toast(page, "Priority set to High")).toContainText("Parcelwerk · Frontend Engineer");
  await expect(sheet.getByRole("combobox", { name: "Priority: High. Change priority" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await expect(saved.first()).toHaveAccessibleName(/^Parcelwerk, Frontend Engineer\. High priority\. /);
  expect(await api.get<Job>(`/api/jobs/${first.id}`)).toMatchObject({ priority: "high" });
});

test("the job page changes the priority, and Undo puts the old one back", async ({ page, api }) => {
  const job = await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk", priority: "high" });
  await page.goto(`/jobs/${job.id}`);

  const picker = page.getByRole("combobox", { name: /^Priority: High\./ });
  await picker.focus();
  // Keyboard only: open, move to Low, choose.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option", { name: "High" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Low" })).toBeFocused();
  await page.keyboard.press("Enter");

  const done = toast(page, "Priority set to Low");
  await expect(done).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^Priority: Low\./ })).toBeVisible();
  await expect.poll(async () => (await api.get<Job>(`/api/jobs/${job.id}`)).priority).toBe("low");

  await done.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("combobox", { name: /^Priority: High\./ })).toBeVisible();
  await expect.poll(async () => (await api.get<Job>(`/api/jobs/${job.id}`)).priority).toBe("high");
});

test("a priority picked in the Add a job dialog is saved with the job", async ({ page, api }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add job", exact: true }).click();
  const paste = page.getByRole("dialog", { name: "Add a job" });
  await paste.getByLabel("Job link or job text").fill(POSTING.text);
  await paste.getByRole("button", { name: "Read job" }).click();

  const review = page.getByRole("dialog", { name: "Check the details" });
  const priority = review.getByRole("radiogroup", { name: "Priority" });
  await expect(priority.getByRole("radio", { name: "Medium" })).toBeChecked();
  await priority.getByRole("radio", { name: "High" }).click();
  await expect(priority.getByRole("radio", { name: "High" })).toBeChecked();
  await review.getByRole("button", { name: "Save job" }).click();

  await expect(toast(page, "Added to Saved")).toBeVisible();
  await expect(cardsIn(page, "Saved").first()).toHaveAccessibleName(
    new RegExp(`^${POSTING.company}, ${POSTING.title}\\. High priority\\. `),
  );
  const jobs = await api.get<Job[]>("/api/jobs");
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ company: POSTING.company, priority: "high" });
});

test("the priority filter narrows the board and the table, and clears with the others", async ({ page, api }) => {
  await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk", priority: "high" });
  await api.createJob({ title: "Data Analyst", company: "Lumen Freight", status: "applied" });
  await api.createJob({ title: "Platform Engineer", company: "Invented Harbor GmbH", priority: "low" });
  await page.goto("/");
  await expect(card(page, "Lumen Freight", "Data Analyst")).toBeVisible();

  // The boxes follow the URL, which updates a moment after the click: click, then expect.
  await page.getByRole("button", { name: "Filter by priority" }).click();
  await box(page, "High").click();
  await expect(box(page, "High")).toBeChecked();
  await expect(page).toHaveURL(/[?&]priority=high\b/);
  await expect(card(column(page, "Saved"), "Parcelwerk", "Frontend Engineer")).toBeVisible();
  await expect(card(page, "Lumen Freight", "Data Analyst")).toHaveCount(0);
  await expect(card(page, "Invented Harbor GmbH", "Platform Engineer")).toHaveCount(0);
  await expect(page.getByText("1 of 3")).toBeVisible();

  await box(page, "Low").click();
  await expect(box(page, "Low")).toBeChecked();
  await expect(page).toHaveURL(/[?&]priority=high,low\b/);
  await expect(card(page, "Invented Harbor GmbH", "Platform Engineer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Priority filter, 2 selected" })).toBeVisible();
  // The KPI row counts every job, whatever the filter.
  await expect(page.getByText("3 jobs tracked.")).toBeVisible();

  // The table keeps the filter and adds its status filter to it.
  await page.getByRole("radio", { name: "Table view" }).click();
  const table = page.getByRole("table", { name: "Jobs grouped by stage" });
  await expect(table.getByRole("row", { name: /^Parcelwerk / })).toBeVisible();
  await expect(table.getByRole("row", { name: /^Lumen Freight / })).toHaveCount(0);
  await page.getByRole("button", { name: "Filter by status" }).click();
  await page.getByRole("checkbox", { name: /^Applied \d/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByText("No high- or low-priority Applied jobs")).toBeVisible();
  await expect(page.getByText("Nothing has this status and priority right now.")).toBeVisible();

  // The toolbar's button; the empty state has one too.
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(page).not.toHaveURL(/[?&](priority|status)=/);
  await expect(table.getByRole("row", { name: /^Lumen Freight / })).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter by priority" })).toBeVisible();
});

test("a priority nothing has says so", async ({ page, api }) => {
  await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await page.goto("/?priority=low");
  await expect(page.getByText("No low-priority jobs")).toBeVisible();
  await expect(page.getByText("Nothing has this priority right now.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Priority filter, 1 selected" })).toBeVisible();
});
