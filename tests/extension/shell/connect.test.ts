import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptKey,
  forgetTab,
  injectBridge,
  isConnectPage,
  NOT_FROM_CONNECT_TAB,
  openWhenPermitted,
  PERMISSION_WAIT_MS,
  startConnect,
} from "../../../extension/src/lib/connect";
import { EXTENSION_ID, installFakeChrome, type FakeChrome } from "./fake-chrome";

// The service worker's side of Connect (docs/plan/4-chrome-extension.md, Connect flow), with a
// fake chrome API: when the connect tab opens, where the bridge goes, which sender may hand
// over a key, and what is stored and revoked then.

const ORIGIN = "https://tracker.example.com";
const PATTERN = `${ORIGIN}/*`;
const TOKEN = `jtx_${"k".repeat(43)}`; // invented
const OLD_TOKEN = `jtx_${"o".repeat(43)}`;

let chromeApi: FakeChrome;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  chromeApi = installFakeChrome();
  fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
    init.method === "DELETE"
      ? Response.json({ ok: true })
      : Response.json({ email: "ada@example.com", name: "Ada", latestVersion: "1.0.0" }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const pending = async () => (await chromeApi.storage.session.get("connect")).connect as
  | { origin: string; tabId: number | null; startedAt: number }
  | undefined;

/** A Connect in progress with the connect tab open, as after startConnect with the permission. */
async function connecting() {
  chromeApi.permissions.granted.add(PATTERN);
  await startConnect(ORIGIN);
  return (await pending())!.tabId!;
}

function sender(tabId: number, over: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return {
    id: EXTENSION_ID,
    tab: { id: tabId } as chrome.tabs.Tab,
    frameId: 0,
    url: `${ORIGIN}/extension/connect`,
    origin: ORIGIN,
    ...over,
  };
}

describe("opening the connect tab", () => {
  it("opens it at once when the origin is already allowed", async () => {
    chromeApi.permissions.granted.add(PATTERN);
    await expect(startConnect("tracker.example.com/")).resolves.toEqual({ ok: true });
    expect(chromeApi.tabs.create).toHaveBeenCalledWith({ url: `${ORIGIN}/extension/connect` });
    expect(await pending()).toMatchObject({ origin: ORIGIN, tabId: 100 });
  });

  it("waits for Chrome's prompt, then opens it when the permission arrives", async () => {
    await expect(startConnect(ORIGIN)).resolves.toEqual({ ok: true });
    expect(chromeApi.tabs.create).not.toHaveBeenCalled();
    expect(await pending()).toMatchObject({ origin: ORIGIN, tabId: null });

    await openWhenPermitted(); // another permission was added: still not this one
    expect(chromeApi.tabs.create).not.toHaveBeenCalled();

    chromeApi.permissions.granted.add(PATTERN);
    await openWhenPermitted();
    expect(chromeApi.tabs.create).toHaveBeenCalledTimes(1);
    expect(await pending()).toMatchObject({ origin: ORIGIN, tabId: 100 });

    await openWhenPermitted(); // the tab is open: a later permission event opens no second one
    expect(chromeApi.tabs.create).toHaveBeenCalledTimes(1);
  });

  it("forgets a prompt left unanswered for too long", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await startConnect(ORIGIN);
    now.mockReturnValue(1_000_000 + PERMISSION_WAIT_MS + 1);
    chromeApi.permissions.granted.add(PATTERN);
    await openWhenPermitted();
    expect(chromeApi.tabs.create).not.toHaveBeenCalled();
  });

  it("refuses an address Connect would refuse, and starts nothing", async () => {
    await expect(startConnect("http://tracker.example.com")).resolves.toEqual({
      ok: false,
      error: "Use https. Plain http works only for localhost and 127.0.0.1.",
    });
    expect(await pending()).toBeUndefined();
  });

  it("opens one tab when Connect is sent twice at once", async () => {
    chromeApi.permissions.granted.add(PATTERN);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await Promise.all([startConnect(ORIGIN), startConnect(ORIGIN)]);
    expect(chromeApi.tabs.create).toHaveBeenCalledTimes(1);
    expect(await pending()).toEqual({ origin: ORIGIN, tabId: 100, startedAt: 1_000_000 });

    // The same a few milliseconds apart: the later Connect replaced the earlier before its tab opened.
    chromeApi.tabs.create.mockClear();
    await chromeApi.storage.session.remove("connect");
    now.mockReturnValueOnce(2_000_000).mockReturnValueOnce(2_000_005);
    await Promise.all([startConnect(ORIGIN), startConnect(ORIGIN)]);
    expect(chromeApi.tabs.create).toHaveBeenCalledTimes(1);
    expect(await pending()).toEqual({ origin: ORIGIN, tabId: 101, startedAt: 2_000_005 });
  });

  it("opens one tab when Chrome reports the permission while Connect checks it", async () => {
    chromeApi.permissions.granted.add(PATTERN);
    await Promise.all([startConnect(ORIGIN), openWhenPermitted()]);
    expect(chromeApi.tabs.create).toHaveBeenCalledTimes(1);
  });

  it("gives the tab being opened to a Connect for the same address clicked meanwhile", async () => {
    chromeApi.permissions.granted.add(PATTERN);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    let release!: () => void;
    const create = chromeApi.tabs.create.getMockImplementation()!;
    chromeApi.tabs.create.mockImplementationOnce(async (properties) => {
      await new Promise<void>((resolve) => (release = resolve));
      return create(properties);
    });
    const first = startConnect(ORIGIN);
    await vi.waitFor(() => expect(chromeApi.tabs.create).toHaveBeenCalledTimes(1));

    now.mockReturnValue(1_000_300);
    const second = startConnect(ORIGIN);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(chromeApi.tabs.create).toHaveBeenCalledTimes(1);
    expect(await pending()).toEqual({ origin: ORIGIN, tabId: 100, startedAt: 1_000_300 });
  });

  it("keeps the time Connect was clicked once the tab is open", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await startConnect(ORIGIN);
    now.mockReturnValue(1_000_000 + 60_000);
    chromeApi.permissions.granted.add(PATTERN);
    await openWhenPermitted();
    expect(await pending()).toEqual({ origin: ORIGIN, tabId: 100, startedAt: 1_000_000 });
  });

  it("injects the bridge when the page finished loading before the tab id was stored", async () => {
    chromeApi.tabs.create.mockImplementationOnce(async ({ url }: { url: string }) => {
      chromeApi.tabs.all.set(100, { id: 100, url, status: "complete" });
      return { id: 100, url, status: "loading" };
    });
    await connecting();
    expect(chromeApi.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 100 }, files: ["connect-bridge.js"] });
  });
});

