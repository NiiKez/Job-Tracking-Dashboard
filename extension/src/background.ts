import { acceptKey, forgetTab, injectBridge, openWhenPermitted, startConnect } from "./lib/connect";
import { isConnectRequest, isKeyMessage } from "./lib/messages";

/*
 * The service worker: the Connect flow (lib/connect.ts) and nothing else. It holds no state of
 * its own and runs only while an event is handled; Chrome stops it when idle and starts it
 * again for the next event, so every listener is registered here, at the top level, on each start.
 */

// The key in chrome.storage.local is for this worker and the extension's pages only. Content
// scripts (the connect bridge, the page reader) never use storage, so they get no access to it:
// a page that compromised its renderer must not reach the key through them. Chrome keeps the
// setting across restarts; a version that doesn't offer it for `local` keeps its default.
try {
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => undefined);
} catch {
  // Not available in this version of Chrome.
}

/** Pages of this extension (the popup, also when opened as a tab); a content script's sender.url is its page. */
function isExtensionPage(sender: chrome.runtime.MessageSender) {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isConnectRequest(message) && isExtensionPage(sender)) {
    startConnect(message.origin).then(sendResponse, () =>
      sendResponse({ ok: false, error: "The extension couldn't open the tracker. Try again." }),
    );
    return true; // answers asynchronously
  }
  if (isKeyMessage(message)) {
    // acceptKey checks the sender: the bridge in the connect tab, and only that.
    acceptKey(message.token, sender).then(sendResponse, () =>
      sendResponse({ ok: false, error: "The extension couldn't store the key. Try again." }),
    );
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "complete") void injectBridge(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));

chrome.permissions.onAdded.addListener(() => void openWhenPermitted());
