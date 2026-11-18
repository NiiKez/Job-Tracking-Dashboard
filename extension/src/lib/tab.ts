import type { PageSnapshot } from "@/lib/types";
import { isPageSnapshot } from "./messages";
import { normalizeOrigin } from "./origin";

/*
 * The tab the popup works on, and what it can read there. Clicking the toolbar icon (or
 * Alt+Shift+J) grants activeTab for that tab, which is what lets the popup see its address and
 * run a script in it; nothing is read from any other tab.
 */

/** The tab with its id, as chrome.tabs returns it. */
export type TargetTab = chrome.tabs.Tab & { id: number };

/**
 * The active tab of the last focused window: the page the popup was opened over. When popup.html
 * is opened as a page with `?tab=<id>` (the end-to-end tests do), that tab instead.
 */
export async function findTargetTab(search: string): Promise<TargetTab | null> {
  const param = new URLSearchParams(search).get("tab");
  let tab: chrome.tabs.Tab | undefined;
  if (param !== null) {
    const id = Number(param);
    if (!Number.isSafeInteger(id) || id < 0) return null;
    tab = await chrome.tabs.get(id).catch(() => undefined);
  } else {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
  return tab?.id === undefined ? null : (tab as TargetTab);
}

/** The tab's address when it is a web page (http or https); null for chrome://, file:// and the like. */
export function webAddress(tab: chrome.tabs.Tab): string | null {
  const url = tab.url;
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Injects page/read-page.js, then calls the `__jobTrackerReadPage` it sets on the extension's
 * isolated world of the page, and returns the snapshot that made. Null for a page Chrome doesn't
 * let extensions script (chrome://, the Web Store, the PDF viewer, file://, an error page).
 */
export async function readTab(tab: TargetTab): Promise<PageSnapshot | null> {
  if (!webAddress(tab)) return null;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["page/read-page.js"] });
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // Runs in the page: only what is written here travels, so the name is looked up there.
      func: () =>
        (globalThis as unknown as { __jobTrackerReadPage?: () => unknown }).__jobTrackerReadPage?.() ?? null,
    });
    const result: unknown = frame?.result;
    return isPageSnapshot(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * The tab's origin when it shows the tracker itself (its pages carry
 * `<meta name="job-tracker" content="app">`) at an address Connect accepts; else null.
 */
export async function trackerOriginOf(tab: TargetTab): Promise<string | null> {
  const url = webAddress(tab);
  if (!url) return null;
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.querySelector('meta[name="job-tracker"]')?.getAttribute("content") === "app",
    });
    if (frame?.result !== true) return null;
    const checked = normalizeOrigin(new URL(url).origin);
    return checked.ok ? checked.origin : null;
  } catch {
    return null;
  }
}
