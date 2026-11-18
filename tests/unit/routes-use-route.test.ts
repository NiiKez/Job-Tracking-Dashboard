import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { authOf, isRouteHandler, route } from "@/lib/server/auth/guard";

// docs/plan/1-backend-core.md, "Three layers": every Route Handler is wrapped in route(), the
// check that counts. This walks all of src/app, not only src/app/api: a route.ts anywhere is
// reachable, and the proxy lets some paths through unchecked (/auth/*, anything with a dot). A new
// route file that skips route() fails here, and so do the two other ways to answer requests
// without it: a code-generated metadata route and a Server Action ("use server").

const SRC_DIR = path.resolve(__dirname, "../../src");
const APP_DIR = path.join(SRC_DIR, "app");
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

// The route files that are not route()-wrapped, relative to src/app. Exact: each must exist.
// Health answers without a session by design; the /auth routes do their own checks (state cookie
// and PKCE, Origin on sign-out) and run before there is a session. /auth/options answers the
// signed-out sign-in page with the demo's address (DEMO_URL) and nothing else: no session, no
// database (docs/plan/5-public-demo.md, "Step 8"). The Gmail connect flow's two
// GET routes are browser navigations that must answer a redirect, not a 401: they check the
// session with authenticate() (the same checks as route()), then the state cookie and PKCE
// (src/lib/server/inbox/oauth/connect.ts, tests/handlers/inbox-connect.test.ts).
const HEALTH = "api/health/route.ts";
const AUTH_OPTIONS = "auth/options/route.ts";
const NOT_WRAPPED = [
  HEALTH,
  "auth/google/route.ts",
  "auth/google/callback/route.ts",
  "auth/signout/route.ts",
  AUTH_OPTIONS,
  "api/inbox/connect/route.ts",
  "api/inbox/callback/route.ts",
];

// The handlers that take the Chrome extension's key instead of the session cookie
// (route(…, { auth: "extension" }); docs/plan/4-chrome-extension.md, "API"), as "<file> <method>".
// Exact: a handler that starts or stops taking the key fails here. Every other one takes the
// session cookie.
const KEY_ROUTES = [
  "api/extension/jobs/route.ts POST",
  "api/extension/read/route.ts POST",
  "api/extension/session/route.ts DELETE",
  "api/extension/session/route.ts GET",
];

const ROUTE_FILE = /^route\.(ts|tsx|js|jsx|mjs)$/;
// Next's code-generated metadata routes (next/dist/lib/metadata/is-metadata-route.js, default
// page extensions). They are Route Handlers that route() cannot wrap. Static files (favicon.ico,
// icon.png, robots.txt) are fine.
const METADATA_ROUTE = /^(sitemap|robots|manifest|(icon|apple-icon|opengraph-image|twitter-image)\d?)\.(ts|tsx|js|jsx)$/;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
// A "use server" directive: at the start of a file, a line, or a function body. Not in a comment.
const USE_SERVER = /(?:^|[{;])\s*(["'])use server\1/m;

function allFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? allFiles(full) : [full];
  });
}

const rel = (f: string) => path.relative(APP_DIR, f).split(path.sep).join("/");
const appFiles = allFiles(APP_DIR);
const routeFiles = appFiles.filter((f) => ROUTE_FILE.test(path.basename(f)));
const wrapped = routeFiles.filter((f) => !NOT_WRAPPED.includes(rel(f)));

