// The Applications dashboard: the board's columns and the table, changing a status from a card,
// a row or by keyboard drag (with its Undo), the search and status filters and their URL, the
// KPI row, and the side sheet a card opens. Jobs are arranged through the API; what is asserted
// is what the user sees, plus the stored status and lock where the board can't show them (cards
// have no lock icon).
import type { Job } from "@/lib/types";
import { expect, test } from "./support/fixtures";
import { card, column, dragAnnouncement, keyboardDragReady, toast } from "./support/jobs";

test("a card's ⋯ menu moves the job to another column", async ({ page, api }) => {
  const job = await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await page.goto("/");
  const saved = card(column(page, "Saved"), "Parcelwerk", "Frontend Engineer");
  await saved.hover();
  await page.getByRole("button", { name: "Actions for Parcelwerk, Frontend Engineer" }).click();

  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Saved" })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Interview" }).click();

  await expect(toast(page, "Moved to Interview")).toContainText("Parcelwerk · Frontend Engineer");
  await expect(card(column(page, "Interview"), "Parcelwerk", "Frontend Engineer")).toBeVisible();
  await expect(column(page, "Saved")).toContainText("Nothing here yet · not applied yet");
  // A hand-made change locks the status against email; the board has no sign of it.
  expect(await api.get<Job>(`/api/jobs/${job.id}`)).toMatchObject({ status: "interview", statusLocked: true });
});

test("Mark as applied moves a saved job to Applied without locking its status", async ({ page, api }) => {
  await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await page.goto("/");
  await page.getByRole("button", { name: "Mark Parcelwerk, Frontend Engineer as applied" }).click();

  await expect(toast(page, "Moved to Applied")).toBeVisible();
  const applied = column(page, "Applied");
  await expect(card(applied, "Parcelwerk", "Frontend Engineer")).toBeVisible();
  await expect(applied.getByText("0 of 30 days")).toBeVisible();

  // Saved -> Applied is the normal flow, so emails may still move it on (no lock notice).
  await card(applied, "Parcelwerk", "Frontend Engineer").click();
  const sheet = page.getByRole("dialog", { name: "Job details" });
  const status = sheet.getByRole("definition").filter({ hasText: "Changed by you" });
  await expect(status).toHaveText(/^Applied\s*Changed by you$/);
  await expect(sheet.getByText("You set this status by hand")).toHaveCount(0);
});

test("a card moves by keyboard: Space picks it up, arrows change column, Escape cancels", async ({ page, api }) => {
  const job = await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await page.goto("/");
  const handle = card(column(page, "Saved"), "Parcelwerk", "Frontend Engineer");
  const announced = dragAnnouncement(page);

  // The card starts over its own column, so "Picked up Parcelwerk." is followed at once by
  // "Moved over Saved." in the same live region; either one means the drag has started.
  const pickedUp = /^(Picked up Parcelwerk\.|Moved over Saved\.)$/;

  // A move that is cancelled leaves the job where it was.
  await handle.focus();
  await page.keyboard.press("Space");
  await expect(announced).toHaveText(pickedUp);
  await keyboardDragReady(page);
  await page.keyboard.press("ArrowRight");
  await expect(announced).toHaveText("Moved over Applied.");
  await page.keyboard.press("Escape");
  await expect(announced).toHaveText("Cancelled. Parcelwerk stays in Saved.");
  await expect(handle).toBeVisible();

  await handle.focus();
  await page.keyboard.press("Space");
  await expect(announced).toHaveText(pickedUp);
  await keyboardDragReady(page);
  await page.keyboard.press("ArrowRight");
  await expect(announced).toHaveText("Moved over Applied.");
  await page.keyboard.press("ArrowRight");
  await expect(announced).toHaveText("Moved over Interview.");
  await page.keyboard.press("Space");
  await expect(announced).toHaveText("Dropped in Interview.");

  await expect(toast(page, "Moved to Interview")).toBeVisible();
  await expect(card(column(page, "Interview"), "Parcelwerk", "Frontend Engineer")).toBeVisible();
  await expect(card(column(page, "Saved"), "Parcelwerk", "Frontend Engineer")).toHaveCount(0);
  expect(await api.get<Job>(`/api/jobs/${job.id}`)).toMatchObject({ status: "interview", statusLocked: true });
});

test("Undo in the toast puts the job back in its column and unlocks it again", async ({ page, api }) => {
  // Known and not asserted here: Undo leaves statusSource "manual" and moves lastActivityAt on.
  const job = await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await page.goto("/");
  await card(column(page, "Saved"), "Parcelwerk", "Frontend Engineer").hover();
  await page.getByRole("button", { name: "Actions for Parcelwerk, Frontend Engineer" }).click();
  await page.getByRole("menuitem", { name: "Rejected" }).click();

  // Closed jobs are compact rows grouped by outcome.
  const rejected = column(page, "Closed").getByRole("region", { name: "Rejected" });
  await expect(card(rejected, "Parcelwerk", "Frontend Engineer")).toBeVisible();
  await toast(page, "Moved to Rejected").getByRole("button", { name: "Undo" }).click();

  await expect(card(column(page, "Saved"), "Parcelwerk", "Frontend Engineer")).toBeVisible();
  await expect(column(page, "Closed")).toContainText("Nothing here yet · rejected or no reply");
  await expect
    .poll(async () => (await api.get<Job>(`/api/jobs/${job.id}`)).statusLocked)
    .toBe(false);
  expect(await api.get<Job>(`/api/jobs/${job.id}`)).toMatchObject({ status: "saved" });
});

