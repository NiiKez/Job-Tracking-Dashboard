import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TargetTab } from "../../../extension/src/lib/tab";
import { startView } from "../../../extension/src/popup/start";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";

// Where the popup starts, and which address the Connect screen offers. Any site can carry the
// tracker's <meta name="job-tracker" content="app">, so the address used last always wins.

const LAST = "https://tracker.example.com";
const tab = (url: string) => ({ id: 7, url }) as TargetTab;

let chromeApi: FakeChrome;
beforeEach(() => {
  chromeApi = installFakeChrome();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The tab carries the tracker's meta tag. */
const looksLikeTracker = () => chromeApi.scripting.executeScript.mockResolvedValue([{ result: true }]);

describe("startView", () => {
  it("is connected when a connection is stored", async () => {
    const connection = { origin: LAST, token: `jtx_${"t".repeat(43)}`, email: "ada@example.com", name: "Ada" };
    await chromeApi.storage.local.set({ connection, lastOrigin: LAST });
    await expect(startView(tab("https://jobs.example.com/1"), null)).resolves.toEqual({ name: "connected", connection });
  });

  it("offers the address used last, even over a page that claims to be the tracker", async () => {
    await chromeApi.storage.local.set({ connection: null, lastOrigin: LAST });
    looksLikeTracker();
    await expect(startView(tab("https://evil.example/login"), "This browser was disconnected. Connect again.")).resolves.toEqual({
      name: "connect",
      suggested: LAST,
      notice: "This browser was disconnected. Connect again.",
    });
    expect(chromeApi.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("offers the open tab's origin only when no address was used before", async () => {
    looksLikeTracker();
    await expect(startView(tab("http://localhost:3800/settings"), null)).resolves.toEqual({
      name: "connect",
      suggested: "http://localhost:3800",
      notice: null,
    });
  });

  it("offers nothing for a page that isn't the tracker, or at an address Connect refuses", async () => {
    await expect(startView(tab("https://jobs.example.com/1"), null)).resolves.toMatchObject({ suggested: "" });
    looksLikeTracker();
    await expect(startView(tab("http://tracker.example.com/"), null)).resolves.toMatchObject({ suggested: "" });
    await expect(startView(null, null)).resolves.toMatchObject({ suggested: "" });
  });
});
