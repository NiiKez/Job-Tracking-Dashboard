import { afterEach, describe, expect, it, vi } from "vitest";
import { api, EXTENSION_DOWNLOAD_HREF, INBOX_CONNECT_HREF } from "@/lib/api/client";
import { INBOX_POLL_MS, isInboxBusy } from "@/lib/api/hooks";
import type { Settings } from "@/lib/types";

// src/lib/api/client.ts: an id goes into the request path as one encoded segment, so an id taken
// from the page URL (/jobs/..%2Fsettings gives "../settings") cannot reach another endpoint.

const ORIGIN = "https://jobs.example.com";

/** Stubs fetch with a 200 JSON answer; returns what the client asked for. */
function captureFetch() {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ url: input, method: init?.method ?? "GET" });
      return Response.json({});
    }),
  );
  return calls;
}

/** The path the browser would request: fetch resolves ".." and "." segments. */
const resolvedPath = (url: string) => new URL(url, ORIGIN).pathname;

describe("api client paths", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const HOSTILE = ["../settings", "../../api/settings", "a/b", "x?y=1#z", "%2E%2E", "a b"];

  it.each(HOSTILE)("keeps the id %j in one segment of every request path", async (id) => {
    const calls = captureFetch();
    await api.jobs.get(id);
    await api.jobs.update(id, { title: "x" });
    await api.jobs.remove(id);
    await api.emails.resolve(id, { action: "dismiss" });
    await api.rules.remove(id);
    await api.extension.revokeKey(id);

    const segment = encodeURIComponent(id);
    expect(calls).toEqual([
      { url: `/api/jobs/${segment}`, method: "GET" },
      { url: `/api/jobs/${segment}`, method: "PATCH" },
      { url: `/api/jobs/${segment}`, method: "DELETE" },
      { url: `/api/emails/${segment}/resolve`, method: "POST" },
      { url: `/api/rules/${segment}`, method: "DELETE" },
      { url: `/api/extension/keys/${segment}`, method: "DELETE" },
    ]);
    // What the browser requests is still the same endpoint, with nothing after the id but /resolve.
    for (const { url } of calls) {
      const resolved = resolvedPath(url);
      expect(resolved, url).toMatch(/^\/api\/(jobs|emails|rules|extension\/keys)\/[^/?#]+(\/resolve)?$/);
      expect(new URL(url, ORIGIN).search, url).toBe("");
    }
  });

  it("leaves a plain id as it is", async () => {
    const calls = captureFetch();
    const id = "0b7e3c1e-8a3e-4f8e-9d5a-2f1c6a7b9e10";
    await api.jobs.get(id);
    await api.emails.resolve(id, { action: "dismiss" });
    expect(calls.map((c) => c.url)).toEqual([`/api/jobs/${id}`, `/api/emails/${id}/resolve`]);
  });

  it("puts a jobId filter in the query string, encoded", async () => {
    const calls = captureFetch();
    await api.emails.list({ jobId: "../settings&x=1" });
    expect(calls[0].url).toBe("/api/emails?jobId=..%2Fsettings%26x%3D1");
  });
});

describe("api client: the inbox", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disconnects with a JSON POST, which the server's Origin and Content-Type check requires", async () => {
    const init: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, i: RequestInit) => {
        expect(input).toBe("/api/inbox/disconnect");
        init.push(i);
        return Response.json({ ok: true, revoked: false });
      }),
    );
    // The answer says whether Google confirmed the revocation; the screen reads it.
    expect(await api.inbox.disconnect()).toEqual({ ok: true, revoked: false });
    expect(init).toHaveLength(1);
    expect(init[0].method).toBe("POST");
    expect(init[0].body).toBe("{}");
    expect(new Headers(init[0].headers).get("content-type")).toBe("application/json");
  });

  it("surfaces the server's message when the check is refused (409) or Google failed (502)", async () => {
    for (const status of [409, 502]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error: `Refused with ${status}` }, { status })),
      );
      await expect(api.inbox.check()).rejects.toMatchObject({ status, message: `Refused with ${status}` });
    }
  });

  it("connects through a same-origin route, not a fetch", () => {
    expect(INBOX_CONNECT_HREF).toBe("/api/inbox/connect");
  });
});

