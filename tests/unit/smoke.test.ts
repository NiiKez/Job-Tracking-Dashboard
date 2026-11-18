import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// scripts/smoke.mjs as CI and app-deploy run it, against a small node:http server that answers
// like the built app (src/proxy.ts, route() in src/lib/server/auth/guard.ts). The script runs in
// a child process with spawn, not spawnSync: spawnSync would block this process's event loop,
// and with it the fake server the script is talking to.

const REPO = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO, "scripts", "smoke.mjs");

/**
 * Locations carry this origin, like APP_URL's public origin on the server: the script must
 * compare their path and query only, and send the next request to its own base URL.
 */
const APP_ORIGIN = "https://tracker.example.com";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

interface FakeOptions {
  /** Sign-in not configured: /login and every page go to /login?error=not_configured. */
  locked?: boolean;
  /** Answers for single paths, replacing the app's. */
  routes?: Record<string, Handler>;
}

interface Fake {
  base: string;
  /** Every Cookie header the server received. */
  cookies: string[];
}

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function redirect(res: ServerResponse, location: string) {
  res.writeHead(307, { location: new URL(location, APP_ORIGIN).href, "cache-control": "no-store" });
  res.end();
}

function login(next: string | null, locked: boolean): string {
  const params = [...(locked ? ["error=not_configured"] : []), ...(next ? [`next=${encodeURIComponent(next)}`] : [])];
  return params.length > 0 ? `/login?${params.join("&")}` : "/login";
}

/** A page that echoes the cookie into a header and the body, which the script must not print. */
function page(res: ServerResponse, req: IncomingMessage, status = 200) {
  const cookie = req.headers.cookie ?? "";
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "x-echo-cookie": cookie });
  res.end(`<!DOCTYPE html><html><body>${cookie}</body></html>`);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The app as seen from outside, with junk sessions only: the guard refuses every cookie. */
function app(locked: boolean): Handler {
  return (req, res, url) => {
    const { pathname, search, searchParams } = url;
    const hasSession = /(?:^|;\s*)(?:__Host-)?jt_session=[^;]/.test(req.headers.cookie ?? "");
    if (pathname === "/login" && locked && searchParams.get("error") !== "not_configured") {
      return redirect(res, login(searchParams.get("next"), true));
    }
    if (pathname === "/login" || pathname === "/privacy") return page(res, req);
    if (pathname === "/api/health") return json(res, 200, { ok: true });
    if (pathname.startsWith("/api/")) return json(res, 401, { error: "Not signed in" });
    if (locked) return redirect(res, login(`${pathname}${search}`, true));
    if (hasSession) return page(res, req);
    return redirect(res, login(`${pathname}${search}`, false));
  };
}

async function startFake({ locked = false, routes = {} }: FakeOptions = {}): Promise<Fake> {
  const cookies: string[] = [];
  const fallback = app(locked);
  server = createServer((req, res) => {
    if (req.headers.cookie) cookies.push(req.headers.cookie);
    const url = new URL(req.url ?? "/", "http://fake");
    (routes[url.pathname] ?? fallback)(req, res, url);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, cookies };
}

/** Runs the script with nothing from this environment besides PATH, as app-deploy's env -i does. */
function smoke(...args: string[]): Promise<{ status: number | null; output: string }> {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: REPO,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output }));
  });
}

/** The output line for one check, e.g. line(output, "GET /settings [junk cookie]"). */
function line(output: string, label: string): string {
  const found = output.split("\n").find((l) => l.startsWith(`${label} `));
  if (!found) throw new Error(`no line for ${label} in:\n${output}`);
  return found;
}

const PAGES = ["/", "/activity", "/review", "/settings", "/extension/connect"];

