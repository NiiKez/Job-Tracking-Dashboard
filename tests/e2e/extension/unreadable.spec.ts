// Pages Chrome doesn't let extensions script (docs/plan/4-chrome-extension.md, Popup, step 2):
// the popup still opens the form, empty, says why, and saves what is typed in. The tab's address
// is the link when it is a web page.
import type { Job } from "@/lib/types";
import { connectedTest as test, expect, field, formReady, popupHeading } from "./support/extension";

const UNREADABLE = "Chrome doesn't let extensions read this page. Fill in the job yourself.";

test("a blank tab: an empty form that says why, which saves what is typed in", async ({ extension, api }) => {
  const { tabId } = await extension.newTab();
  const popup = await extension.openPopup(tabId);
  await formReady(popup);
  await expect(popup.getByText(UNREADABLE)).toBeVisible();
  for (const name of ["Title", "Company", "Location", "Link"] as const) {
    await expect(field(popup, name)).toHaveValue("");
  }
  await expect(popup.getByText("No description yet.")).toBeVisible();

  // Title and Company are required; nothing is sent without them.
  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await expect(popup.getByText("Add the job title.")).toBeVisible();
  await expect(popup.getByText("Add the company name.")).toBeVisible();
  await expect(popupHeading(popup)).toHaveText("Check the details");

  await field(popup, "Title").fill("Data Engineer");
  await field(popup, "Company").fill("Quillmate");
  await field(popup, "Link").fill("https://jobs.example.com/quillmate/data-engineer");
  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await expect(popupHeading(popup)).toHaveText("Saved");
  expect(await api.get<Job[]>("/api/jobs")).toEqual([
    expect.objectContaining({
      title: "Data Engineer",
      company: "Quillmate",
      url: "https://jobs.example.com/quillmate/data-engineer",
      status: "saved",
      captureMethod: "extension",
    }),
  ]);
});

test("Chrome's error page (the posting didn't load): the form has the tab's address as the link", async ({
  extension,
}) => {
  // Not routed, so the host doesn't resolve (playwright.config.ts) and the tab shows Chrome's
  // error page, which no extension may script, under the posting's address.
  const address = "https://jobs.example.com/careers/9001-unreachable";
  const { page, tabId } = await extension.newTab();
  await expect(page.goto(address)).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
  const popup = await extension.openPopup(tabId);
  await formReady(popup);
  await expect(popup.getByText(UNREADABLE)).toBeVisible();
  await expect(field(popup, "Link")).toHaveValue(address);
  await expect(field(popup, "Title")).toHaveValue("");
});
