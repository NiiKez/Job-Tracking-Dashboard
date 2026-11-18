// What the public demo changes inside the pages (docs/plan/5-public-demo.md, "Step 7"): Settings
// shows the Chrome extension as unavailable without asking the server about it, the Inbox has no
// sync interval and says how the invented mail gets in, the add-job dialog says links aren't
// opened, and a per-workspace cap's 409 reaches the visitor as the server worded it. Runs in the
// `demo` project against a server with DEMO_MODE=on: 2 workspace entries in this file.
import { expect, test, type Page } from "@playwright/test";
import { DEMO_BASE_URL, enterDemo } from "./support/demo";

/** An address on the demo server, whatever the project's baseURL. */
const at = (path: string) => new URL(path, DEMO_BASE_URL).href;

/** A top-level Settings section by its heading (Inbox, Chrome extension, …). */
function section(page: Page, title: string) {
  return page.getByRole("region", { name: title, exact: true });
}

/**
 * A destination in the sidebar. Its list has no landmark, so it is the list holding "Email
 * activity" (pages have links named "Applications" or "Settings" too; app-shell.spec.ts).
 */
function sidebarLink(page: Page, name: string) {
  return page
    .getByRole("list")
    .filter({ has: page.getByRole("link", { name: "Email activity", exact: true }) })
    .getByRole("link", { name, exact: true });
}

/** Sonner's toasts (bottom right), by title. */
function toast(page: Page, title: string) {
  return page.getByRole("region", { name: /^Notifications/ }).getByRole("listitem").filter({ hasText: title });
}

test("Settings: the extension is an info card with no request to /api/extension, and the Inbox has no interval", async ({
  page,
}) => {
  const extensionRequests: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.startsWith("/api/extension")) extensionRequests.push(req.url());
  });
  await enterDemo(page);
  await page.goto(at("/settings"));

  const extension = section(page, "Chrome extension");
  await expect(extension).toContainText("The Chrome extension isn't available in the demo.");
  await expect(extension).toContainText("In your own copy of the app you install it from here and connect it once.");
  await expect(extension.getByRole("link", { name: "Download" })).toHaveCount(0);
  await expect(extension.getByRole("heading", { name: "Connected browsers" })).toHaveCount(0);

  const inbox = section(page, "Inbox");
  // Loaded: the sync button is there (and works: entry.spec.ts presses it).
  await expect(inbox.getByRole("button", { name: "Sync now" })).toBeVisible();
  await expect(inbox).toContainText("Demo mail");
  await expect(inbox).toContainText(
    "The demo has no Gmail: its inbox holds invented emails. Press Sync now to file them under their jobs.",
  );
  await expect(inbox.getByText("Sync new emails")).toHaveCount(0);
  await expect(inbox.getByRole("combobox")).toHaveCount(0);

  // Back and forth inside the app (the client keeps its cache): still no request.
  await sidebarLink(page, "Applications").click();
  await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible();
  await sidebarLink(page, "Settings").click();
  await expect(section(page, "Chrome extension")).toContainText("isn't available in the demo");
  expect(extensionRequests).toEqual([]);
});

test("Add a job says links aren't opened, and a description over the demo's cap is refused with the server's message", async ({
  page,
}) => {
  await enterDemo(page);
  // The Applications header's button (a workspace has jobs, so not the empty state's "Add job").
  await page.getByRole("button", { name: "Add a job", exact: true }).click();

  const paste = page.getByRole("dialog", { name: "Add a job" });
  await expect(paste.getByLabel("Job link or job text")).toHaveAccessibleDescription(
    "The demo doesn't open links: it guesses the title and company from the link's own text. Paste the whole ad to see every field filled in.",
  );
  await paste.getByRole("button", { name: "Fill in manually" }).click();

  const review = page.getByRole("dialog", { name: "Check the details" });
  await review.getByLabel("Title").fill("Invented Platform Engineer");
  await review.getByLabel("Company").fill("Invented Quay GmbH");
  // 20,399 characters: over the demo's 20,000 (src/lib/server/demo/caps.ts), under the API's 50,000.
  await review.getByLabel("Description").fill("Invented duties. ".repeat(1_200).trim());
  await review.getByRole("button", { name: "Save job" }).click();

  await expect(toast(page, "Couldn't save the job")).toContainText(
    "The demo allows at most 20,000 characters in a job description. Shorten it and try again.",
  );
  // Nothing is lost: the dialog stays with what was typed.
  await expect(review).toBeVisible();
  await expect(review.getByLabel("Title")).toHaveValue("Invented Platform Engineer");

  // Shortened, it saves.
  await review.getByLabel("Description").fill("Invented duties.");
  await review.getByRole("button", { name: "Save job" }).click();
  await expect(toast(page, "Added to Saved")).toContainText("Invented Quay GmbH · Invented Platform Engineer");
});
