// Connect, with the real extension (docs/plan/4-chrome-extension.md, "Connect flow"): the popup's
// Connect screen, the tracker's /extension/connect page the service worker opens and puts its
// bridge into (also after a detour through the login page), the key the page hands over, the popup
// moving on once the key is stored, and the old key revoked when this browser connects again. The
// page's side alone, with the bridge simulated, is ../extension-settings.spec.ts.
import type { Page } from "@playwright/test";
import type { ExtensionOverview } from "@/lib/types";
import { setSessionCookie } from "../support/auth";
import { openSettings, settingsSection } from "../support/settings-page";
import { BASE_URL } from "../support/settings";
import { expect, field, formReady, popupFooter, popupHeading, test } from "./support/extension";
import { CAREERS_JOB, servePage } from "./support/pages";

const HOST = new URL(BASE_URL).host;

const addressField = (popup: Page) => popup.getByLabel("Tracker address");
const connectButton = (scope: Page) => scope.getByRole("button", { name: "Connect", exact: true });
const browsersList = (page: Page) =>
  settingsSection(page, "Chrome extension").getByRole("region", { name: "Connected browsers" });

/**
 * On the connect page the extension opened: waits for its bridge ("Extension <version> is
 * ready"), clicks Connect and waits for "Connected as <email>". Returns the label the page gave
 * this browser ("The extension in <label> will be able to:"), which Settings lists.
 */
async function confirmOnConnectPage(connectTab: Page, version: string, email: string): Promise<string> {
  const main = connectTab.getByRole("main");
  await expect(main.getByRole("status")).toHaveText(`Extension ${version} is ready`, { timeout: 15_000 });
  const intro = await main.getByText(/^The extension in .+ will be able to:$/).textContent();
  const label = /^The extension in (.+) will be able to:$/.exec(intro ?? "")![1];
  await connectButton(connectTab).click();
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Extension connected");
  await expect(main.getByRole("status")).toHaveText(`Connected as ${email}. You can close this tab.`);
  return label;
}

test("Connect opens the tracker's connect page; confirming there connects the popup", async ({
  context,
  page,
  extension,
  account,
  api,
}) => {
  await servePage(context, CAREERS_JOB.url, CAREERS_JOB.html);
  await page.goto(CAREERS_JOB.url);
  const popup = await extension.openPopup(page);
  await expect(popupHeading(popup)).toHaveText("Connect to your Job Tracker");
  // A job page, not the tracker, and nothing connected before: no address to offer.
  await expect(addressField(popup)).toHaveValue("");
  await expect(addressField(popup)).toBeFocused();

  await addressField(popup).fill(BASE_URL);
  const opening = context.waitForEvent("page");
  await connectButton(popup).click();
  const connectTab = await opening;
  await expect(connectTab).toHaveURL(`${BASE_URL}/extension/connect`);
  await expect(popup.getByText(`Confirm on ${HOST} in the tab that opened.`)).toBeVisible();

  // The bridge is in the page: it says which version is ready, and Connect makes the key.
  expect(await api.get<ExtensionOverview>("/api/extension")).toMatchObject({ keys: [] });
  const label = await confirmOnConnectPage(connectTab, extension.version, account.email);

  // The popup moves on by itself and reads the page it was opened over.
  await formReady(popup);
  await expect(field(popup, "Title")).toHaveValue(CAREERS_JOB.title);
  await expect(popupFooter(popup)).toContainText(`${HOST} · ${account.email}`);

  const stored = await extension.stored();
  expect(stored.connection).toEqual({
    origin: BASE_URL,
    token: expect.stringMatching(/^jtx_[A-Za-z0-9_-]{43}$/),
    email: account.email,
    name: account.name,
  });
  expect(stored.lastOrigin).toBe(BASE_URL);

  // Settings lists this browser, once, under the label the connect page showed.
  const { keys } = await api.get<ExtensionOverview>("/api/extension");
  expect(keys).toEqual([expect.objectContaining({ label })]);
  await openSettings(connectTab);
  await expect(browsersList(connectTab).getByRole("listitem")).toHaveCount(1, { timeout: 15_000 });
  await expect(browsersList(connectTab).getByRole("listitem")).toContainText(label);
  await expect(browsersList(connectTab).getByRole("listitem")).toContainText("Last used just now");
});