describe("injecting the bridge", () => {
  it("only into the connect tab, on the connect page of the origin being connected", async () => {
    const tabId = await connecting();
    await injectBridge(tabId + 1, `${ORIGIN}/extension/connect`);
    await injectBridge(tabId, `${ORIGIN}/login?next=/extension/connect`);
    await injectBridge(tabId, "https://accounts.example.com/extension/connect");
    await injectBridge(tabId, undefined);
    expect(chromeApi.scripting.executeScript).not.toHaveBeenCalled();

    await injectBridge(tabId, `${ORIGIN}/extension/connect?from=login`);
    expect(chromeApi.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId }, files: ["connect-bridge.js"] });
  });

  it("does nothing without a Connect in progress, and survives a tab that moved on", async () => {
    await injectBridge(100, `${ORIGIN}/extension/connect`);
    expect(chromeApi.scripting.executeScript).not.toHaveBeenCalled();

    const tabId = await connecting();
    chromeApi.scripting.executeScript.mockRejectedValueOnce(new Error("Frame with ID 0 was removed."));
    await expect(injectBridge(tabId, `${ORIGIN}/extension/connect`)).resolves.toBeUndefined();
  });

  it("recognises the connect page exactly", () => {
    expect(isConnectPage(`${ORIGIN}/extension/connect`, ORIGIN)).toBe(true);
    expect(isConnectPage(`${ORIGIN}/extension/connect/`, ORIGIN)).toBe(false);
    expect(isConnectPage(`${ORIGIN}/extension/connection`, ORIGIN)).toBe(false);
    expect(isConnectPage(`${ORIGIN}:8443/extension/connect`, ORIGIN)).toBe(false);
    expect(isConnectPage("not a url", ORIGIN)).toBe(false);
  });
});

