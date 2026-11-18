// The `extension` project's test API: full Chromium with the Job Tracker extension loaded (the
// e2e build, support/build.ts). Spec files in tests/e2e/extension/ import { test, expect } from here.
//
//   test("…", async ({ context, page, extension }) => …)   a browser of its own with the extension,
//                                                          not connected. `page` is its first tab.
//   + account, api       as in ../../support/fixtures.ts: the worker's account afresh, with its
//                        session cookie in this browser
//   + connection         the extension already connected to the e2e server as that account, with
//                        a key made through the API (connect.spec.ts goes through Connect itself).
//                        connectedTest makes it for every test of a file.
//
// Each test launches its own browser (launchPersistentContext on a temporary profile, deleted on
// close): Chromium loads extensions only into a persistent context, and the extension's storage
// (its connection, drafts) must not carry over from one test to the next. Launch options come from
// the project (playwright.config.ts): channel "chromium" (the headless shell can't load
// extensions) and the host-resolver rule, which routes still answer before (see pages.ts).
//
// The toolbar popup is opened as a page, chrome-extension://<id>/popup.html?tab=<tab id>, which
// works on that tab as the real popup works on the active one (extension/src/lib/tab.ts).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Page, Worker } from "@playwright/test";
import type { ExtensionKeyCreated } from "@/lib/types";
import { test as base, expect } from "../../support/fixtures";
import { BASE_URL } from "../../support/settings";
import { extensionDir } from "./build";

/** What the extension keeps in chrome.storage.local (extension/src/lib/storage.ts). */
export interface StoredConnection {
  origin: string;
  token: string;
  email: string;
  name: string;
}

export interface Stored {
  connection: StoredConnection | null;
  lastOrigin: string | null;
}

export interface Extension {
  /** The extension's id: the host of its chrome-extension:// pages. */
  id: string;
  /** The manifest's version, as the extension reports it to the connect page. */
  version: string;
  /** The extension's service worker, where the tests call chrome.* APIs. */
  worker(): Promise<Worker>;
  /** The id chrome.tabs gives the tab `page` is in. Finds it by address, so it must be a web page. */
  tabId(page: Page): Promise<number>;
  /** A new tab (about:blank) and its id, for pages without a web address. */
  newTab(): Promise<{ page: Page; tabId: number }>;
  /** Opens the popup as a page, working on `target` (a page, or a tab id). */
  openPopup(target: Page | number): Promise<Page>;
  /** chrome.storage.local: the connection and the last address used. */
  stored(): Promise<Stored>;
  /** The popup's unsaved edits for the page in this tab (chrome.storage.session), or null. */
  draft(tabId: number): Promise<{ url: string; edits: Record<string, string> } | null>;
}

/** The connection the `connection` fixture made. */
export interface Connection {
  keyId: string;
  token: string;
  /** The label Settings shows for this browser. */
  label: string;
  origin: string;
}

const isBackground = (worker: Worker) => /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(worker.url());