describe("api client: the extension", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stubs fetch with `answer`; returns every request's URL and init. */
  function capture(answer: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        calls.push({ url: input, init });
        return answer();
      }),
    );
    return calls;
  }

  it("reads the overview with a GET", async () => {
    const overview = { version: "1.0.0", keys: [] };
    const calls = capture(() => Response.json(overview));
    expect(await api.extension.overview()).toEqual(overview);
    expect(calls.map((c) => [c.url, c.init.method ?? "GET"])).toEqual([["/api/extension", "GET"]]);
  });

  it("makes a key with a JSON POST of the label, and hands back the token", async () => {
    const created = {
      key: { id: "k1", label: "Chrome on Linux", createdAt: "2026-11-18T10:00:00.000Z", lastUsedAt: null },
      token: `jtx_${"A".repeat(43)}`,
    };
    const calls = capture(() => Response.json(created, { status: 201 }));
    expect(await api.extension.createKey("Chrome on Linux")).toEqual(created);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/extension/keys");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ label: "Chrome on Linux" });
    expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/json");
  });

  it("surfaces the server's message when the account has too many keys (409)", async () => {
    capture(() => Response.json({ error: "Too many connected browsers" }, { status: 409 }));
    await expect(api.extension.createKey("Chrome on Linux")).rejects.toMatchObject({
      status: 409,
      message: "Too many connected browsers",
    });
  });

  it("revokes with a DELETE that carries the JSON content type", async () => {
    const calls = capture(() => Response.json({ ok: true }));
    expect(await api.extension.revokeKey("k1")).toEqual({ ok: true });
    expect(calls[0].url).toBe("/api/extension/keys/k1");
    expect(calls[0].init.method).toBe("DELETE");
    expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/json");
  });

  it("downloads the zip through a same-origin link, not a fetch", () => {
    expect(EXTENSION_DOWNLOAD_HREF).toBe("/api/extension/download");
  });
});

describe("settings polling while the inbox syncs", () => {
  const inbox = (patch: Partial<Settings["inbox"]>): Settings["inbox"] => ({
    provider: "gmail",
    address: "someone@example.com",
    connected: true,
    state: "connected",
    syncing: false,
    backfill: null,
    lastCheckedAt: null,
    lastError: null,
    intervalMinutes: 15,
    configured: true,
    demo: false,
    ...patch,
  });

  const synced = { lastCheckedAt: "2026-11-17T09:00:00.000Z" };

  it("is busy while a sync runs, the first scan too", () => {
    expect(isInboxBusy(inbox({ ...synced, syncing: true }))).toBe(true);
    expect(isInboxBusy(inbox({ ...synced, syncing: true, backfill: { done: 0, total: null } }))).toBe(true);
    expect(isInboxBusy(inbox(synced))).toBe(false);
    expect(isInboxBusy(undefined)).toBe(false);
  });

  it("stops polling while a first scan is paused between runs, above all after a failure", () => {
    // A scan run ended with a rate limit, an outage or a setup error: the scan stays "running"
    // until a later run finishes it, an hour (or a day, or never) away.
    const lastError = { code: "gmail_api_disabled", message: "The Gmail API is turned off.", at: synced.lastCheckedAt };
    const paused = { syncing: false, backfill: { done: 120, total: 400 } };
    expect(isInboxBusy(inbox({ ...paused, lastError }))).toBe(false);
    expect(isInboxBusy(inbox({ ...paused, ...synced, lastError }))).toBe(false);
    // A run that left messages to retry: the next one is an interval away.
    expect(isInboxBusy(inbox({ ...paused, ...synced }))).toBe(false);
    // Stopped before its first run was recorded (a restart): the next tick picks it up.
    expect(isInboxBusy(inbox(paused))).toBe(true);
  });

  it("waits for a new connection's first sync, but not after it failed or when not connected", () => {
    expect(isInboxBusy(inbox({}))).toBe(true);
    const lastError = { code: "temporary", message: "Google didn't answer.", at: synced.lastCheckedAt };
    expect(isInboxBusy(inbox({ lastError }))).toBe(false);
    expect(isInboxBusy(inbox({ connected: false, state: "not_connected" }))).toBe(false);
    expect(isInboxBusy(inbox({ connected: false, state: "needs_reconnect" }))).toBe(false);
  });

  it("polls every few seconds", () => {
    expect(INBOX_POLL_MS).toBeGreaterThanOrEqual(3_000);
    expect(INBOX_POLL_MS).toBeLessThanOrEqual(5_000);
  });
});