describe("scripts/smoke.mjs", () => {
  it("passes against an app with sign-in configured", async () => {
    const fake = await startFake();
    const { status, output } = await smoke(fake.base);
    expect(output).toContain("smoke: all 11 checks passed");
    expect(status).toBe(0);
    expect(line(output, "GET /login")).toMatch(/ 200 +ok \(sign-in configured\)$/);
    expect(line(output, "GET /")).toMatch(/ 307 -> 200 +ok$/);
    for (const p of PAGES) expect(line(output, `GET ${p} [junk cookie]`)).toMatch(/ 200 +ok$/);
    expect(output).toMatch(/^GET \/jobs\/[0-9a-f-]{36} \[junk cookie\] +200 +ok$/m);
    expect(line(output, "GET /api/jobs [junk cookie]")).toMatch(/ 401 +ok$/);
  });

  it("passes against an app with sign-in locked", async () => {
    const fake = await startFake({ locked: true });
    const { status, output } = await smoke(fake.base);
    expect(output).toContain("smoke: all 11 checks passed");
    expect(status).toBe(0);
    expect(line(output, "GET /login")).toMatch(/ 307 -> 200 +ok \(sign-in locked\)$/);
    for (const p of PAGES) expect(line(output, `GET ${p} [junk cookie]`)).toMatch(/ 307 -> 200 +ok$/);
    expect(line(output, "GET /api/jobs [junk cookie]")).toMatch(/ 401 +ok$/);
  });

  it("fails when a page answers 500", async () => {
    const fake = await startFake({ routes: { "/settings": (req, res) => page(res, req, 500) } });
    const { status, output } = await smoke(fake.base);
    expect(status).toBe(1);
    expect(line(output, "GET /settings [junk cookie]")).toMatch(/ 500 +FAIL: expected 200 HTML$/);
    expect(output).toContain("smoke: 1 of 11 checks failed");
  });

  it("fails on a redirect loop", async () => {
    // The login page sends a signed-out visitor back where they came from.
    const fake = await startFake({
      routes: {
        "/login": (req, res, url) => {
          const next = url.searchParams.get("next");
          return next ? redirect(res, next) : page(res, req);
        },
      },
    });
    const { status, output } = await smoke(fake.base);
    expect(status).toBe(1);
    expect(line(output, "GET /")).toMatch(/ 307 -> 307 +FAIL: redirect loop$/);
  });

  it("fails when /api/jobs lets the junk cookie through", async () => {
    const fake = await startFake({ routes: { "/api/jobs": (_req, res) => json(res, 200, []) } });
    const { status, output } = await smoke(fake.base);
    expect(status).toBe(1);
    expect(line(output, "GET /api/jobs [junk cookie]")).toMatch(/ 200 +FAIL: expected 401$/);
  });

  it("fails when the health check does", async () => {
    const fake = await startFake({ routes: { "/api/health": (_req, res) => json(res, 503, { ok: false }) } });
    const { status, output } = await smoke(fake.base);
    expect(status).toBe(1);
    expect(line(output, "GET /api/health")).toMatch(/ 503 +FAIL: expected 200$/);
  });

  it("fails when nothing answers", async () => {
    const fake = await startFake();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const { status, output } = await smoke(fake.base);
    expect(status).toBe(1);
    expect(line(output, "GET /api/health")).toMatch(/FAIL: no answer \(ECONNREFUSED\)$/);
  });

  it("exits 2 without a base URL, or with one that is not an origin", async () => {
    for (const args of [[], ["not a url"], ["http://127.0.0.1:3800/app"], ["http://u:secret-pw@127.0.0.1:3800"]]) {
      const { status, output } = await smoke(...args);
      expect(status).toBe(2);
      expect(output).toMatch(/^usage: /m);
      expect(output).not.toContain("secret-pw");
    }
  });

  it("never prints a cookie value, a header or a body", async () => {
    const fake = await startFake({ locked: true, routes: { "/review": (req, res) => page(res, req, 500) } });
    const { output } = await smoke(fake.base);
    expect(fake.cookies.length).toBeGreaterThan(0);
    for (const cookie of new Set(fake.cookies)) {
      expect(output).not.toContain(cookie.split("=").slice(1).join("="));
    }
    expect(output).not.toContain("tracker.example.com"); // the Location headers' origin
    expect(output).not.toContain("Not signed in"); // a body
  });
});
