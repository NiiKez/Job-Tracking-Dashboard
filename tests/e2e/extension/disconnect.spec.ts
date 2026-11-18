// Ending a connection from either side (docs/plan/4-chrome-extension.md, Popup, steps 5 and 6):
// Revoke in the tracker's Settings, after which the popup forgets the key at its next request, and
// Disconnect in the popup, which revokes the key on the tracker.
import type { Page } from "@playwright/test";
import type { ExtensionOverview, Job } from "@/lib/types";
import { openSettings, settingsSection } from "../support/settings-page";
import { BASE_URL } from "../support/settings";
import { expect, formReady, popupFooter, popupHeading, test } from "./support/extension";
import { CAREERS_JOB, servePage } from "./support/pages";

const DISCONNECTED = "This browser was disconnected. Connect again.";

const browsersList = (page: Page) =>
  settingsSection(page, "Chrome extension").getByRole("region", { name: "Connected browsers" });

/** Revokes the browser with this label in Settings, in `page`. */
async function revokeInSettings(page: Page, label: string): Promise<void> {
  await openSettings(page);
  await browsersList(page).getByRole("button", { name: `Revoke ${label}` }).click({ timeout: 15_000 });
  await page
    .getByRole("alertdialog", { name: "Revoke this browser?" })
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await expect(browsersList(page).getByRole("listitem")).toHaveCount(0);
}

test("revoked in Settings: the popup says this browser was disconnected and offers Connect", async ({
  context,
  page,
  extension,
  connection,
}) => {
  await revokeInSettings(page, connection.label);

  await servePage(context, CAREERS_JOB.url, CAREERS_JOB.html);
  await page.goto(CAREERS_JOB.url);
  const popup = await extension.openPopup(page);
  await expect(popupHeading(popup)).toHaveText("Connect to your Job Tracker", { timeout: 15_000 });
  await expect(popup.getByRole("main").getByText(DISCONNECTED)).toBeVisible();
  // The address connected last, to connect again.
  await expect(popup.getByLabel("Tracker address")).toHaveValue(BASE_URL);
  expect(await extension.stored()).toEqual({ connection: null, lastOrigin: BASE_URL });
});

test("revoked while the popup is open: Save says so and saves nothing", async ({
  context,
  page,
  extension,
  connection,
  api,
}) => {
  await servePage(context, CAREERS_JOB.url, CAREERS_JOB.html);
  await page.goto(CAREERS_JOB.url);
  const popup = await extension.openPopup(page);
  await formReady(popup);

  await revokeInSettings(await context.newPage(), connection.label);

  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await expect(popupHeading(popup)).toHaveText("Connect to your Job Tracker");
  await expect(popup.getByRole("main").getByText(DISCONNECTED)).toBeVisible();
  expect((await extension.stored()).connection).toBeNull();
  expect(await api.get<Job[]>("/api/jobs")).toEqual([]);
});

test("Disconnect in the popup revokes this browser's key on the tracker", async ({
  context,
  page,
  extension,
  connection,
  api,
  request,
}) => {
  expect(await api.get<ExtensionOverview>("/api/extension")).toMatchObject({
    keys: [expect.objectContaining({ id: connection.keyId })],
  });
  await servePage(context, CAREERS_JOB.url, CAREERS_JOB.html);
  await page.goto(CAREERS_JOB.url);
  const popup = await extension.openPopup(page);
  await formReady(popup);

  await popupFooter(popup).getByRole("button", { name: "Disconnect" }).click();
  await expect(popupHeading(popup)).toHaveText("Connect to your Job Tracker");
  await expect(popup.getByRole("main").getByText(`Disconnected from ${new URL(BASE_URL).host}.`)).toBeVisible();
  expect(await extension.stored()).toEqual({ connection: null, lastOrigin: BASE_URL });

  // The key is gone on the tracker: it no longer works, and Settings lists no browser.
  expect(await api.get<ExtensionOverview>("/api/extension")).toMatchObject({ keys: [] });
  const session = await request.get("/api/extension/session", {
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  expect(session.status()).toBe(401);
  await openSettings(page);
  await expect(browsersList(page)).toContainText("Browsers you connect the extension in show up here", {
    timeout: 15_000,
  });
});