describe("every route uses route()", () => {
  it("finds the route files", () => {
    expect(wrapped.length).toBeGreaterThanOrEqual(12);
    expect(wrapped.map(rel)).toContain("api/me/route.ts");
    expect(routeFiles.map(rel)).toEqual(expect.arrayContaining(NOT_WRAPPED));
  });

  it.each(wrapped.map((f) => [rel(f), f]))("%s", async (_name, file) => {
    // Source: no handler written as a plain function declaration or default export.
    const source = fs.readFileSync(file, "utf8");
    expect(source).not.toMatch(/export\s+(async\s+)?function\b/);
    expect(source).not.toMatch(/export\s+default\b/);

    // Exports: every HTTP method is made by route(), and no other export is a function.
    const mod = (await import(file)) as Record<string, unknown>;
    const methods = Object.keys(mod).filter((name) => METHODS.has(name));
    expect(methods.length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(mod)) {
      if (METHODS.has(name)) {
        expect(isRouteHandler(value), `${name} must be export const ${name} = route(...)`).toBe(true);
      } else {
        expect(typeof value, `${name} must not be an exported function`).not.toBe("function");
      }
    }
  });

  it("takes the extension's key on the key routes only, the session cookie everywhere else", async () => {
    const byAuth: Record<string, string[]> = {};
    for (const file of wrapped) {
      const mod = (await import(file)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (METHODS.has(name)) (byAuth[String(authOf(value))] ??= []).push(`${rel(file)} ${name}`);
      }
    }
    expect(Object.keys(byAuth).sort()).toEqual(["extension", "session"]);
    expect(byAuth.extension.sort()).toEqual(KEY_ROUTES);
    expect(byAuth.session).toEqual(expect.arrayContaining(["api/me/route.ts GET", "api/extension/download/route.ts GET"]));
  });

  it.each([HEALTH, AUTH_OPTIONS])("%s exports only GET", async (file) => {
    const mod = (await import(path.join(APP_DIR, file))) as Record<string, unknown>;
    expect(Object.keys(mod)).toEqual(["GET"]);
    expect(typeof mod.GET).toBe("function");
  });

  it("does not count a plain function as a route handler", () => {
    expect(isRouteHandler(async () => new Response())).toBe(false);
    expect(isRouteHandler(undefined)).toBe(false);
    expect(authOf(async () => new Response())).toBeNull();
    expect(authOf(undefined)).toBeNull();
  });

  it("records what each handler takes", () => {
    expect(authOf(route(() => null))).toBe("session");
    expect(authOf(route(() => null, { auth: "session", status: 201 }))).toBe("session");
    expect(authOf(route(() => null, { auth: "extension" }))).toBe("extension");
  });
});

describe("no other way to answer requests", () => {
  it("has no code-generated metadata route in src/app", () => {
    expect(appFiles.filter((f) => METADATA_ROUTE.test(path.basename(f))).map(rel)).toEqual([]);
    // The app does have a static one.
    expect(appFiles.map(rel)).toContain("favicon.ico");
  });

  it("recognises metadata routes", () => {
    const flagged = (names: string[]) => names.filter((name) => METADATA_ROUTE.test(name));
    const generated = [
      "sitemap.ts",
      "robots.tsx",
      "manifest.js",
      "icon.tsx",
      "icon2.jsx",
      "apple-icon.ts",
      "opengraph-image.tsx",
      "opengraph-image1.ts",
      "twitter-image.js",
    ];
    expect(flagged(generated)).toEqual(generated);
    expect(
      flagged(["favicon.ico", "icon.png", "apple-icon.jpg", "robots.txt", "manifest.webmanifest", "sitemap.xml", "icons.tsx"]),
    ).toEqual([]);
  });

  it('has no "use server" directive anywhere under src', () => {
    const files = allFiles(SRC_DIR).filter((f) => SOURCE_FILE.test(f));
    expect(files.length).toBeGreaterThan(50);
    const found = files.filter((f) => USE_SERVER.test(fs.readFileSync(f, "utf8")));
    expect(found.map((f) => path.relative(SRC_DIR, f))).toEqual([]);
  });

  it('recognises a "use server" directive', () => {
    for (const source of [
      '"use server";\nexport async function save() {}',
      "'use server'\n\nexport const x = 1;",
      '/** Actions. */\n"use server";',
      'export async function save() {\n  "use server";\n}',
      "const save = async () => { 'use server'; };",
      '"use strict"; "use server";',
    ]) {
      expect(USE_SERVER.test(source), source).toBe(true);
    }
    for (const source of ['// no "use server" here', ' * never "use server"', 'const s = "use server";', '"use client";']) {
      expect(USE_SERVER.test(source), source).toBe(false);
    }
  });
});
