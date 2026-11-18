// Reading a job page and saving it, with the real extension connected (docs/plan/4-chrome-extension.md,
// "Popup"): the page's JSON-LD read into the form, edits kept while the popup is closed, Applied,
// the done screen and its link into the tracker, the duplicate notice and "Updated" (the form then
// starts from the stored job), a tracker that can't be reached, and the footer.
import type { Job } from "@/lib/types";
import { BASE_URL } from "../support/settings";
import { connectedTest as test, expect, field, formReady, popupFooter, popupHeading } from "./support/extension";
import { CAREERS_JOB, LINKEDIN_VIEW, servePage, siteFixture } from "./support/pages";

const HOST = new URL(BASE_URL).host;

/** Under the duplicate notice: where the form's values come from. */
const STORED_FIELDS = "The fields show what the tracker has; empty ones come from this page.";

test("reads a posting's JSON-LD, and Applied saves it with the user's edits", async ({
  context,
  page,
  extension,
  api,
}) => {
  await servePage(context, CAREERS_JOB.url, CAREERS_JOB.html);
  await page.goto(CAREERS_JOB.url);
  const tabId = await extension.tabId(page);
  let popup = await extension.openPopup(page);
  await formReady(popup);

  // The JSON-LD wins over the page's <title> and OpenGraph; the link is the canonical one,
  // without the tab's tracking parameters.
  await expect(field(popup, "Title")).toHaveValue(CAREERS_JOB.title);
  await expect(field(popup, "Title")).toBeFocused();
  await expect(field(popup, "Company")).toHaveValue(CAREERS_JOB.company);
  await expect(field(popup, "Location")).toHaveValue(CAREERS_JOB.location);
  await expect(field(popup, "Link")).toHaveValue(CAREERS_JOB.link);
  // The description is a preview with its length until Show description opens the text box.
  await expect(field(popup, "Description")).toBeHidden();
  await expect(popup.getByText(/^\d+ characters$/)).toBeVisible();
  await popup.getByRole("button", { name: "Show description" }).click();
  await expect(field(popup, "Description")).toBeFocused();
  await expect(field(popup, "Description")).toHaveValue(new RegExp(CAREERS_JOB.descriptionLine));
  // Same version as the tracker serves: no update hint.
  await expect(popupFooter(popup)).not.toContainText("is available");

  // A correction, then the popup closes (Escape, or a click outside). Its edits are kept for
  // this tab and page, and come back over a fresh read.
  const company = "Larkspur Payments";
  await field(popup, "Company").fill(company);
  await expect.poll(() => extension.draft(tabId)).toEqual({ url: CAREERS_JOB.url, edits: { company } });
  await popup.close();
  popup = await extension.openPopup(page);
  await formReady(popup);
  await expect(field(popup, "Company")).toHaveValue(company);
  await expect(field(popup, "Title")).toHaveValue(CAREERS_JOB.title);

  await popup.getByRole("button", { name: "Applied", exact: true }).click();
  await expect(popupHeading(popup)).toHaveText("Marked as applied");
  await expect(popup.getByRole("main")).toContainText(company);

  const jobs = await api.get<Job[]>("/api/jobs");
  expect(jobs).toHaveLength(1);
  const [job] = jobs;
  expect(job).toMatchObject({
    title: CAREERS_JOB.title,
    company,
    location: CAREERS_JOB.location,
    url: CAREERS_JOB.link,
    status: "applied",
    captureMethod: "extension",
  });
  expect(job.description).toContain(CAREERS_JOB.descriptionLine);
  expect(await extension.draft(tabId)).toBeNull();

  // Open in tracker: the job's page, in a new tab.
  const open = popup.getByRole("link", { name: "Open in tracker" });
  await expect(open).toBeFocused();
  await expect(open).toHaveAttribute("href", `${BASE_URL}/jobs/${job.id}`);
  const opening = context.waitForEvent("page");
  await open.click();
  const jobTab = await opening;
  await expect(jobTab).toHaveURL(`${BASE_URL}/jobs/${job.id}`);
  await expect(
    jobTab.getByRole("article", { name: `${CAREERS_JOB.title} at ${company}` }).getByRole("heading", { level: 2 }),
  ).toHaveText(CAREERS_JOB.title);
});

test("opened again on a job it saved, the popup says so, and Save updates it", async ({
  context,
  page,
  extension,
  api,
}) => {
  await servePage(context, CAREERS_JOB.url, CAREERS_JOB.html);
  await page.goto(CAREERS_JOB.url);
  let popup = await extension.openPopup(page);
  await formReady(popup);
  await expect(popup.getByText(/^Already in your tracker/)).toHaveCount(0);
  await popup.getByRole("button", { name: "Applied", exact: true }).click();
  await expect(popupHeading(popup)).toHaveText("Marked as applied");
  const [saved] = await api.get<Job[]>("/api/jobs");
  await popup.close();

  popup = await extension.openPopup(page);
  await formReady(popup);
  await expect(popup.getByText(/^Already in your tracker: Applied, .+\. Saving updates it\.$/)).toBeVisible();
  await expect(popup.getByText(STORED_FIELDS)).toBeVisible();
  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await expect(popupHeading(popup)).toHaveText("Updated");
  await expect(popup.getByRole("link", { name: "Open in tracker" })).toHaveAttribute(
    "href",
    `${BASE_URL}/jobs/${saved.id}`,
  );

  // Still one job, and Save doesn't take an applied job back to Saved.
  const jobs = await api.get<Job[]>("/api/jobs");
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ id: saved.id, status: "applied", captureMethod: "extension" });
});

