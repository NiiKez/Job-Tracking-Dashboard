// The web app's side of the Chrome extension (docs/plan/4-chrome-extension.md, "The app"): the
// Chrome extension section in Settings (the download, the install steps, the connected browsers
// and Revoke) and the connect page, /extension/connect. The extension itself is not loaded here:
// its connect bridge, a content script in the real thing, is played by a script in the page that
// speaks the same window messages (src/components/extension/protocol.ts). Keys made here are
// checked against the key routes with a plain request that carries only the key.
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import type { ExtensionKeyCreated, ExtensionOverview, ExtensionSession } from "@/lib/types";
import { test as signedOut } from "./support/fixtures";
import { expect, openSettings, settingsSection, test, toasts } from "./support/settings-page";

const extensionSection = (page: Page) => settingsSection(page, "Chrome extension");
const browsersList = (page: Page) => extensionSection(page).getByRole("region", { name: "Connected browsers" });
const browserRow = (page: Page, label: string) =>
  browsersList(page).getByRole("listitem").filter({ hasText: label });
const revokeDialog = (page: Page) => page.getByRole("alertdialog", { name: "Revoke this browser?" });

/** GET /api/extension/session with nothing but the key, as the extension asks. */
function sessionWith(request: APIRequestContext, token: string) {
  return request.get("/api/extension/session", { headers: { Authorization: `Bearer ${token}` } });
}

async function connectedKeys(api: { get<T>(path: string): Promise<T> }) {
  return (await api.get<ExtensionOverview>("/api/extension")).keys;
}

/** Answers GET /api/extension with the server's answer, changed by `patch`. */
async function overviewWith(page: Page, patch: Partial<ExtensionOverview>): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/extension",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...((await response.json()) as ExtensionOverview), ...patch } });
    },
  );
}

/** Waits until the section has loaded (it fetches on its own, after the rest of Settings). */
async function extensionReady(page: Page): Promise<Locator> {
  const section = extensionSection(page);
  await expect(section.getByRole("region", { name: "Connected browsers" })).toBeVisible({ timeout: 15_000 });
  return section;
}

/* ---------------------------------------------------------------- Settings */

