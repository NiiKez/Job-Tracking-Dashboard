import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetConnection,
  readConnection,
  readDraft,
  readLastOrigin,
  saveConnection,
  saveDraft,
} from "../../../extension/src/lib/storage";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";

// What the extension remembers, in the shape the plan fixes, and read back with a check.

const connection = {
  origin: "https://tracker.example.com",
  token: `jtx_${"t".repeat(43)}`, // invented
  email: "ada@example.com",
  name: "Ada",
};

let chromeApi: FakeChrome;
beforeEach(() => {
  chromeApi = installFakeChrome();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the connection", () => {
  it("is stored with the last origin, in the plan's shape", async () => {
    await saveConnection(connection);
    expect(chromeApi.storage.local.dump()).toEqual({ connection, lastOrigin: connection.origin });
    await expect(readConnection()).resolves.toEqual(connection);
    await expect(readLastOrigin()).resolves.toBe(connection.origin);
  });

  it("is forgotten only while it still uses the key that failed", async () => {
    await saveConnection(connection);
    await forgetConnection(`jtx_${"x".repeat(43)}`);
    await expect(readConnection()).resolves.toEqual(connection);
    await forgetConnection(connection.token);
    await expect(readConnection()).resolves.toBeNull();
    expect(chromeApi.storage.local.dump()).toEqual({ connection: null, lastOrigin: connection.origin });
  });

  it("reads anything else as no connection", async () => {
    await chromeApi.storage.local.set({ connection: { origin: connection.origin, token: 1 }, lastOrigin: 7 });
    await expect(readConnection()).resolves.toBeNull();
    await expect(readLastOrigin()).resolves.toBeNull();
  });
});

describe("drafts", () => {
  const url = "https://jobs.example.com/1";

  it("come back for the same tab and page only", async () => {
    await saveDraft(7, { url, edits: { title: "Staff Engineer" } });
    await expect(readDraft(7, url)).resolves.toEqual({ title: "Staff Engineer" });
    await expect(readDraft(7, "https://jobs.example.com/2")).resolves.toBeNull();
    await expect(readDraft(8, url)).resolves.toBeNull();
  });

  it("are dropped when nothing differs from the read any more", async () => {
    await saveDraft(7, { url, edits: { title: "Staff Engineer" } });
    await saveDraft(7, { url, edits: {} });
    expect(chromeApi.storage.session.dump()).toEqual({});
  });

  it("are ignored when malformed", async () => {
    await chromeApi.storage.session.set({ "draft:7": { url, edits: { title: 1 } } });
    await expect(readDraft(7, url)).resolves.toBeNull();
  });
});
