// A site reader in the real browser (extension/src/page/sites/): LinkedIn's saved pages
// (tests/extension/page/fixtures, also the readers' unit tests) at LinkedIn's own addresses, so
// the reader that matches the address runs in the tab, and the job is saved with LinkedIn's clean
// /jobs/view/<id>/ link.
import type { Job } from "@/lib/types";
import { connectedTest as test, expect, field, formReady, popupHeading } from "./support/extension";
import { LINKEDIN_SEARCH, LINKEDIN_VIEW, servePage, siteFixture } from "./support/pages";

test("LinkedIn: a posting's page is read by its reader and saved with the clean link", async ({
  context,
  page,
  extension,
  api,
}) => {
  await servePage(context, LINKEDIN_VIEW.url, siteFixture(LINKEDIN_VIEW.fixture));
  await page.goto(LINKEDIN_VIEW.url);
  const popup = await extension.openPopup(page);
  await formReady(popup);

  await expect(field(popup, "Title")).toHaveValue(LINKEDIN_VIEW.title);
  await expect(field(popup, "Company")).toHaveValue(LINKEDIN_VIEW.company);
  await expect(field(popup, "Location")).toHaveValue(LINKEDIN_VIEW.location);
  await expect(field(popup, "Link")).toHaveValue(LINKEDIN_VIEW.link);
  await popup.getByRole("button", { name: "Show description" }).click();
  await expect(field(popup, "Description")).toHaveValue(new RegExp(LINKEDIN_VIEW.descriptionLine));

  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await expect(popupHeading(popup)).toHaveText("Saved");
  const jobs = await api.get<Job[]>("/api/jobs");
  expect(jobs).toEqual([
    expect.objectContaining({
      title: LINKEDIN_VIEW.title,
      company: LINKEDIN_VIEW.company,
      location: LINKEDIN_VIEW.location,
      url: LINKEDIN_VIEW.link,
      status: "saved",
      captureMethod: "extension",
    }),
  ]);
  expect(jobs[0].description).toContain(LINKEDIN_VIEW.descriptionLine);
});

test("LinkedIn: on a search page, the open posting (currentJobId) is read, not the list beside it", async ({
  context,
  page,
  extension,
  api,
}) => {
  await servePage(context, LINKEDIN_SEARCH.url, siteFixture(LINKEDIN_SEARCH.fixture));
  await page.goto(LINKEDIN_SEARCH.url);
  const popup = await extension.openPopup(page);
  await formReady(popup);

  await expect(field(popup, "Title")).toHaveValue(LINKEDIN_SEARCH.title);
  await expect(field(popup, "Company")).toHaveValue(LINKEDIN_SEARCH.company);
  await expect(field(popup, "Link")).toHaveValue(LINKEDIN_SEARCH.link);

  await popup.getByRole("button", { name: "Applied", exact: true }).click();
  await expect(popupHeading(popup)).toHaveText("Marked as applied");
  expect(await api.get<Job[]>("/api/jobs")).toEqual([
    expect.objectContaining({
      title: LINKEDIN_SEARCH.title,
      company: LINKEDIN_SEARCH.company,
      url: LINKEDIN_SEARCH.link,
      status: "applied",
    }),
  ]);
});