test("Board and Table switch, and the choice is kept in the URL and remembered", async ({ page, api }) => {
  await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await api.createJob({ title: "Data Analyst", company: "Lumen Freight", status: "applied" });
  await page.goto("/");
  await expect(page.getByRole("radio", { name: "Board view" })).toBeChecked();
  await expect(card(column(page, "Applied"), "Lumen Freight", "Data Analyst")).toBeVisible();

  await page.getByRole("radio", { name: "Table view" }).click();
  await expect(page).toHaveURL(/[?&]view=list\b/);
  const table = page.getByRole("table", { name: "Jobs grouped by stage" });
  await expect(table.getByRole("row", { name: /^Lumen Freight Data Analyst/ })).toBeVisible();
  await expect(table.getByRole("button", { name: "Applied 1 job" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Applications board" })).toHaveCount(0);

  await page.reload();
  await expect(table.getByRole("row", { name: /^Parcelwerk Frontend Engineer/ })).toBeVisible();
  // Without ?view the last choice is used.
  await page.goto("/");
  await expect(page.getByRole("radio", { name: "Table view" })).toBeChecked();
  await expect(table).toBeVisible();

  await page.getByRole("radio", { name: "Board view" }).click();
  await expect(page).toHaveURL(/[?&]view=board\b/);
  await expect(card(column(page, "Saved"), "Parcelwerk", "Frontend Engineer")).toBeVisible();
});

test("search narrows the board to matching companies and titles, and lives in ?q=", async ({ page, api }) => {
  await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await api.createJob({ title: "Data Analyst", company: "Lumen Freight", status: "applied" });
  await api.createJob({ title: "Platform Engineer", company: "Ölwerk Süd AG" });
  await page.goto("/");
  await expect(page.getByText("3 jobs tracked.")).toBeVisible();

  const search = page.getByRole("textbox", { name: "Search jobs by company or title" });
  await search.fill("engineer");
  await expect(page).toHaveURL(/[?&]q=engineer\b/);
  await expect(card(page, "Lumen Freight", "Data Analyst")).toHaveCount(0);
  await expect(card(column(page, "Saved"), "Parcelwerk", "Frontend Engineer")).toBeVisible();
  await expect(card(column(page, "Saved"), "Ölwerk Süd AG", "Platform Engineer")).toBeVisible();
  await expect(column(page, "Applied")).toContainText("No matches");

  // Accents don't matter, and a shared link opens with the search in place.
  await page.goto("/?q=olwerk");
  await expect(search).toHaveValue("olwerk");
  await expect(card(page, "Ölwerk Süd AG", "Platform Engineer")).toBeVisible();
  await expect(card(page, "Parcelwerk", "Frontend Engineer")).toHaveCount(0);

  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(card(column(page, "Applied"), "Lumen Freight", "Data Analyst")).toBeVisible();
  await expect(card(page, "Parcelwerk", "Frontend Engineer")).toBeVisible();
});

test("a search that finds nothing says so, and Clear filters brings every job back", async ({ page, api }) => {
  await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await page.goto("/?q=zeppelin");

  await expect(page.getByText("No jobs match “zeppelin”")).toBeVisible();
  await expect(page.getByText("Search looks at company names and job titles.")).toBeVisible();
  // The KPI row counts every job, whatever the search.
  await expect(page.getByText("1 job tracked.")).toBeVisible();

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(card(column(page, "Saved"), "Parcelwerk", "Frontend Engineer")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search jobs by company or title" })).toHaveValue("");
  await expect(page).not.toHaveURL(/[?&]q=/);
});

test("the table's status filter narrows the rows, counts them, and clears", async ({ page, api }) => {
  await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await api.createJob({ title: "Data Analyst", company: "Lumen Freight", status: "applied" });
  const interview = await api.createJob({
    title: "Platform Engineer",
    company: "Invented Harbor GmbH",
    status: "applied",
  });
  await api.patch(`/api/jobs/${interview.id}`, { status: "interview" });
  await page.goto("/?view=list");
  const table = page.getByRole("table", { name: "Jobs grouped by stage" });
  await expect(table.getByRole("row", { name: /^Parcelwerk / })).toBeVisible();

  // The boxes follow the URL, which updates a moment after the click: click, then expect.
  await page.getByRole("button", { name: "Filter by status" }).click();
  const box = (status: string) => page.getByRole("checkbox", { name: new RegExp(`^${status} \\d`) });
  await box("Interview").click();
  await expect(box("Interview")).toBeChecked();
  await expect(page).toHaveURL(/[?&]status=interview\b/);
  await expect(table.getByRole("row", { name: /^Invented Harbor GmbH Platform Engineer/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /^Parcelwerk / })).toHaveCount(0);
  await expect(table.getByRole("row", { name: /^Lumen Freight / })).toHaveCount(0);
  await expect(page.getByText("1 of 3")).toBeVisible();

  await box("Interview").click();
  await expect(box("Interview")).not.toBeChecked();
  await box("Offer").click();
  await expect(box("Offer")).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByText("No Offer jobs")).toBeVisible();
  await expect(page.getByText("Nothing has this status right now.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Status filter, 1 selected" })).toBeVisible();

  // The toolbar's button; the empty state has one too.
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(page).not.toHaveURL(/[?&]status=/);
  await expect(table.getByRole("row", { name: /^Parcelwerk / })).toBeVisible();
  await expect(table.getByRole("row", { name: /^Lumen Freight / })).toBeVisible();
});

test("a table row's ⋯ menu moves the job to another group", async ({ page, api }) => {
  await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk", status: "applied" });
  await page.goto("/?view=list");
  const table = page.getByRole("table", { name: "Jobs grouped by stage" });
  const row = table.getByRole("row", { name: /^Parcelwerk Frontend Engineer/ });
  await row.hover();
  await row.getByRole("button", { name: "Actions for Parcelwerk, Frontend Engineer" }).click();
  await page.getByRole("menuitem", { name: "Offer" }).click();

  await expect(toast(page, "Moved to Offer")).toBeVisible();
  const offerGroup = table.getByRole("rowgroup").filter({ has: page.getByRole("button", { name: "Offer 1 job" }) });
  await expect(offerGroup.getByRole("row", { name: /^Parcelwerk Frontend Engineer/ })).toBeVisible();
  await expect(offerGroup).toContainText("no deadline set");
  await expect(table.getByRole("button", { name: /^Applied \d/ })).toHaveCount(0);
});

test("the KPI row sums up what was sent, answered, and is still waiting", async ({ page, api }) => {
  await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await api.createJob({ title: "Data Analyst", company: "Lumen Freight", status: "applied" });
  const interview = await api.createJob({
    title: "Platform Engineer",
    company: "Invented Harbor GmbH",
    status: "applied",
  });
  await api.patch(`/api/jobs/${interview.id}`, { status: "interview" });
  const rejected = await api.createJob({ title: "QA Engineer", company: "Kestrel Logistics", status: "applied" });
  await api.patch(`/api/jobs/${rejected.id}`, { status: "rejected" });
  await page.goto("/");

  await expect(page.getByText("4 jobs tracked.")).toBeVisible();
  const waiting = page.getByRole("region", { name: "Waiting for a reply" });
  await expect(waiting.getByText("1", { exact: true })).toBeVisible();
  await expect(waiting.getByRole("button")).toHaveCount(1);
  await expect(waiting.getByRole("button", { name: /Lumen Freight/ })).toBeVisible();

  // The saved job was never sent; the interview and the rejection count as answers.
  await expect(page.getByRole("region", { name: "Overview" })).toMatchAriaSnapshot(`
    - region "Applications sent":
      - paragraph: "3"
    - term: Reply rate
    - definition: 67%
    - definition: 2 of 3 answered
    - term: Interviews in progress
    - definition: "1"
    - definition: No date set yet
    - region "From sent to offer":
      - term: Sent
      - definition: "3"
      - term: Answered
      - definition: /2\\s*67%/
      - term: Reached an interview
      - definition: /1\\s*33%/
      - term: Offer
      - definition: /0\\s*0%/
  `);
});

test("a card opens the job in a side sheet that links to the full page", async ({ page, api }) => {
  const job = await api.createJob({
    title: "Frontend Engineer",
    company: "Parcelwerk",
    location: "Berlin",
    description: "Build the parcel tracking views.",
  });
  await page.goto("/");
  const handle = card(column(page, "Saved"), "Parcelwerk", "Frontend Engineer");
  await handle.click();

  const sheet = page.getByRole("dialog", { name: "Job details" });
  await expect(page).toHaveURL(new RegExp(`[?&]job=${job.id}`));
  await expect(sheet.getByRole("article", { name: "Frontend Engineer at Parcelwerk" })).toBeVisible();
  await expect(sheet.getByText("Build the parcel tracking views.")).toBeVisible();

  // Escape closes it and hands focus back to the card; Enter on the card opens it again.
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]job=/);
  await expect(handle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sheet).toBeVisible();

  await sheet.getByRole("link", { name: "Open full page" }).click();
  await expect(page).toHaveURL(`/jobs/${job.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Job details" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Frontend Engineer at Parcelwerk" })).toBeVisible();
});
