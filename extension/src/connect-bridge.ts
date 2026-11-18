import {
  EXTENSION_SOURCE,
  isAppMessage,
  isKeyReply,
  type BridgeMessage,
  type KeyMessage,
} from "./lib/messages";

/*
 * Injected by the service worker into the tracker's /extension/connect page, in the extension's
 * isolated world, on each load of that page in the tab Connect opened. It carries the page's
 * messages to the service worker and the answers back (docs/plan/4-chrome-extension.md):
 *
 *   bridge → page  { source: "job-tracker-extension", type: "ready", version }  at once, and on "hello"
 *   page → bridge  { source: "job-tracker-app", type: "key", token }            the key the page made
 *   bridge → page  { type: "connected", email } or { type: "failed", error }
 *
 * Messages are posted to this page's own origin only, and taken only from this window and this
 * origin. The service worker checks the sender again before it uses the key.
 *
 * Injecting it twice into the same page (the worker may) must not answer twice: the second run
 * sees the flag the first set and does nothing.
 *
 * Once the extension is reloaded, updated or removed, this script stays in the page cut off from
 * it: chrome.runtime.id is gone and sendMessage throws at once. It then no longer says "ready",
 * and answers a key with "failed", so the page deletes the key it made instead of waiting and
 * keeping a key nobody holds.
 */

/** Each kind of message without its `source`, which post() adds. */
type WithoutSource<M> = M extends unknown ? Omit<M, "source"> : never;

const FLAG = "__jobTrackerConnectBridge";
const GONE = "The extension was updated or removed. Open it and click Connect again.";
const scope = globalThis as unknown as Record<string, unknown>;

if (!scope[FLAG]) {
  scope[FLAG] = true;

  const version = chrome.runtime.getManifest().version;
  const post = (message: WithoutSource<BridgeMessage>) =>
    window.postMessage({ source: EXTENSION_SOURCE, ...message }, location.origin);

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data: unknown = event.data;
    if (!isAppMessage(data)) return;
    const connected = !!chrome.runtime?.id;
    if (data.type === "hello") {
      if (connected) post({ type: "ready", version });
      return;
    }
    if (!connected) {
      post({ type: "failed", error: GONE });
      return;
    }
    const message: KeyMessage = { type: "connect-key", token: data.token };
    let sent: Promise<unknown>;
    try {
      sent = chrome.runtime.sendMessage(message);
    } catch {
      // "Extension context invalidated.": the extension went away since the check above.
      post({ type: "failed", error: GONE });
      return;
    }
    sent.then(
      (reply: unknown) => {
        if (!isKeyReply(reply)) post({ type: "failed", error: "The extension didn't answer. Try again." });
        else if (reply.ok) post({ type: "connected", email: reply.email });
        else post({ type: "failed", error: reply.error });
      },
      () => post({ type: "failed", error: "The extension didn't answer. Reload this page and try again." }),
    );
  });

  post({ type: "ready", version });
}
