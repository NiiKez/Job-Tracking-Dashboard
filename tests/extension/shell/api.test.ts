import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createApi,
  DISCONNECTED_MESSAGE,
  failureMessage,
  isDisconnected,
  isNoAccess,
} from "../../../extension/src/lib/api";
import type { PageSnapshot } from "@/lib/types";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";

// The extension's API client with fetch stubbed: what each request carries, and how every kind
// of failure becomes one of the four errors the popup acts on.

const ORIGIN = "https://tracker.example.com";
const PATTERN = `${ORIGIN}/*`;
const TOKEN = `jtx_${"a".repeat(43)}`; // invented

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The key routes' 401 (keyNotSignedIn in src/lib/server/auth/guard.ts). */
const keyRefused = () => json(401, { error: "Not signed in" }, { "WWW-Authenticate": "Bearer" });

let chromeApi: FakeChrome;
beforeEach(() => {
  chromeApi = installFakeChrome();
  // Connect granted the tracker's site access.
  chromeApi.permissions.granted.add(PATTERN);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

function client(answer: Response | Error) {
  const fetch = vi.fn<Fetch>(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { api: createApi({ origin: ORIGIN, token: TOKEN }, { fetch }), fetch };
}

async function failure(
  answer: Response | Error,
  call: (api: ReturnType<typeof createApi>) => Promise<unknown> = (api) => api.session(),
) {
  const { api } = client(answer);
  const error = await call(api).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

const snapshot: PageSnapshot = {
  url: "https://jobs.example.com/1",
  canonicalUrl: null,
  title: "Engineer",
  meta: {},
  jsonLd: [],
  site: null,
  selection: "",
};

describe("requests", () => {
  it("sends the key as a Bearer header, without cookies or redirects, and returns the JSON", async () => {
    const { api, fetch } = client(json(200, { email: "ada@example.com", name: "Ada", latestVersion: "1.0.0" }));
    await expect(api.session()).resolves.toEqual({ email: "ada@example.com", name: "Ada", latestVersion: "1.0.0" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/api/extension/session`);
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual", cache: "no-store" });
    expect(init.headers).toEqual({ Accept: "application/json", Authorization: `Bearer ${TOKEN}` });
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("marks every changing request as JSON, the body-less DELETE too", async () => {
    const read = client(json(200, {}));
    await read.api.read(snapshot);
    const [readUrl, readInit] = read.fetch.mock.calls[0];
    expect(readUrl).toBe(`${ORIGIN}/api/extension/read`);
    expect(readInit.method).toBe("POST");
    expect(readInit.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(readInit.body as string)).toEqual({ page: snapshot });

    const save = client(json(200, {}));
    const input = { title: "Engineer", company: "Acme", location: "", url: null, description: "", status: "applied" as const };
    await save.api.saveJob(input);
    expect(save.fetch.mock.calls[0][0]).toBe(`${ORIGIN}/api/extension/jobs`);
    expect(JSON.parse(save.fetch.mock.calls[0][1].body as string)).toEqual(input);

    const revoke = client(json(200, { ok: true }));
    await revoke.api.revoke();
    const [revokeUrl, revokeInit] = revoke.fetch.mock.calls[0];
    expect(revokeUrl).toBe(`${ORIGIN}/api/extension/session`);
    expect(revokeInit.method).toBe("DELETE");
    expect(revokeInit.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(revokeInit.body).toBeUndefined();
  });

  it("gives up after the timeout", async () => {
    const fetch = vi.fn<Fetch>(
      (_, init) => new Promise((__, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const api = createApi({ origin: ORIGIN, token: TOKEN }, { fetch, timeoutMs: 20 });
    await expect(api.session()).rejects.toMatchObject({
      kind: "retryable",
      status: null,
      message: "tracker.example.com took too long to answer. Try again.",
    });
  });
});

describe("errors", () => {
  it("the key routes' 401 (WWW-Authenticate: Bearer): disconnected", async () => {
    const error = await failure(keyRefused());
    expect(error).toMatchObject({ kind: "disconnected", status: 401, message: DISCONNECTED_MESSAGE });
    expect(isDisconnected(error)).toBe(true);
    // The scheme is case-insensitive and may come with parameters or among other challenges.
    for (const challenge of ["bearer", 'Bearer realm="job-tracker"', 'Basic realm="x", Bearer']) {
      expect(await failure(json(401, {}, { "WWW-Authenticate": challenge }))).toMatchObject({ kind: "disconnected" });
    }
  });

  it("any other 401 (an older release's proxy, something in between): retryable, and the key kept", async () => {
    for (const answer of [
      json(401, { error: "Not signed in" }),
      json(401, {}, { "WWW-Authenticate": 'Basic realm="proxy"' }),
      json(401, {}, { "WWW-Authenticate": 'Basic realm="Bearer"' }),
      new Response("<html>Unauthorized</html>", { status: 401, headers: { "content-type": "text/html" } }),
    ]) {
      const error = await failure(answer);
      expect(error).toMatchObject({
        kind: "retryable",
        status: 401,
        message: "tracker.example.com didn't accept the request right now. Try again in a moment.",
      });
      expect(isDisconnected(error)).toBe(false);
    }
  });

  it.each([500, 502, 503, 429, 408])("%i: retryable", async (status) => {
    const error = await failure(json(status, { error: "Something failed" }));
    expect(error).toMatchObject({
      kind: "retryable",
      status,
      message: `tracker.example.com couldn't answer right now (${status}). Try again in a moment.`,
    });
  });

  it("no answer at all: retryable", async () => {
    const error = await failure(new TypeError("Failed to fetch"));
    expect(error).toMatchObject({
      kind: "retryable",
      status: null,
      message: "Couldn't reach tracker.example.com. Check your connection, then try again.",
    });
    expect(chromeApi.permissions.contains).toHaveBeenCalledWith({ origins: [PATTERN] });
  });

  it("no answer because the tracker's site access was withdrawn: no-access, and the key kept", async () => {
    // chrome://extensions → Site access: the popup's requests become CORS requests, which fail.
    chromeApi.permissions.granted.clear();
    const error = await failure(new TypeError("Failed to fetch"));
    expect(error).toMatchObject({
      kind: "no-access",
      status: null,
      message: "Job Tracker no longer has access to tracker.example.com. Allow access to reach it again.",
    });
    expect(isNoAccess(error)).toBe(true);
    expect(isDisconnected(error)).toBe(false);
  });

  it("no answer, and access can't be checked: retryable", async () => {
    chromeApi.permissions.contains.mockRejectedValue(new Error("No permissions API"));
    expect(await failure(new TypeError("Failed to fetch"))).toMatchObject({ kind: "retryable", status: null });
    vi.stubGlobal("chrome", undefined);
    expect(await failure(new TypeError("Failed to fetch"))).toMatchObject({ kind: "retryable", status: null });
  });

  it("a timeout is never taken for withdrawn access", async () => {
    chromeApi.permissions.granted.clear();
    const fetch = vi.fn<Fetch>(
      (_, init) => new Promise((__, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const api = createApi({ origin: ORIGIN, token: TOKEN }, { fetch, timeoutMs: 20 });
    await expect(api.session()).rejects.toMatchObject({ kind: "retryable" });
  });

  it.each([400, 403, 404, 409])("%i with the tracker's message: rejected, and the message shown", async (status) => {
    const error = await failure(json(status, { error: "Title is required" }), (api) =>
      api.saveJob({ title: "", company: "Acme", location: "", url: null, description: "", status: "saved" }),
    );
    expect(error).toMatchObject({ kind: "rejected", status, message: "Title is required" });
  });

  it("not the tracker's API answering: rejected, asking to check the address", async () => {
    const html = new Response("<html>Not found</html>", { status: 404, headers: { "content-type": "text/html" } });
    expect(await failure(html)).toMatchObject({
      kind: "rejected",
      status: 404,
      message: "tracker.example.com didn't answer like a Job Tracker (404). Check the address.",
    });
    // A 200 that is not JSON (a captive portal, another site) is no answer either.
    const page = new Response("<html>Welcome</html>", { status: 200 });
    expect(await failure(page)).toMatchObject({ kind: "rejected", status: 200 });
    // redirect: "manual" turns a redirect into an opaque response without a status.
    const redirect = { status: 0, ok: false, type: "opaqueredirect", json: () => Promise.reject(new SyntaxError()) } as unknown as Response;
    expect(await failure(redirect)).toMatchObject({
      kind: "rejected",
      status: null,
      message: "tracker.example.com didn't answer like a Job Tracker. Check the address.",
    });
  });

  it("never puts the key into a message", async () => {
    for (const answer of [keyRefused(), json(401, {}), json(500, {}), json(400, {}), new TypeError("x")]) {
      expect((await failure(answer)).message).not.toContain(TOKEN);
    }
    chromeApi.permissions.granted.clear();
    expect((await failure(new TypeError("x"))).message).not.toContain(TOKEN);
  });

  it("words a bug as the extension's fault", () => {
    expect(failureMessage(new ApiError("retryable", "Couldn't reach it.", null))).toBe("Couldn't reach it.");
    expect(failureMessage(new Error("x is undefined"))).toBe("Something went wrong in the extension. Try again.");
  });
});

describe("requestAccess", () => {
  it("asks Chrome for the tracker's site access again, and says whether it was granted", async () => {
    const request = vi.fn(async ({ origins }: { origins: string[] }) => {
      for (const origin of origins) chromeApi.permissions.granted.add(origin);
      return true;
    });
    Object.assign(chromeApi.permissions, { request });
    chromeApi.permissions.granted.clear();
    const { api } = client(json(200, {}));
    await expect(api.requestAccess()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: [PATTERN] });

    request.mockResolvedValueOnce(false);
    await expect(api.requestAccess()).resolves.toBe(false);
    // Chrome throws for a pattern the manifest doesn't list, or without a user gesture.
    request.mockRejectedValueOnce(new Error("This function must be called during a user gesture"));
    await expect(api.requestAccess()).resolves.toBe(false);
  });
});