test("signed out, Connect goes through the login page and finishes once signed in", async ({
  context,
  page,
  extension,
  account,
}) => {
  // The account exists, but this browser has no session.
  await context.clearCookies();
  await servePage(context, CAREERS_JOB.url, CAREERS_JOB.html);
  await page.goto(CAREERS_JOB.url);
  const popup = await extension.openPopup(page);
  await addressField(popup).fill(BASE_URL);
  const opening = context.waitForEvent("page");
  await connectButton(popup).click();
  const connectTab = await opening;
  await expect(connectTab).toHaveURL(`${BASE_URL}/login?next=%2Fextension%2Fconnect`);

  // Google is never reached here: the session cookie stands in for signing in, and the tab goes
  // where sign-in sends it (next). The extension puts its bridge into that load of the page.
  await setSessionCookie(context, account.token);
  await connectTab.goto("/extension/connect");
  await confirmOnConnectPage(connectTab, extension.version, account.email);
  await formReady(popup);
  await expect(popupFooter(popup)).toContainText(`${HOST} · ${account.email}`);
});

test("connecting again while a key is stored leaves the tracker one key for this browser", async ({
  context,
  page,
  extension,
  account,
  connection,
  api,
  request,
}) => {
  await servePage(context, CAREERS_JOB.url, CAREERS_JOB.html);
  await page.goto(CAREERS_JOB.url);
  const popup = await extension.openPopup(page);
  await formReady(popup);

  // The popup offers Connect only while no key is stored, so this sends the message its Connect
  // button sends (from an extension page, as the service worker requires) with the old key still there.
  const opening = context.waitForEvent("page");
  const reply = await popup.evaluate(
    (origin) => chrome.runtime.sendMessage({ type: "connect", origin }) as Promise<unknown>,
    BASE_URL,
  );
  expect(reply).toEqual({ ok: true });
  const connectTab = await opening;
  const label = await confirmOnConnectPage(connectTab, extension.version, account.email);
  expect(label).not.toBe(connection.label);
  expect((await extension.stored()).connection?.token).not.toBe(connection.token);

  // The old key is revoked after the page was told (not awaited), so wait for it.
  await expect
    .poll(async () => (await api.get<ExtensionOverview>("/api/extension")).keys.map((key) => key.label))
    .toEqual([label]);
  const old = await request.get("/api/extension/session", {
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  expect(old.status()).toBe(401);
  await openSettings(connectTab);
  await expect(browsersList(connectTab).getByRole("listitem")).toHaveCount(1, { timeout: 15_000 });
  await expect(browsersList(connectTab).getByRole("listitem")).toContainText(label);
});

test("over a tracker page, the popup offers that page's address", async ({ page, extension }) => {
  // Signed out, the tracker's address shows its login page, which says it is a tracker page too.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  const popup = await extension.openPopup(page);
  await expect(popupHeading(popup)).toHaveText("Connect to your Job Tracker");
  await expect(addressField(popup)).toHaveValue(BASE_URL);
});

test("a page that only says it is a tracker never replaces the address connected last", async ({
  context,
  page,
  extension,
}) => {
  // Any site can carry the tracker's meta tag.
  const lookalike = "https://tracker-lookalike.example.com/";
  await servePage(
    context,
    lookalike,
    '<!doctype html><meta name="job-tracker" content="app"><title>Job Tracker</title><h1>Sign in</h1>',
  );
  await page.goto(lookalike);

  // Never connected: its address is offered, as a real tracker page's would be.
  let popup = await extension.openPopup(page);
  await expect(addressField(popup)).toHaveValue("https://tracker-lookalike.example.com");
  await popup.close();

  // Connected before and since disconnected: the address used last is offered.
  await (
    await extension.worker()
  ).evaluate((origin) => chrome.storage.local.set({ connection: null, lastOrigin: origin }), BASE_URL);
  popup = await extension.openPopup(page);
  await expect(popupHeading(popup)).toHaveText("Connect to your Job Tracker");
  await expect(addressField(popup)).toHaveValue(BASE_URL);
});

test("an address Connect can't use is refused with the reason, and no tab opens", async ({
  context,
  page,
  extension,
}) => {
  await servePage(context, CAREERS_JOB.url, CAREERS_JOB.html);
  await page.goto(CAREERS_JOB.url);
  const popup = await extension.openPopup(page);
  await expect(popupHeading(popup)).toHaveText("Connect to your Job Tracker");
  const tabs = context.pages().length;

  const cases = [
    ["http://tracker.example.com", "Use https. Plain http works only for localhost and 127.0.0.1."],
    ["https://tracker.example.com/settings", "Use the address without a path: https://tracker.example.com"],
    ["", "Enter your tracker's address."],
  ] as const;
  for (const [address, message] of cases) {
    await addressField(popup).fill(address);
    await connectButton(popup).click();
    await expect(popup.getByRole("alert")).toHaveText(message);
    await expect(addressField(popup)).toHaveAttribute("aria-invalid", "true");
    await expect(addressField(popup)).toBeFocused();
  }

  // Nothing was asked of the service worker: no connect tab, nothing stored.
  await popup.waitForTimeout(500);
  expect(context.pages()).toHaveLength(tabs);
  expect(await extension.stored()).toEqual({ connection: null, lastOrigin: null });
});
