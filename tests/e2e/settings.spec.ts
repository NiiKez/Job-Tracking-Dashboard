// Settings, apart from the Inbox section (inbox.spec.ts), the Chrome extension section
// (extension-settings.spec.ts) and the keyword rules and rule tester (keyword-rules.spec.ts,
// rule-tester.spec.ts): reaching the page and its sections, the automation settings, which save
// as soon as they change, and the theme. A setting that seems saved but is not, or a value out of
// range that slips through, would quietly change how mail moves the user's applications.
import type { Page } from "@playwright/test";
import type { Settings } from "@/lib/types";
import {
  expect,
  openSettings,
  pick,
  reloadSettings,
  resultRow,
  settingsSection,
  test,
  testerForm,
  toasts,
} from "./support/settings-page";

const SECTIONS = ["Inbox", "Chrome extension", "Automation", "Keyword rules", "Test an email", "Appearance"];

test.describe("the page", () => {
  test("Settings is reached from the sidebar and lists its six sections", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings", exact: true }).click();

    await expect(page).toHaveURL("/settings");
    await expect(page).toHaveTitle("Settings · Job Tracker");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(SECTIONS);
    await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link")).toHaveText(SECTIONS);
  });

  test("a section link jumps to its section and marks it as the current one", async ({ page }) => {
    await openSettings(page);
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await expect(nav.getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "location");

    await nav.getByRole("link", { name: "Keyword rules" }).click();
    await expect(page).toHaveURL(/\/settings#keyword-rules$/);
    await expect(page.getByRole("heading", { level: 2, name: "Keyword rules" })).toBeInViewport();
    await expect(nav.getByRole("link", { name: "Keyword rules" })).toHaveAttribute("aria-current", "location");
    await expect(nav.getByRole("link", { name: "Inbox" })).not.toHaveAttribute("aria-current");
  });

  // App bug: the browser scrolls to #test-email while the sections above are skeletons; when the
  // rules load the page grows (~2.4k → ~4.3k px) and the heading ends up ~2000 px below the fold.
  test.fixme("a link to a section opens the page at that section", async ({ page }) => {
    await openSettings(page, "/settings#test-email");
    await expect(page.getByRole("heading", { level: 2, name: "Test an email" })).toBeInViewport();
    await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).not.toBeInViewport();
  });
});

