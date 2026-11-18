import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// scripts/smoke.mjs as CI and app-deploy run it, against a small node:http server that answers
// like the built app (src/proxy.ts, route() in src/lib/server/auth/guard.ts) in each sign-in
// mode; in demo mode also like POST /auth/demo, /api/me and POST /auth/signout. The script runs in
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
  /** The public demo: /login and signed-out pages go to /login/demo; workspaces as below. */
  demo?: boolean;
  /** Answers for single paths, replacing the app's. */
  routes?: Record<string, Handler>;
}

interface Fake {
  base: string;
  /** Every Cookie header the server received. */
  cookies: string[];
  /** The demo's live session tokens (one per workspace). */
  sessions: Set<string>;
  /** Every POST: path, Origin and Content-Type as received. */
  posts: Array<{ path: string; origin?: string; contentType?: string }>;
}

const DEMO_SESSION = "__Host-jt_session";

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

/** The demo session token a request's cookie names, if it is live. */
function liveSession(req: IncomingMessage, sessions: Set<string>): string | null {
  const token = new RegExp(`(?:^|;\\s*)${DEMO_SESSION}=([^;]+)`).exec(req.headers.cookie ?? "")?.[1];
  return token && sessions.has(token) ? token : null;
}

/** The demo's own routes: enter, /api/me, leave (src/app/auth/demo/route.ts, signout, api/me). */
function demoRoutes(sessions: Set<string>): Record<string, Handler> {
  const sameOrigin = (req: IncomingMessage) => req.headers.origin === APP_ORIGIN;
  const see = (res: ServerResponse, location: string, cookie: string) => {
    res.writeHead(303, { location: new URL(location, APP_ORIGIN).href, "set-cookie": cookie, "cache-control": "no-store" });
    res.end();
  };
  return {
    "/auth/demo": (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
      if (!sameOrigin(req)) return json(res, 403, { error: "Forbidden" });
      const token = randomBytes(32).toString("base64url");
      sessions.add(token);
      see(res, "/", `${DEMO_SESSION}=${token}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`);
    },
    "/api/me": (req, res) => {
      if (!liveSession(req, sessions)) return json(res, 401, { error: "Not signed in" });
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      json(res, 200, { email: "alex.0123@demo.invalid", name: "Alex Demo", pictureUrl: null, demo: { expiresAt } });
    },
    "/auth/signout": (req, res) => {
      if (req.method !== "POST" || !sameOrigin(req)) return json(res, 403, { error: "Forbidden" });
      const token = liveSession(req, sessions);
      if (token) sessions.delete(token);
      see(res, "/login", `${DEMO_SESSION}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    },
  };
}

/** The app as seen from outside, with junk sessions only: the guard refuses every cookie. */
function app(locked: boolean, demo: boolean): Handler {
  return (req, res, url) => {
    const { pathname, search, searchParams } = url;
    const hasSession = /(?:^|;\s*)(?:__Host-)?jt_session=[^;]/.test(req.headers.cookie ?? "");
    if (demo && pathname === "/login") return redirect(res, "/login/demo");
    if (demo && pathname === "/login/demo") return page(res, req);
    if (pathname === "/login" && locked && searchParams.get("error") !== "not_configured") {
      return redirect(res, login(searchParams.get("next"), true));
    }
    if (pathname === "/login" || pathname === "/privacy") return page(res, req);
    if (pathname === "/api/health") return json(res, 200, { ok: true });
    if (pathname.startsWith("/api/")) return json(res, 401, { error: "Not signed in" });
    if (locked) return redirect(res, login(`${pathname}${search}`, true));
    if (hasSession) return page(res, req);
    if (demo) return redirect(res, "/login/demo");
    return redirect(res, login(`${pathname}${search}`, false));
  };
}

async function startFake({ locked = false, demo = false, routes = {} }: FakeOptions = {}): Promise<Fake> {
  const cookies: string[] = [];
  const sessions = new Set<string>();
  const posts: Fake["posts"] = [];
  const fallback = app(locked, demo);
  const all: Record<string, Handler> = { ...(demo ? demoRoutes(sessions) : {}), ...routes };
  server = createServer((req, res) => {
    if (req.headers.cookie) cookies.push(req.headers.cookie);
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.method === "POST") {
      posts.push({ path: url.pathname, origin: req.headers.origin, contentType: req.headers["content-type"] });
    }
    // The body (the form post's, empty) is drained before answering.
    req.resume();
    req.on("end", () => (all[url.pathname] ?? fallback)(req, res, url));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, cookies, sessions, posts };
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

  it("passes against the public demo, with one round trip: enter, /api/me, leave", async () => {
    const fake = await startFake({ demo: true });
    const { status, output } = await smoke(fake.base);
    expect(output).toContain("smoke: all 15 checks passed");
    expect(status).toBe(0);
    expect(line(output, "GET /login")).toMatch(/ 307 -> 200 +ok \(demo\)$/);
    expect(line(output, "GET /")).toMatch(/ 307 -> 200 +ok$/);
    for (const p of PAGES) expect(line(output, `GET ${p} [junk cookie]`)).toMatch(/ 200 +ok$/);
    expect(line(output, "GET /api/jobs [junk cookie]")).toMatch(/ 401 +ok$/);
    expect(line(output, "POST /auth/demo")).toMatch(/ 303 +ok \(entered a workspace\)$/);
    expect(line(output, "GET /api/me [demo session]")).toMatch(/ 200 +ok$/);
    expect(line(output, "POST /auth/signout [demo session]")).toMatch(/ 303 +ok$/);
    expect(line(output, "GET /api/me [demo session] after leaving")).toMatch(/ 401 +ok$/);
    // Both posts came with APP_URL's origin (from /login's redirect), not the base URL's, as form posts.
    expect(fake.posts).toEqual([
      { path: "/auth/demo", origin: APP_ORIGIN, contentType: "application/x-www-form-urlencoded" },
      { path: "/auth/signout", origin: APP_ORIGIN, contentType: "application/x-www-form-urlencoded" },
    ]);
    // The workspace is gone again.
    expect(fake.sessions.size).toBe(0);
  });

  it("fails in the demo when entering answers busy, and skips the rest of the round trip", async () => {
    const fake = await startFake({
      demo: true,
      routes: { "/auth/demo": (_req, res) => redirect(res, "/login/demo?error=busy") },
    });
    const { status, output } = await smoke(fake.base);
    expect(status).toBe(1);
    expect(line(output, "POST /auth/demo")).toMatch(/ 307 +FAIL: expected 303$/);
    for (const label of ["GET /api/me [demo session]", "POST /auth/signout [demo session]"]) {
      expect(line(output, label)).toMatch(/ - +FAIL: skipped: no demo session$/);
    }
    expect(output).toContain("smoke: 4 of 15 checks failed");
  });

  it("names a busy demo as such", async () => {
    const fake = await startFake({
      demo: true,
      routes: {
        "/auth/demo": (_req, res) => {
          res.writeHead(303, { location: `${APP_ORIGIN}/login/demo?error=busy`, "cache-control": "no-store" });
          res.end();
        },
      },
    });
    const { status, output } = await smoke(fake.base);
    expect(status).toBe(1);
    expect(line(output, "POST /auth/demo")).toMatch(/ 303 +FAIL: the demo answered busy$/);
  });

  it("fails in the demo when /api/me has no demo.expiresAt, and still leaves", async () => {
    const fake = await startFake({
      demo: true,
      routes: { "/api/me": (_req, res) => json(res, 200, { email: "a@example.com", name: "A", pictureUrl: null }) },
    });
    const { status, output } = await smoke(fake.base);
    expect(status).toBe(1);
    expect(line(output, "GET /api/me [demo session]")).toMatch(/ 200 +FAIL: expected demo\.expiresAt in the future$/);
    expect(line(output, "POST /auth/signout [demo session]")).toMatch(/ 303 +ok$/);
    expect(fake.sessions.size).toBe(0);
  });

  it("fails in the demo when leaving keeps the session", async () => {
    const fake = await startFake({
      demo: true,
      routes: {
        "/auth/signout": (_req, res) => {
          res.writeHead(303, { location: `${APP_ORIGIN}/login` });
          res.end();
        },
      },
    });
    const { status, output } = await smoke(fake.base);
    expect(status).toBe(1);
    expect(line(output, "POST /auth/signout [demo session]")).toMatch(/ 303 +ok$/);
    expect(line(output, "GET /api/me [demo session] after leaving")).toMatch(/ 200 +FAIL: expected 401$/);
  });

  it("does not take a /login/demo that fails to load for the demo", async () => {
    const fake = await startFake({ demo: true, routes: { "/login/demo": (req, res) => page(res, req, 500) } });
    const { status, output } = await smoke(fake.base);
    expect(status).toBe(1);
    expect(line(output, "GET /login")).toMatch(/ 307 -> 500 +FAIL: expected 200 HTML, or a 307 to/);
    // Without a known mode, no round trip.
    expect(output).not.toContain("POST /auth/demo");
    expect(fake.posts).toEqual([]);
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

  it.each([
    ["locked", { locked: true }],
    ["demo", { demo: true }],
  ] as const)("never prints a cookie value, a header or a body (%s)", async (_, opts) => {
    const fake = await startFake({ ...opts, routes: { "/review": (req, res) => page(res, req, 500) } });
    const { output } = await smoke(fake.base);
    expect(fake.cookies.length).toBeGreaterThan(0);
    for (const cookie of new Set(fake.cookies)) {
      for (const pair of cookie.split(/;\s*/)) expect(output).not.toContain(pair.split("=").slice(1).join("="));
    }
    expect(output).not.toContain("tracker.example.com"); // the Location headers' origin
    expect(output).not.toContain("Not signed in"); // a body
    expect(output).not.toContain("Alex Demo"); // /api/me's body
    expect(output).not.toContain("demo.invalid");
  });
});