export const test = base.extend<{ extension: Extension; connection: Connection }, { extensionPath: string }>({
  extensionPath: [
    async ({}, provide, workerInfo) => {
      const dir = extensionDir(workerInfo.project.outputDir);
      if (!existsSync(path.join(dir, "manifest.json"))) {
        throw new Error(
          `No e2e build of the extension in ${dir}: the extension-build project makes it (don't run with --no-deps)`,
        );
      }
      await provide(dir);
    },
    { scope: "worker" },
  ],

  context: async ({ playwright, extensionPath, channel, headless, launchOptions }, provide) => {
    // The headless shell has no extensions, and branded Chrome ignores --load-extension.
    if (channel !== "chromium") throw new Error('The extension specs need channel "chromium" (the extension project)');
    const context = await playwright.chromium.launchPersistentContext("", {
      ...launchOptions,
      channel,
      headless,
      args: [
        ...(launchOptions.args ?? []),
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await provide(context);
    await context.close();
  },

  page: async ({ context }, provide) => {
    await provide(context.pages()[0] ?? (await context.newPage()));
  },

  extension: async ({ context, extensionPath }, provide) => {
    const first =
      context.serviceWorkers().find(isBackground) ??
      (await context.waitForEvent("serviceworker", { predicate: isBackground }));
    const id = new URL(first.url()).host;
    const { version } = JSON.parse(readFileSync(path.join(extensionPath, "manifest.json"), "utf8")) as {
      version: string;
    };

    // Chrome stops an idle service worker and starts it again for its next event; every tab load
    // is one (it listens to tabs.onUpdated), so a test that opens a page finds it running.
    const worker = async () =>
      context.serviceWorkers().find(isBackground) ??
      (await context.waitForEvent("serviceworker", { predicate: isBackground }));

    const allTabIds = async () =>
      (await worker()).evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.id ?? -1));

    const extension: Extension = {
      id,
      version,
      worker,
      async tabId(page) {
        const address = page.url();
        const ids = await (
          await worker()
        ).evaluate(
          async (url) => (await chrome.tabs.query({})).filter((tab) => tab.url === url).map((tab) => tab.id ?? -1),
          address,
        );
        if (ids.length !== 1) {
          throw new Error(`${ids.length} tabs show ${address}; tabId() needs exactly one (newTab() for other pages)`);
        }
        return ids[0];
      },
      async newTab() {
        const before = new Set(await allTabIds());
        const page = await context.newPage();
        let added: number[] = [];
        await expect
          .poll(async () => {
            added = (await allTabIds()).filter((tabId) => !before.has(tabId));
            return added.length;
          })
          .toBe(1);
        return { page, tabId: added[0] };
      },
      async openPopup(target) {
        const tabId = typeof target === "number" ? target : await extension.tabId(target);
        const popup = await context.newPage();
        await popup.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
        return popup;
      },
      async stored() {
        const { connection = null, lastOrigin = null } = await (
          await worker()
        ).evaluate(() => chrome.storage.local.get(["connection", "lastOrigin"]));
        return { connection, lastOrigin } as Stored;
      },
      async draft(tabId) {
        const key = `draft:${tabId}`;
        const { [key]: draft = null } = await (await worker()).evaluate((k) => chrome.storage.session.get(k), key);
        return draft as Awaited<ReturnType<Extension["draft"]>>;
      },
    };
    await provide(extension);
  },

  connection: async ({ api, account, extension }, provide) => {
    const label = "Chromium on Linux (e2e)";
    const { key, token } = await api.post<ExtensionKeyCreated>("/api/extension/keys", { label });
    const origin = new URL(BASE_URL).origin;
    const stored: StoredConnection = { origin, token, email: account.email, name: account.name };
    // What the service worker stores once the connect page has handed it a key (lib/connect.ts).
    await (
      await extension.worker()
    ).evaluate((connection) => chrome.storage.local.set({ connection, lastOrigin: connection.origin }), stored);
    await provide({ keyId: key.id, token, label, origin });
  },
});

/**
 * The same test with the extension connected for every test (the `connection` fixture, made
 * automatically), for spec files where each test starts connected. A test that needs the key or
 * its label still asks for `connection` (the same one).
 */
export const connectedTest = test.extend<{ connected: Connection }>({
  connected: [
    async ({ connection }, provide) => {
      await provide(connection);
    },
    { auto: true },
  ],
});

/* ------------------------------------------------------------------ the popup */

/** The popup's screen heading: "Connect to your Job Tracker", "Check the details", "Saved", … */
export function popupHeading(popup: Page) {
  return popup.getByRole("heading", { level: 1 });
}

/**
 * A field of the popup's job form by its name (the label without the required mark). The
 * description's text box is hidden until "Show description" opens it.
 */
export function field(popup: Page, name: "Title" | "Company" | "Location" | "Link" | "Description") {
  return popup.getByRole("textbox", { name, exact: true });
}

/**
 * Waits until the popup has read the page and shows the form. Reading takes a script in the tab
 * and a request to the tracker, which can take a few seconds on a busy machine.
 */
export async function formReady(popup: Page): Promise<void> {
  await expect(popupHeading(popup)).toHaveText("Check the details", { timeout: 15_000 });
}

/** The popup's footer: the tracker's host and the account, Disconnect, and the update hint. */
export function popupFooter(popup: Page) {
  return popup.getByRole("contentinfo");
}

export { expect };
export type { Account } from "../../support/fixtures";