test.describe("automation", () => {
  test("a new account starts with the default automation settings", async ({ page }) => {
    await openSettings(page);
    const automation = settingsSection(page, "Automation");
    await expect(automation.getByRole("spinbutton", { name: "Mark as No response after" })).toHaveValue("30");
    await expect(
      automation.getByRole("switch", { name: "Create an application from confirmation emails" }),
    ).toBeChecked();
    // Review of uncertain mail cannot be turned off: it is what keeps a wrong guess from moving a job.
    const review = automation.getByRole("switch", { name: "Send uncertain emails to review" });
    await expect(review).toBeChecked();
    await expect(review).toBeDisabled();
  });

  test("no-response days: a typed number is saved and kept after a reload", async ({ page, api }) => {
    await openSettings(page);
    const days = page.getByRole("spinbutton", { name: "Mark as No response after" });
    await days.fill("45");
    await days.press("Enter");

    await expect(toasts(page).getByText("Saved", { exact: true })).toBeVisible();
    await expect.poll(async () => (await api.get<Settings>("/api/settings")).noResponseDays).toBe(45);
    await reloadSettings(page);
    await expect(days).toHaveValue("45");
  });

  test("no-response days: the − and + buttons stop at 7 and 120", async ({ page, api }) => {
    const savedDays = async () => (await api.get<Settings>("/api/settings")).noResponseDays;
    await api.patch("/api/settings", { noResponseDays: 8 });
    await openSettings(page);
    const automation = settingsSection(page, "Automation");
    const days = automation.getByRole("spinbutton", { name: "Mark as No response after" });
    const fewer = automation.getByRole("button", { name: "Fewer days" });
    const more = automation.getByRole("button", { name: "More days" });

    await expect(days).toHaveValue("8");
    await fewer.click();
    await expect(days).toHaveValue("7");
    await expect(fewer).toBeDisabled();
    await expect.poll(savedDays).toBe(7);

    await days.fill("119");
    await days.press("Enter");
    await expect.poll(savedDays).toBe(119);
    await more.click();
    await expect(days).toHaveValue("120");
    await expect(more).toBeDisabled();
    await expect(fewer).toBeEnabled();
    await expect.poll(savedDays).toBe(120);
  });

  test("no-response days: a number out of range is refused with a message and not saved", async ({ page, api }) => {
    await openSettings(page);
    const automation = settingsSection(page, "Automation");
    const days = automation.getByRole("spinbutton", { name: "Mark as No response after" });
    const error = automation.getByRole("alert");

    await days.fill("5");
    await days.press("Tab");
    await expect(error).toHaveText("Enter a whole number from 7 to 120.");
    await expect(days).toHaveAttribute("aria-invalid", "true");

    // Typing again clears the message until the next attempt to save.
    await days.fill("121");
    await expect(error).toBeHidden();
    await days.press("Enter");
    await expect(error).toHaveText("Enter a whole number from 7 to 120.");

    await days.fill("7.5");
    await days.press("Enter");
    await expect(error).toHaveText("Enter a whole number from 7 to 120.");

    await days.fill("");
    await days.press("Enter");
    await expect(error).toHaveText("Enter a whole number from 7 to 120.");

    // Escape gives up the edit and shows the saved value again.
    await days.press("Escape");
    await expect(days).toHaveValue("30");
    await expect(error).toBeHidden();
    await expect(days).not.toHaveAttribute("aria-invalid");

    await expect(toasts(page).getByText("Saved", { exact: true })).toHaveCount(0);
    expect((await api.get<Settings>("/api/settings")).noResponseDays).toBe(30);
  });

  test("the settings API refuses the values the page does not offer", async ({ api }) => {
    for (const patch of [
      { noResponseDays: 6 },
      { noResponseDays: 121 },
      { noResponseDays: 7.5 },
      { inbox: { intervalMinutes: 4 } },
      { inbox: { intervalMinutes: 1441 } },
      { createFromConfirmation: "no" },
    ]) {
      const res = await api.request.patch("/api/settings", { data: patch });
      expect(res.status(), JSON.stringify(patch)).toBe(400);
      expect((await res.json()).error).toBe("Invalid request");
    }
    const settings = await api.get<Settings>("/api/settings");
    expect(settings.noResponseDays).toBe(30);
    expect(settings.inbox.intervalMinutes).toBe(15);
    expect(settings.createFromConfirmation).toBe(true);
  });

  test("creating applications from confirmations can be switched off, and the rule tester follows", async ({
    page,
    api,
  }) => {
    await openSettings(page);
    const create = page.getByRole("switch", { name: "Create an application from confirmation emails" });
    await create.click();
    await expect(toasts(page).getByText("Saved", { exact: true })).toBeVisible();
    await expect(create).not.toBeChecked();
    await expect.poll(async () => (await api.get<Settings>("/api/settings")).createFromConfirmation).toBe(false);

    await reloadSettings(page);
    await expect(create).not.toBeChecked();

    // An invitation for a job the dashboard does not have now waits for review instead of adding one.
    const tester = settingsSection(page, "Test an email");
    await pick(page, testerForm(page).getByLabel("Try an example"), "Interview invite (EN)");
    await expect(tester.getByText("Needs review", { exact: true })).toBeVisible();
    await expect(resultRow(page, "Review reason")).toHaveText(/^No matching job/);

    await create.click();
    await expect(create).toBeChecked();
    await expect.poll(async () => (await api.get<Settings>("/api/settings")).createFromConfirmation).toBe(true);
    await testerForm(page).getByRole("button", { name: "Test", exact: true }).click();
    await expect(tester.getByText("New application", { exact: true })).toBeVisible();
  });
});

test.describe("appearance", () => {
  const html = (page: Page) => page.locator("html");

  test("Dark is the default, even on a light device", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openSettings(page);
    const theme = settingsSection(page, "Appearance").getByRole("radiogroup", { name: "Theme" });
    await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();
    await expect(html(page)).toHaveClass(/\bdark\b/);
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBeNull();
  });

  test("Light and Dark override the device and are kept after a reload", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openSettings(page);
    const theme = settingsSection(page, "Appearance").getByRole("radiogroup", { name: "Theme" });
    await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();
    await expect(html(page)).toHaveClass(/\bdark\b/);

    await theme.getByRole("radio", { name: "Light" }).click();
    await expect(html(page)).toHaveClass(/\blight\b/);
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
    await reloadSettings(page);
    await expect(theme.getByRole("radio", { name: "Light" })).toBeChecked();
    await expect(html(page)).toHaveClass(/\blight\b/);

    await page.emulateMedia({ colorScheme: "light" });
    await theme.getByRole("radio", { name: "Dark" }).click();
    await expect(html(page)).toHaveClass(/\bdark\b/);
    await reloadSettings(page);
    await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();
    await expect(html(page)).toHaveClass(/\bdark\b/);
    // The choice is the browser's, not the account's: it is kept on this device only.
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe("dark");
  });

  test("System follows the device setting, also when it changes", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openSettings(page);
    const theme = settingsSection(page, "Appearance").getByRole("radiogroup", { name: "Theme" });
    await theme.getByRole("radio", { name: "Dark" }).click();
    await expect(html(page)).toHaveClass(/\bdark\b/);

    await theme.getByRole("radio", { name: "System" }).click();
    await expect(theme.getByRole("radio", { name: "System" })).toBeChecked();
    await expect(html(page)).toHaveClass(/\blight\b/);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html(page)).toHaveClass(/\bdark\b/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(html(page)).toHaveClass(/\blight\b/);
  });
});