describe("accepting the key", () => {
  it("checks it with the tracker, stores the connection and ends the Connect", async () => {
    const tabId = await connecting();
    await expect(acceptKey(TOKEN, sender(tabId))).resolves.toEqual({ ok: true, email: "ada@example.com" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/api/extension/session`);
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(chromeApi.storage.local.dump()).toEqual({
      connection: { origin: ORIGIN, token: TOKEN, email: "ada@example.com", name: "Ada" },
      lastOrigin: ORIGIN,
    });
    expect(await pending()).toBeUndefined();
    // The Connect is over: the same key again is not taken.
    await expect(acceptKey(TOKEN, sender(tabId))).resolves.toEqual({ ok: false, error: NOT_FROM_CONNECT_TAB });
  });

  it.each([
    ["another tab", (tabId: number) => sender(tabId + 1)],
    ["a frame inside the page", (tabId: number) => sender(tabId, { frameId: 3 })],
    ["another page of the tracker", (tabId: number) => sender(tabId, { url: `${ORIGIN}/settings` })],
    ["another site in the tab", (tabId: number) => sender(tabId, { url: "https://evil.example/extension/connect", origin: "https://evil.example" })],
    ["another extension", (tabId: number) => sender(tabId, { id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" })],
    ["the extension's own pages", (tabId: number) => sender(tabId, { url: `chrome-extension://${EXTENSION_ID}/popup.html`, origin: `chrome-extension://${EXTENSION_ID}` })],
  ])("refuses a key from %s, without asking the tracker", async (_, from) => {
    const tabId = await connecting();
    await expect(acceptKey(TOKEN, from(tabId))).resolves.toEqual({ ok: false, error: NOT_FROM_CONNECT_TAB });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chromeApi.storage.local.dump()).toEqual({});
  });

  it("refuses a key while Chrome still asks for the permission (no tab yet)", async () => {
    await startConnect(ORIGIN);
    await expect(acceptKey(TOKEN, sender(100))).resolves.toEqual({ ok: false, error: NOT_FROM_CONNECT_TAB });
  });

  it.each(["", "jtx_short", `jtx_${"k".repeat(44)}`, `xyz_${"k".repeat(43)}`, `jtx_${"k".repeat(42)}=`])(
    "refuses a malformed key %j",
    async (token) => {
      const tabId = await connecting();
      const reply = await acceptKey(token, sender(tabId));
      expect(reply).toEqual({ ok: false, error: "The page sent a key the extension can't use. Try again." });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("stores nothing when the tracker refuses the key or can't be reached", async () => {
    const tabId = await connecting();
    // The key routes' 401, as the tracker sends it.
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "Not signed in" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } }),
    );
    await expect(acceptKey(TOKEN, sender(tabId))).resolves.toEqual({
      ok: false,
      error: "The tracker didn't accept the new key. Try again.",
    });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(acceptKey(TOKEN, sender(tabId))).resolves.toEqual({
      ok: false,
      error: "Couldn't reach tracker.example.com. Check your connection, then try again.",
    });
    expect(chromeApi.storage.local.dump()).toEqual({});
    // The Connect stays open: the page can try again.
    expect(await pending()).toMatchObject({ tabId });
  });

  it("revokes this browser's earlier key for the same tracker, and only for it", async () => {
    await chromeApi.storage.local.set({
      connection: { origin: ORIGIN, token: OLD_TOKEN, email: "ada@example.com", name: "Ada" },
    });
    const tabId = await connecting();
    await acceptKey(TOKEN, sender(tabId));
    const revoke = fetchMock.mock.calls.find(([, init]) => init.method === "DELETE");
    expect(revoke?.[0]).toBe(`${ORIGIN}/api/extension/session`);
    expect(revoke?.[1].headers).toMatchObject({ Authorization: `Bearer ${OLD_TOKEN}` });

    fetchMock.mockClear();
    await chromeApi.storage.local.set({
      connection: { origin: "https://other.example.com", token: OLD_TOKEN, email: "ada@example.com", name: "Ada" },
    });
    const next = await connecting();
    await acceptKey(TOKEN, sender(next));
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["GET"]);
  });

  it("answers the page without waiting for the old key's revocation", async () => {
    await chromeApi.storage.local.set({
      connection: { origin: ORIGIN, token: OLD_TOKEN, email: "ada@example.com", name: "Ada" },
    });
    const tabId = await connecting();
    // The tracker never answers the DELETE.
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      init.method === "DELETE"
        ? new Promise<Response>(() => {})
        : Response.json({ email: "ada@example.com", name: "Ada", latestVersion: null }),
    );
    await expect(acceptKey(TOKEN, sender(tabId))).resolves.toEqual({ ok: true, email: "ada@example.com" });
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "DELETE"]);
    expect(chromeApi.storage.local.dump().connection).toMatchObject({ token: TOKEN });
  });

  it("leaves a Connect started while the key was being checked in place", async () => {
    const tabId = await connecting();
    let answer!: () => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answer = () => resolve(Response.json({ email: "ada@example.com", name: "Ada", latestVersion: null }));
        }),
    );
    const accepted = acceptKey(TOKEN, sender(tabId));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Connect is clicked again (another popup) while the tracker checks the first tab's key.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    await startConnect(ORIGIN);
    const next = (await pending())!;
    expect(next.tabId).not.toBe(tabId);

    answer();
    await expect(accepted).resolves.toEqual({ ok: true, email: "ada@example.com" });
    expect(chromeApi.storage.local.dump().connection).toMatchObject({ token: TOKEN });
    expect(await pending()).toEqual(next);
  });

  it("keeps the new connection when revoking the old key fails", async () => {
    await chromeApi.storage.local.set({
      connection: { origin: ORIGIN, token: OLD_TOKEN, email: "ada@example.com", name: "Ada" },
    });
    const tabId = await connecting();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.method === "DELETE") throw new TypeError("Failed to fetch");
      return Response.json({ email: "ada@example.com", name: "Ada", latestVersion: null });
    });
    await expect(acceptKey(TOKEN, sender(tabId))).resolves.toEqual({ ok: true, email: "ada@example.com" });
    expect(chromeApi.storage.local.dump().connection).toMatchObject({ token: TOKEN });
  });
});

describe("closing a tab", () => {
  it("ends the Connect of that tab and drops its popup draft", async () => {
    const tabId = await connecting();
    await chromeApi.storage.session.set({ [`draft:${tabId}`]: { url: "https://jobs.example.com/1", edits: { title: "x" } } });
    await forgetTab(tabId + 1);
    expect(await pending()).toMatchObject({ tabId });
    await forgetTab(tabId);
    expect(chromeApi.storage.session.dump()).toEqual({});
  });
});
