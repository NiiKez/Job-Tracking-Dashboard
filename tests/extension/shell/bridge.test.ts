// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The connect bridge in a page at the tracker's /extension/connect: the window protocol of
// docs/plan/4-chrome-extension.md, which messages it takes, that a second injection into the same
// page changes nothing, and what it says once its extension was reloaded, updated or removed.

const ORIGIN = "https://tracker.example.com";
const TOKEN = `jtx_${"k".repeat(43)}`; // invented

const sendMessage = vi.fn();
/** The bridge's chrome.runtime. Chrome takes `id` away once the extension is reloaded, updated or removed. */
const runtime: { id?: string; getManifest: () => { version: string }; sendMessage: typeof sendMessage } = {
  id: "abcdefghijklmnopabcdefghijklmnop",
  getManifest: () => ({ version: "1.0.0" }),
  sendMessage,
};
const fromBridge: Array<Record<string, unknown>> = [];

/** Lets happy-dom deliver the posted messages (it dispatches them on a timer). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * A message from the page, as a browser delivers it: from this window, at this origin. (happy-dom's
 * own postMessage names another object as the source, so the event is made here.)
 */
const message = (data: unknown, origin = ORIGIN, source: Window | null = window) =>
  window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
const fromApp = (data: Record<string, unknown>) => message({ source: "job-tracker-app", ...data });

async function injectBridge() {
  vi.resetModules();
  await import("../../../extension/src/connect-bridge");
}

beforeAll(async () => {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`${ORIGIN}/extension/connect`);
  vi.stubGlobal("chrome", { runtime });
  window.addEventListener("message", (event) => {
    if (event.data?.source === "job-tracker-extension") fromBridge.push(event.data);
  });
  await injectBridge();
  await settle();
});

beforeEach(() => {
  sendMessage.mockReset();
});

describe("connect bridge", () => {
  it("says ready when it arrives, and again on the page's hello", async () => {
    expect(fromBridge).toEqual([{ source: "job-tracker-extension", type: "ready", version: "1.0.0" }]);
    fromApp({ type: "hello" });
    await settle();
    expect(fromBridge.at(-1)).toEqual({ source: "job-tracker-extension", type: "ready", version: "1.0.0" });
    expect(fromBridge).toHaveLength(2);
  });

  it("does nothing more when injected a second time", async () => {
    const before = fromBridge.length;
    await injectBridge();
    await settle();
    expect(fromBridge).toHaveLength(before); // no second "ready"
    fromApp({ type: "hello" });
    await settle();
    expect(fromBridge).toHaveLength(before + 1); // one listener, one answer
  });

  it("hands the key to the service worker and passes on the account", async () => {
    sendMessage.mockResolvedValue({ ok: true, email: "ada@example.com" });
    fromApp({ type: "key", token: TOKEN, keyId: "k1" });
    await settle();
    expect(sendMessage).toHaveBeenCalledWith({ type: "connect-key", token: TOKEN });
    expect(fromBridge.at(-1)).toEqual({ source: "job-tracker-extension", type: "connected", email: "ada@example.com" });
  });

  it("passes on a refusal, and says so when the extension doesn't answer", async () => {
    sendMessage.mockResolvedValueOnce({ ok: false, error: "The tracker didn't accept the new key. Try again." });
    fromApp({ type: "key", token: TOKEN });
    await settle();
    expect(fromBridge.at(-1)).toEqual({
      source: "job-tracker-extension",
      type: "failed",
      error: "The tracker didn't accept the new key. Try again.",
    });

    sendMessage.mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."));
    fromApp({ type: "key", token: TOKEN });
    await settle();
    expect(fromBridge.at(-1)).toMatchObject({ type: "failed", error: "The extension didn't answer. Reload this page and try again." });

    sendMessage.mockResolvedValueOnce(undefined);
    fromApp({ type: "key", token: TOKEN });
    await settle();
    expect(fromBridge.at(-1)).toMatchObject({ type: "failed", error: "The extension didn't answer. Try again." });
  });

  it("ignores messages from another origin, another window, or not from the app", async () => {
    const key = { source: "job-tracker-app", type: "key", token: TOKEN };
    message(key, "https://evil.example");
    message(key, ORIGIN, null);
    message({ ...key, source: "someone-else" });
    message({ source: "job-tracker-app", type: "key" });
    message(JSON.stringify(key));
    await settle();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("a bridge whose extension was reloaded, updated or removed", () => {
  const GONE = "The extension was updated or removed. Open it and click Connect again.";

  it("says so when handing over the key throws, so the page deletes the key", async () => {
    // Chrome throws at once, before any promise, in a content script whose extension went away.
    sendMessage.mockImplementationOnce(() => {
      throw new Error("Extension context invalidated.");
    });
    fromApp({ type: "key", token: TOKEN });
    await settle();
    expect(fromBridge.at(-1)).toEqual({ source: "job-tracker-extension", type: "failed", error: GONE });
  });

  it("no longer says ready, and fails a key without trying to send it", async () => {
    const id = runtime.id;
    delete runtime.id;
    try {
      const before = fromBridge.length;
      fromApp({ type: "hello" });
      await settle();
      expect(fromBridge).toHaveLength(before);

      fromApp({ type: "key", token: TOKEN });
      await settle();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(fromBridge.at(-1)).toEqual({ source: "job-tracker-extension", type: "failed", error: GONE });
    } finally {
      runtime.id = id;
    }
  });
});
