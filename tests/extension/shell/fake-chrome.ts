import { vi } from "vitest";

/*
 * Just enough of the `chrome` extension API for the extension's lib code to run in Vitest:
 * storage (local and session, in memory), permissions, tabs, scripting and runtime. Each test
 * installs a fresh one with installFakeChrome() and looks at what was called.
 *
 * tabs.query knows no windows: it answers every tab marked `active`, whatever is asked.
 */

export const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

function area() {
  let data: Record<string, unknown> = {};
  return {
    dump: () => structuredClone(data),
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys === undefined || keys === null) return structuredClone(data);
      const wanted = Array.isArray(keys) ? keys : [keys];
      return structuredClone(Object.fromEntries(wanted.filter((k) => k in data).map((k) => [k, data[k]])));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = { ...data, ...structuredClone(items) };
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }),
  };
}

interface FakeTab {
  id: number;
  url?: string;
  status?: string;
  active?: boolean;
}

export function installFakeChrome() {
  const granted = new Set<string>();
  const tabs = new Map<number, FakeTab>();
  let nextTabId = 100;

  const fake = {
    storage: { local: area(), session: area() },
    permissions: {
      granted,
      contains: vi.fn(async ({ origins = [] }: { origins?: string[] }) => origins.every((o) => granted.has(o))),
    },
    tabs: {
      all: tabs,
      create: vi.fn(async ({ url }: { url: string }) => {
        const tab = { id: nextTabId++, url, status: "loading" };
        tabs.set(tab.id, tab);
        return { ...tab };
      }),
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return { ...tab };
      }),
      query: vi.fn<(query: chrome.tabs.QueryInfo) => Promise<Array<Partial<FakeTab>>>>(async () =>
        [...tabs.values()].filter((tab) => tab.active).map((tab) => ({ ...tab })),
      ),
    },
    scripting: {
      executeScript: vi.fn<(injection: { target: { tabId: number }; files?: string[] }) => Promise<Array<{ result: unknown }>>>(
        async () => [{ result: undefined }],
      ),
    },
    runtime: {
      id: EXTENSION_ID,
      getURL: (p: string) => `chrome-extension://${EXTENSION_ID}/${p}`,
    },
  };
  vi.stubGlobal("chrome", fake);
  return fake;
}

export type FakeChrome = ReturnType<typeof installFakeChrome>;
