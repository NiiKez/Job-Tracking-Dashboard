import { beforeEach, describe, expect, it } from "vitest";
import { findTargetTab } from "../../../extension/src/lib/tab";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";

// The tab the popup works on (extension/src/lib/tab.ts). Clicking the toolbar icon opens
// popup.html with no query: the active tab of the last focused window. The end-to-end tests open
// popup.html?tab=<id> as a page instead, so this is the only test of the first way.

const JOB = "https://jobs.example.com/1";

let chromeApi: FakeChrome;

beforeEach(() => {
  chromeApi = installFakeChrome();
});

describe("findTargetTab", () => {
  it("takes the active tab of the last focused window when the popup has no ?tab", async () => {
    chromeApi.tabs.all.set(7, { id: 7, url: JOB, status: "complete", active: true });
    await expect(findTargetTab("")).resolves.toMatchObject({ id: 7, url: JOB });
    expect(chromeApi.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(chromeApi.tabs.get).not.toHaveBeenCalled();

    // Another parameter doesn't count as one.
    await expect(findTargetTab("?view=1")).resolves.toMatchObject({ id: 7 });
    expect(chromeApi.tabs.query).toHaveBeenCalledTimes(2);
  });

  it("finds no tab when Chrome names none, or one without an id", async () => {
    await expect(findTargetTab("")).resolves.toBeNull();
    // A tab outside any window (devtools, say) has no id.
    chromeApi.tabs.query.mockResolvedValueOnce([{ active: true, url: JOB }]);
    await expect(findTargetTab("")).resolves.toBeNull();
  });

  it("takes the tab named by ?tab=<id>, and only that one", async () => {
    chromeApi.tabs.all.set(7, { id: 7, url: JOB, status: "complete", active: true });
    chromeApi.tabs.all.set(9, { id: 9, url: "https://jobs.example.com/2", status: "complete" });
    await expect(findTargetTab("?tab=9")).resolves.toMatchObject({ id: 9, url: "https://jobs.example.com/2" });
    expect(chromeApi.tabs.get).toHaveBeenCalledWith(9);
    expect(chromeApi.tabs.query).not.toHaveBeenCalled();
  });

  it.each(["?tab=12", "?tab=-1", "?tab=abc", "?tab=1.5", "?tab="])("finds no tab for %j", async (search) => {
    chromeApi.tabs.all.set(7, { id: 7, url: JOB, status: "complete", active: true });
    await expect(findTargetTab(search)).resolves.toBeNull();
    // Never the active tab instead.
    expect(chromeApi.tabs.query).not.toHaveBeenCalled();
  });
});