test("a correction made when saving is kept when the same page is saved again", async ({
  context,
  page,
  extension,
  api,
}) => {
  await servePage(context, CAREERS_JOB.url, CAREERS_JOB.html);
  await page.goto(CAREERS_JOB.url);
  let popup = await extension.openPopup(page);
  await formReady(popup);
  // The company corrected, the location left out.
  const company = "Larkspur Payments";
  await field(popup, "Company").fill(company);
  await field(popup, "Location").fill("");
  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await expect(popupHeading(popup)).toHaveText("Saved");
  expect(await api.get<Job[]>("/api/jobs")).toEqual([expect.objectContaining({ company, location: "" })]);
  await popup.close();

  // Opened again: the form starts from what the tracker has; only its empty fields come from the page.
  popup = await extension.openPopup(page);
  await formReady(popup);
  await expect(popup.getByText(/^Already in your tracker: Saved, /)).toBeVisible();
  await expect(popup.getByText(STORED_FIELDS)).toBeVisible();
  await expect(field(popup, "Company")).toHaveValue(company);
  await expect(field(popup, "Location")).toHaveValue(CAREERS_JOB.location);
  await expect(field(popup, "Title")).toHaveValue(CAREERS_JOB.title);

  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await expect(popupHeading(popup)).toHaveText("Updated");
  const jobs = await api.get<Job[]>("/api/jobs");
  expect(jobs).toEqual([expect.objectContaining({ company, location: CAREERS_JOB.location, status: "saved" })]);
});

test("when the tracker can't be reached, the form keeps what the page gave, and Try again goes on", async ({
  context,
  page,
  extension,
  api,
}) => {
  await servePage(context, LINKEDIN_VIEW.url, siteFixture(LINKEDIN_VIEW.fixture));
  // The popup's requests to the tracker, failing until the test lets them through.
  const failing = { read: true, save: true };
  await context.route(
    (url) => url.origin === BASE_URL && url.pathname === "/api/extension/read",
    (route) => (failing.read ? route.abort("connectionrefused") : route.fallback()),
  );
  await context.route(
    (url) => url.origin === BASE_URL && url.pathname === "/api/extension/jobs",
    (route) =>
      failing.save ? route.fulfill({ status: 503, json: { error: "Service unavailable" } }) : route.fallback(),
  );

  await page.goto(LINKEDIN_VIEW.url);
  const popup = await extension.openPopup(page);
  await formReady(popup);
  const readAlert = popup.getByRole("main").getByRole("alert");
  await expect(readAlert).toContainText(`Couldn't reach ${HOST}. Check your connection, then try again.`);
  await expect(readAlert).toContainText("You can still fill in the job and save it.");
  // What LinkedIn's reader found in the page, without the tracker.
  await expect(field(popup, "Title")).toHaveValue(LINKEDIN_VIEW.title);
  await expect(field(popup, "Company")).toHaveValue(LINKEDIN_VIEW.company);
  await expect(field(popup, "Link")).toHaveValue(LINKEDIN_VIEW.link);

  // An edit, then the tracker is back: Try again reads the page and keeps the edit.
  await field(popup, "Location").fill("Berlin (hybrid)");
  failing.read = false;
  await readAlert.getByRole("button", { name: "Try again" }).click();
  await expect(readAlert).toBeHidden();
  await expect(field(popup, "Location")).toHaveValue("Berlin (hybrid)");
  await expect(field(popup, "Title")).toHaveValue(LINKEDIN_VIEW.title);

  // Saving fails with a 503: the edits stay, Try again saves.
  await popup.getByRole("button", { name: "Save", exact: true }).click();
  const saveAlert = popup.getByRole("alert").filter({ hasText: "Your edits are kept." });
  await expect(saveAlert).toContainText(`${HOST} couldn't answer right now (503). Try again in a moment.`);
  await expect(popupHeading(popup)).toHaveText("Check the details");
  await expect(field(popup, "Location")).toHaveValue("Berlin (hybrid)");
  expect(await api.get<Job[]>("/api/jobs")).toEqual([]);

  failing.save = false;
  await saveAlert.getByRole("button", { name: "Try again" }).click();
  await expect(popupHeading(popup)).toHaveText("Saved");
  const jobs = await api.get<Job[]>("/api/jobs");
  expect(jobs).toEqual([
    expect.objectContaining({ url: LINKEDIN_VIEW.link, location: "Berlin (hybrid)", status: "saved" }),
  ]);
});

test("the footer names the tracker and the account, and points to a newer version in Settings", async ({
  context,
  page,
  extension,
  account,
}) => {
  // The tracker serves a newer build than this one.
  await context.route(
    (url) => url.origin === BASE_URL && url.pathname === "/api/extension/session",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), latestVersion: "99.0.0" } });
    },
  );
  await servePage(context, CAREERS_JOB.url, CAREERS_JOB.html);
  await page.goto(CAREERS_JOB.url);
  const popup = await extension.openPopup(page);
  await formReady(popup);

  const footer = popupFooter(popup);
  await expect(footer).toContainText(`${HOST} · ${account.email}`);
  await expect(footer.getByText(/^Version 99\.0\.0 is available in/)).toHaveText(
    "Version 99.0.0 is available in Settings.",
  );
  await expect(footer.getByRole("link", { name: "Settings" })).toHaveAttribute("href", `${BASE_URL}/settings`);
});