test.describe("Settings", () => {
  test("a new account sees the download, the install steps and no connected browser", async ({ page, api }) => {
    expect(await connectedKeys(api)).toEqual([]);
    // The version as the server would report it, so this test reads the same with or without a
    // build; the next one checks the real build and its zip.
    await overviewWith(page, { version: "1.2.3" });
    await openSettings(page);
    const section = await extensionReady(page);
    await expect(
      page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Chrome extension" }),
    ).toHaveAttribute("href", "#extension");

    await expect(section.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/extension/download");
    await expect(section.getByText("Version 1.2.3 · Chrome 120 or newer, Edge and Brave too")).toBeVisible();

    await expect(section.getByRole("list", { name: "Install it" }).getByRole("listitem")).toHaveText([
      "Unzip the download.",
      /^Open chrome:\/\/extensions\s*in a new tab and turn on Developer mode, top right\.$/,
      "Click Load unpacked and pick the unzipped folder.",
      "Pin the extension to the toolbar. Then, on this page, click its icon and choose Connect.",
    ]);
    // A page can't open chrome:// addresses: it is shown to copy, never as a link.
    await expect(
      section.getByRole("list", { name: "Install it" }).getByText("chrome://extensions", { exact: true }),
    ).toBeVisible();
    await expect(section.locator('a[href^="chrome:"]')).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Copy chrome://extensions" })).toBeVisible();
    // An unpacked extension's id comes from its folder, so an update goes into the same one.
    await expect(section).toContainText(
      "To update it, unzip the new download over the same folder, replacing its files, then click the reload icon",
    );

    await expect(browsersList(page)).toContainText("Browsers you connect the extension in show up here");
    await expect(browsersList(page).getByRole("button", { name: /^Revoke/ })).toHaveCount(0);
  });

  test("the copy button puts chrome://extensions on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openSettings(page);
    const section = await extensionReady(page);
    await section.getByRole("button", { name: "Copy chrome://extensions" }).click();
    await expect(toasts(page).getByText("Address copied")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("chrome://extensions");
  });

  test("the Download link hands out the zip, to a signed-in browser only", async ({ page, api, request }) => {
    const { version } = await api.get<ExtensionOverview>("/api/extension");
    // The e2e build is `npm run build`, which builds the extension before the app.
    expect(version, "this build has no zip of the extension: run npm run build").toMatch(/^\d+(\.\d+){0,3}$/);
    await openSettings(page);
    const section = await extensionReady(page);
    await expect(section.getByText(`Version ${version} ·`)).toBeVisible();

    const downloading = page.waitForEvent("download");
    await section.getByRole("link", { name: "Download" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`job-tracker-extension-${version}.zip`);

    const res = await api.request.get("/api/extension/download");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/zip");
    expect(res.headers()["content-disposition"]).toContain(`job-tracker-extension-${version}.zip`);
    expect((await res.body()).subarray(0, 4).toString("binary")).toBe("PK\x03\x04");

    // Without a session the proxy answers before the route.
    expect((await request.get("/api/extension/download")).status()).toBe(401);
  });

  test("without a build on the server, the section says how to make one", async ({ page }) => {
    await overviewWith(page, { version: null });
    await openSettings(page);
    const section = await extensionReady(page);
    await expect(section.getByText("This server has no build of the extension")).toBeVisible();
    await expect(section.getByText("npm run build:extension", { exact: true })).toBeVisible();
    // On a deployed server the build comes with the release (built in CI, not on the server).
    await expect(section).toContainText("A deployed release always has one: deploy it again.");
    await expect(section.getByRole("link", { name: "Download" })).toHaveCount(0);
    // The steps stay: they apply as soon as there is a build.
    await expect(section.getByRole("list", { name: "Install it" }).getByRole("listitem")).toHaveCount(4);
  });

  test("when the section can't load, it says so and Try again loads it", async ({ page }) => {
    let fail = true;
    await page.route(
      (url) => url.pathname === "/api/extension",
      (route) => (fail ? route.fulfill({ status: 500, json: { error: "Something went wrong" } }) : route.continue()),
    );
    await openSettings(page);
    const section = extensionSection(page);
    await expect(section.getByText("Couldn’t load the extension’s settings.")).toBeVisible({ timeout: 15_000 });
    await expect(section.getByText("Something went wrong")).toBeVisible();

    fail = false;
    await section.getByRole("button", { name: "Try again" }).click();
    await expect(browsersList(page)).toBeVisible();
  });

  test("lists each connected browser with when it was connected and last used", async ({ page, api, request }) => {
    const linux = await api.post<ExtensionKeyCreated>("/api/extension/keys", { label: "Chrome on Linux" });
    const edge = await api.post<ExtensionKeyCreated>("/api/extension/keys", { label: "Edge on Windows" });
    // One request with the Linux key: the server notes when it was last used.
    const used = await sessionWith(request, linux.token);
    expect(used.status()).toBe(200);

    await openSettings(page);
    await extensionReady(page);
    await expect(browsersList(page).getByRole("listitem")).toHaveCount(2);

    const linuxRow = browserRow(page, "Chrome on Linux");
    await expect(linuxRow).toContainText(/Connected \d{1,2} [A-Z][a-z]{2}/);
    await expect(linuxRow).toContainText("Last used just now");
    await expect(linuxRow.locator("time").first()).toHaveAttribute("datetime", linux.key.createdAt);

    const edgeRow = browserRow(page, "Edge on Windows");
    await expect(edgeRow).toContainText("Not used yet");
    await expect(edgeRow.locator("time")).toHaveAttribute("datetime", edge.key.createdAt);
    await expect(edgeRow.getByRole("button", { name: "Revoke Edge on Windows" })).toBeVisible();
  });

  test("a browser connected meanwhile shows up when the window gets the focus back", async ({ page, api }) => {
    await openSettings(page);
    await extensionReady(page);
    await expect(browsersList(page)).toContainText("Browsers you connect the extension in show up here");

    // Connected from the extension's popup over this page, seconds later: closing the popup
    // gives the window its focus back without a visibilitychange, and the list is still fresh.
    await api.post<ExtensionKeyCreated>("/api/extension/keys", { label: "Chrome on Linux" });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(browserRow(page, "Chrome on Linux")).toContainText("Not used yet");
  });

  test("Revoke asks first; then the browser leaves the list and its key stops working", async ({
    page,
    api,
    request,
  }) => {
    const linux = await api.post<ExtensionKeyCreated>("/api/extension/keys", { label: "Chrome on Linux" });
    const edge = await api.post<ExtensionKeyCreated>("/api/extension/keys", { label: "Edge on Windows" });
    await openSettings(page);
    await extensionReady(page);
    const dialog = revokeDialog(page);

    // Cancel keeps it.
    await browsersList(page).getByRole("button", { name: "Revoke Chrome on Linux" }).click();
    await expect(dialog).toContainText("The extension in Chrome on Linux stops working until you connect it again.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(await connectedKeys(api)).toHaveLength(2);

    await browsersList(page).getByRole("button", { name: "Revoke Chrome on Linux" }).click();
    await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(toasts(page).getByText("Extension revoked")).toBeVisible();
    await expect(browsersList(page).getByRole("listitem")).toHaveText([/^Edge on Windows/]);

    expect((await connectedKeys(api)).map((k) => k.id)).toEqual([edge.key.id]);
    expect((await sessionWith(request, linux.token)).status()).toBe(401);
    expect((await sessionWith(request, edge.token)).status()).toBe(200);

    // The last one: the list is empty again.
    await browsersList(page).getByRole("button", { name: "Revoke Edge on Windows" }).click();
    await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(browsersList(page)).toContainText("Browsers you connect the extension in show up here");
    expect(await connectedKeys(api)).toEqual([]);
  });

  test("a browser revoked elsewhere meanwhile counts as revoked", async ({ page, api }) => {
    const linux = await api.post<ExtensionKeyCreated>("/api/extension/keys", { label: "Chrome on Linux" });
    await openSettings(page);
    await extensionReady(page);
    await api.delete(`/api/extension/keys/${linux.key.id}`);

    await browsersList(page).getByRole("button", { name: "Revoke Chrome on Linux" }).click();
    await revokeDialog(page).getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(revokeDialog(page)).toBeHidden();
    await expect(toasts(page).getByText("Extension revoked")).toBeVisible();
    await expect(browsersList(page).getByRole("listitem")).toHaveCount(0);
  });
});

/* ------------------------------------------------------------ connect page */

interface HandedKey {
  token: string;
  keyId: string;
}

interface BridgeOptions {
  version: string;
  email: string;
  /** The answer to each "key" message in turn: "connected", { failed: error }, or "silent" (none). */
  answers: Array<"connected" | "silent" | { failed: string }>;
}

/**
 * Plays the extension's connect bridge in the page (top frame only): says "ready" at once and
 * after each "hello", keeps each key it is handed in window.__bridge for the test, and answers
 * as told. Serialized into the page, so it uses nothing from this file.
 */
function installBridge({ version, email, answers }: BridgeOptions) {
  if (window !== window.top) return;
  const bridge = { seen: [] as string[], keys: [] as HandedKey[] };
  (window as unknown as { __bridge: typeof bridge }).__bridge = bridge;
  const post = (message: Record<string, unknown>) =>
    window.postMessage({ source: "job-tracker-extension", ...message }, location.origin);
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as { source?: string; type?: string; token?: string; keyId?: string } | null;
    if (data?.source !== "job-tracker-app" || !data.type) return;
    bridge.seen.push(data.type);
    if (data.type === "hello") post({ type: "ready", version });
    if (data.type === "key") {
      bridge.keys.push({ token: String(data.token), keyId: String(data.keyId) });
      const answer = answers.shift() ?? "connected";
      if (answer === "connected") post({ type: "connected", email });
      else if (answer !== "silent") post({ type: "failed", error: answer.failed });
    }
  });
  post({ type: "ready", version });
}

/** Starts the stand-in bridge in the loaded page, as the extension injects its bridge after a load. */
async function startBridge(page: Page, options: BridgeOptions): Promise<void> {
  await page.evaluate(installBridge, options);
}

const handedKeys = (page: Page) =>
  page.evaluate(() => (window as unknown as { __bridge: { keys: HandedKey[] } }).__bridge.keys);

const main = (page: Page) => page.getByRole("main");
const heading = (page: Page) => main(page).getByRole("heading", { level: 1 });
const connectButton = (page: Page) => main(page).getByRole("button", { name: "Connect", exact: true });

/** Opens the connect page and waits until it has hydrated and said hello (its button exists either way). */
async function openConnect(page: Page) {
  await page.goto("/extension/connect");
  await expect(heading(page)).toHaveText("Connect the extension");
}

/** The label the page shows for this browser ("The extension in <label> will be able to:"). */
async function shownLabel(page: Page): Promise<string> {
  const text = await main(page).getByText(/^The extension in .+ will be able to:$/).textContent();
  return /^The extension in (.+) will be able to:$/.exec(text ?? "")![1];
}

signedOut("the connect page asks a signed-out browser to sign in first", async ({ page }) => {
  await page.goto("/extension/connect");
  await expect(page).toHaveURL("/login?next=%2Fextension%2Fconnect");
});

// The popup offers the open tab's address as the tracker to connect to when the page says it is one.
signedOut("every page says it is a Job Tracker page, the login page too", async ({ page }) => {
  for (const path of ["/login", "/privacy"]) {
    await page.goto(path);
    await expect(page.locator('meta[name="job-tracker"]')).toHaveAttribute("content", "app");
  }
});

test.describe("the connect page", () => {
  test("without the extension, it waits and says what to do", async ({ page }) => {
    await openConnect(page);
    await expect(page).toHaveTitle("Connect the extension · Job Tracker");
    await expect(page.locator('meta[name="job-tracker"]')).toHaveAttribute("content", "app");
    await expect(main(page).getByRole("status")).toHaveText("Waiting for the extension…");
    await expect(connectButton(page)).toBeDisabled();
    await expect(main(page)).toContainText("Open the Job Tracker extension from your browser’s toolbar and click Connect.");
    await expect(main(page).getByRole("link", { name: "Settings, under Chrome extension" })).toHaveAttribute(
      "href",
      "/settings#extension",
    );
    // Stays so: nothing else counts as the extension.
    await page.waitForTimeout(500);
    await expect(connectButton(page)).toBeDisabled();

    await main(page).getByRole("link", { name: "Cancel" }).click();
    await expect(page).toHaveURL("/");
  });

  test("Connect hands the extension a key of its own, which works on the extension's routes", async ({
    page,
    api,
    account,
    request,
  }) => {
    await openConnect(page);
    // As the real bridge: injected after the page loaded, it says "ready".
    await startBridge(page, { version: "1.0.0", email: account.email, answers: ["connected"] });

    await expect(main(page).getByRole("status")).toHaveText("Extension 1.0.0 is ready");
    await expect(main(page)).toContainText("Save jobs to your tracker as Saved or Applied");
    const label = await shownLabel(page);
    expect(label.length).toBeGreaterThan(0);
    expect(label.length).toBeLessThanOrEqual(80);
    expect(await connectedKeys(api)).toEqual([]);

    await connectButton(page).click();
    await expect(heading(page)).toHaveText("Extension connected");
    await expect(main(page).getByRole("status")).toHaveText(`Connected as ${account.email}. You can close this tab.`);

    const handed = await handedKeys(page);
    expect(handed).toHaveLength(1);
    const [{ token, keyId }] = handed;
    expect(token).toMatch(/^jtx_[A-Za-z0-9_-]{43}$/);
    expect(await connectedKeys(api)).toEqual([expect.objectContaining({ id: keyId, label, lastUsedAt: null })]);

    const session = await sessionWith(request, token);
    expect(session.status()).toBe(200);
    expect((await session.json()) as ExtensionSession).toMatchObject({ email: account.email });

    // The token went to the extension only: not into the address, the page's storage or a cookie.
    expect(page.url()).not.toContain(token);
    const kept = await page.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie, location.href]),
    );
    expect(kept).not.toContain(token);

    // Settings lists the browser under the page's label.
    await openSettings(page);
    await extensionReady(page);
    await expect(browserRow(page, label)).toContainText("Last used just now");
  });

  test("the page says hello, so a bridge that was there before it still gets to answer", async ({ page, account }) => {
    // Injected before the page's own scripts: its first "ready" is lost, the answer to "hello" is not.
    const options: BridgeOptions = { version: "2.3.4", email: account.email, answers: [] };
    await page.addInitScript(installBridge, options);
    await openConnect(page);
    await expect(main(page).getByRole("status")).toHaveText("Extension 2.3.4 is ready");
    await expect(connectButton(page)).toBeEnabled();
    expect(await page.evaluate(() => (window as unknown as { __bridge: { seen: string[] } }).__bridge.seen)).toContain(
      "hello",
    );
  });

  test("when the extension can't finish, the page deletes the key it made, and Try again connects", async ({
    page,
    api,
    account,
    request,
  }) => {
    await openConnect(page);
    await startBridge(page, {
      version: "1.0.0",
      email: account.email,
      answers: [{ failed: "The tracker answered 503." }, "connected"],
    });
    await connectButton(page).click();

    await expect(heading(page)).toHaveText("Couldn’t connect the extension");
    await expect(main(page).getByRole("alert")).toHaveText("The tracker answered 503.");
    const [first] = await handedKeys(page);
    await expect.poll(() => connectedKeys(api)).toEqual([]);
    expect((await sessionWith(request, first.token)).status()).toBe(401);

    await main(page).getByRole("button", { name: "Try again" }).click();
    await expect(heading(page)).toHaveText("Extension connected");
    const handed = await handedKeys(page);
    expect(handed).toHaveLength(2);
    expect(handed[1].keyId).not.toBe(first.keyId);
    expect((await connectedKeys(api)).map((k) => k.id)).toEqual([handed[1].keyId]);
  });

  /** Starts Connect with a bridge that never answers, and waits until the key went to it. */
  async function connectWithoutAnswer(page: Page, email: string) {
    await page.clock.install();
    await openConnect(page);
    await startBridge(page, { version: "1.0.0", email, answers: ["silent"] });
    await connectButton(page).click();
    await expect(connectButton(page)).toHaveCount(0);
    await expect(main(page).getByRole("button", { name: "Connecting…" })).toBeDisabled();
    await expect(main(page).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect.poll(async () => (await handedKeys(page)).length).toBe(1);
    return (await handedKeys(page))[0];
  }

  test("when the extension doesn't confirm, the page stops waiting but keeps the key; a late answer still counts", async ({
    page,
    api,
    account,
  }) => {
    const handed = await connectWithoutAnswer(page, account.email);
    expect((await connectedKeys(api)).map((k) => k.id)).toEqual([handed.keyId]);

    // The extension may have stored the key: the page says how to tell, and deletes nothing.
    await page.clock.runFor(31_000);
    await expect(heading(page)).toHaveText("The extension didn’t confirm");
    const status = main(page).getByRole("status");
    await expect(status).toContainText("It got its key but didn’t say whether it kept it.");
    await expect(status).toContainText("If it offers to save the page as a job, it’s connected. You can close this tab.");
    await expect(status).toContainText(
      "If it asks you to connect, revoke this browser in Settings, under Chrome extension, then connect again.",
    );
    await expect(status.getByRole("link", { name: "Settings, under Chrome extension" })).toHaveAttribute(
      "href",
      "/settings#extension",
    );
    await expect(main(page).getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/settings#extension");
    await page.waitForTimeout(500);
    expect((await connectedKeys(api)).map((k) => k.id)).toEqual([handed.keyId]);

    // The answer comes after all.
    await page.evaluate((email) => {
      window.postMessage({ source: "job-tracker-extension", type: "connected", email }, location.origin);
    }, account.email);
    await expect(heading(page)).toHaveText("Extension connected");
    expect((await connectedKeys(api)).map((k) => k.id)).toEqual([handed.keyId]);
  });

  test("a late failed answer after that still deletes the key: the extension did not keep it", async ({
    page,
    api,
    account,
  }) => {
    await connectWithoutAnswer(page, account.email);
    await page.clock.runFor(31_000);
    await expect(heading(page)).toHaveText("The extension didn’t confirm");

    await page.evaluate(() => {
      window.postMessage(
        { source: "job-tracker-extension", type: "failed", error: "The tracker refused the key." },
        location.origin,
      );
    });
    await expect(heading(page)).toHaveText("Couldn’t connect the extension");
    await expect(main(page).getByRole("alert")).toHaveText("The tracker refused the key.");
    await expect.poll(() => connectedKeys(api)).toEqual([]);
  });

  test("when making the key takes too long, the attempt fails and the late key is deleted", async ({
    page,
    api,
    account,
  }) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let createdStatus: number | undefined;
    await page.route(
      (url) => url.pathname === "/api/extension/keys",
      async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        await released;
        const response = await route.fetch();
        createdStatus = response.status();
        await route.fulfill({ response });
      },
    );
    await page.clock.install();
    await openConnect(page);
    await startBridge(page, { version: "1.0.0", email: account.email, answers: ["connected"] });
    await connectButton(page).click();
    await expect(main(page).getByRole("button", { name: "Connecting…" })).toBeDisabled();

    await page.clock.runFor(31_000);
    await expect(heading(page)).toHaveText("Couldn’t connect the extension");
    await expect(main(page).getByRole("alert")).toHaveText("Making a key for the extension took too long. Try again.");

    // The server answers after all: the key never reaches the extension and is deleted.
    release();
    await expect.poll(() => createdStatus).toBe(201);
    await expect.poll(() => connectedKeys(api)).toEqual([]);
    expect(await handedKeys(page)).toEqual([]);
  });

  test("messages that aren't the extension's are ignored", async ({ page, api, account }) => {
    await openConnect(page);
    await page.evaluate(() => {
      const origin = location.origin;
      // Another sender's name, and the page's own name.
      window.postMessage({ source: "someone-else", type: "ready", version: "9.9.9" }, origin);
      window.postMessage({ source: "job-tracker-app", type: "ready", version: "9.9.9" }, origin);
      // The extension's name, but from a frame of this origin, and from a frame of no origin.
      const script = `<script>parent.postMessage({ source: "job-tracker-extension", type: "ready", version: "9.9.9" }, "*")</script>`;
      const sameOrigin = document.createElement("iframe");
      sameOrigin.srcdoc = script;
      const opaque = document.createElement("iframe");
      opaque.setAttribute("sandbox", "allow-scripts");
      opaque.srcdoc = script;
      document.body.append(sameOrigin, opaque);
      // An answer nobody asked for.
      window.postMessage({ source: "job-tracker-extension", type: "connected", email: "someone@example.com" }, origin);
    });
    await page.waitForTimeout(750);
    await expect(heading(page)).toHaveText("Connect the extension");
    await expect(main(page).getByRole("status")).toHaveText("Waiting for the extension…");
    await expect(connectButton(page)).toBeDisabled();

    // The page still listens: the real thing gets through, and only its answer counts.
    await startBridge(page, { version: "1.0.0", email: account.email, answers: ["silent"] });
    await expect(main(page).getByRole("status")).toHaveText("Extension 1.0.0 is ready");
    await connectButton(page).click();
    await expect.poll(async () => (await handedKeys(page)).length).toBe(1);
    await page.evaluate(() => {
      window.postMessage({ source: "someone-else", type: "failed", error: "Not you" }, location.origin);
    });
    await page.waitForTimeout(500);
    await expect(main(page).getByRole("button", { name: "Connecting…" })).toBeVisible();

    await page.evaluate((email) => {
      window.postMessage({ source: "job-tracker-extension", type: "connected", email }, location.origin);
    }, account.email);
    await expect(heading(page)).toHaveText("Extension connected");
    expect(await connectedKeys(api)).toHaveLength(1);
  });
});
