import type { ExtensionSession } from "@/lib/types";
import { ApiError, createApi, failureMessage } from "./api";
import type { ConnectReply, KeyReply } from "./messages";
import { normalizeOrigin, originPattern } from "./origin";
import {
  clearDraft,
  clearPendingConnect,
  readConnection,
  readPendingConnect,
  saveConnection,
  savePendingConnect,
  type PendingConnect,
} from "./storage";

/*
 * The Connect flow, run by the service worker (docs/plan/4-chrome-extension.md, Connect flow):
 *
 * 1. The popup's Connect asks Chrome for the tracker's origin and, in the same click, sends
 *    { type: "connect", origin } here (startConnect). The tab opens as soon as the permission
 *    is there: at once when it already was, else when Chrome reports it granted
 *    (openWhenPermitted). The popup may already be gone by then: Chrome's permission prompt
 *    can close it, so the popup's own promise is not relied on. A Connect replaces any earlier
 *    one, and opens one tab however often it is sent (openConnectTab).
 * 2. Each time that tab finishes loading <origin>/extension/connect, connect-bridge.js is
 *    injected (injectBridge). Signed out, the tab passes through /login first.
 * 3. The page makes a key and hands it to the bridge, which sends { type: "connect-key", token }
 *    here (acceptKey). It is taken only from that tab, at that address, in its top frame. The key
 *    is checked against GET /api/extension/session, stored, and the bridge is told the account.
 *
 * Nothing is kept in variables between events: the worker is stopped when idle, so the flow lives
 * in chrome.storage.session (storage.ts). The one variable, `opening`, only puts the tab openings
 * of one run of the worker in a row.
 */

const CONNECT_PATH = "/extension/connect";

/** How long a Connect waits for Chrome's permission prompt to be answered. */
export const PERMISSION_WAIT_MS = 5 * 60_000;

/** jtx_ and 32 bytes in base64url: the shape of a key, checked again by the tracker. */
const KEY_FORMAT = /^jtx_[A-Za-z0-9_-]{43}$/;

export const NOT_FROM_CONNECT_TAB =
  "Open this page from the extension: click its Connect button, and use the tab it opens.";

/**
 * The tab openings in flight, one after the other. Each reads the stored Connect, opens the tab
 * and stores its id; two at once would both find no tab and open one each. A worker that was
 * stopped and started again has none in flight, so memory is enough here.
 */
let opening: Promise<void> = Promise.resolve();

function hasPermission(origin: string) {
  return chrome.permissions.contains({ origins: [originPattern(origin)] });
}

/** True for <origin>/extension/connect (any query), the only page the bridge goes into. */
export function isConnectPage(url: string | undefined, origin: string) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && parsed.pathname === CONNECT_PATH;
  } catch {
    return false;
  }
}

export async function startConnect(rawOrigin: string): Promise<ConnectReply> {
  const checked = normalizeOrigin(rawOrigin);
  if (!checked.ok) return { ok: false, error: checked.error };
  const startedAt = Date.now();
  // Stored before any tab opens: a Connect sent a moment earlier (a second popup, a double
  // click) that hasn't opened its tab yet then opens none.
  await savePendingConnect({ origin: checked.origin, tabId: null, startedAt });
  await openConnectTab(startedAt);
  return { ok: true };
}

/** chrome.permissions.onAdded: the prompt of a Connect in progress was answered with Allow. */
export async function openWhenPermitted() {
  const pending = await readPendingConnect();
  if (!pending || pending.tabId !== null || Date.now() - pending.startedAt > PERMISSION_WAIT_MS) return;
  await openConnectTab(pending.startedAt);
}

/**
 * Opens the connect tab of the Connect clicked at `startedAt` when it is still the stored one,
 * has no tab yet and has the permission. startConnect and the permission event can both get here
 * for the same Connect, and Connect can be sent twice, so the calls run one after the other
 * (opening).
 */
function openConnectTab(startedAt: number): Promise<void> {
  const run = opening.then(() => openTab(startedAt));
  opening = run.catch(() => undefined);
  return run;
}

async function openTab(startedAt: number) {
  const pending = await readPendingConnect();
  if (pending?.startedAt !== startedAt || pending.tabId !== null) return;
  if (!(await hasPermission(pending.origin))) return;
  const tab = await chrome.tabs.create({ url: `${pending.origin}${CONNECT_PATH}` });
  if (tab.id === undefined) return;
  // Connect may have been sent again while the tab opened. For the same address, that Connect
  // takes this tab rather than opening a second; one for another address opens its own.
  const current = await readPendingConnect();
  if (!current || current.origin !== pending.origin || current.tabId !== null) return;
  await savePendingConnect({ ...current, tabId: tab.id });
  // A fast load can finish before the tab id was stored, and tabs.onUpdated skipped it then.
  const loaded = await chrome.tabs.get(tab.id).catch(() => null);
  if (loaded?.status === "complete") await injectBridge(tab.id, loaded.url);
}

/** tabs.onUpdated with status "complete": puts the bridge into the connect tab's page. */
export async function injectBridge(tabId: number, url: string | undefined) {
  const pending = await readPendingConnect();
  if (!pending || pending.tabId !== tabId || !isConnectPage(url, pending.origin)) return;
  // Fails when the tab moved on meanwhile; its next complete load comes through here again.
  await chrome.scripting
    .executeScript({ target: { tabId }, files: ["connect-bridge.js"] })
    .catch(() => undefined);
}

/** True when the message came from the bridge in the tab this Connect opened, on its connect page. */
function isFromConnectTab(sender: chrome.runtime.MessageSender, pending: PendingConnect) {
  return (
    sender.id === chrome.runtime.id &&
    pending.tabId !== null &&
    sender.tab?.id === pending.tabId &&
    sender.frameId === 0 &&
    sender.origin === pending.origin &&
    isConnectPage(sender.url, pending.origin)
  );
}

export async function acceptKey(token: string, sender: chrome.runtime.MessageSender): Promise<KeyReply> {
  const pending = await readPendingConnect();
  if (!pending || !isFromConnectTab(sender, pending)) return { ok: false, error: NOT_FROM_CONNECT_TAB };
  if (!KEY_FORMAT.test(token)) return { ok: false, error: "The page sent a key the extension can't use. Try again." };

  const { origin } = pending;
  let account: ExtensionSession;
  try {
    account = await createApi({ origin, token }).session();
  } catch (error) {
    const refused = error instanceof ApiError && error.kind === "disconnected";
    return { ok: false, error: refused ? "The tracker didn't accept the new key. Try again." : failureMessage(error) };
  }

  const previous = await readConnection();
  await saveConnection({ origin, token, email: account.email, name: account.name });
  // This Connect is over. One started while the key was checked (Connect clicked again) is
  // another entry by now, and stays.
  const current = await readPendingConnect();
  if (current?.tabId === pending.tabId && current.startedAt === pending.startedAt) await clearPendingConnect();
  // This browser's earlier key for the same tracker is replaced: revoke it, so Settings lists
  // the browser once. Not awaited: the page is told at once (it gives up 30 s after its click,
  // and this is another request of up to 15 s). Best effort: an unknown key is gone anyway.
  if (previous && previous.origin === origin && previous.token !== token) {
    void createApi(previous).revoke().catch(() => undefined);
  }
  return { ok: true, email: account.email };
}

/** tabs.onRemoved: a closed tab ends its Connect and drops its popup draft. */
export async function forgetTab(tabId: number) {
  const pending = await readPendingConnect();
  if (pending?.tabId === tabId) await clearPendingConnect();
  await clearDraft(tabId);
}
