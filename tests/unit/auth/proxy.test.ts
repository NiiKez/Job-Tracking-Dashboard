import fs from "node:fs";
import path from "node:path";
// Before the adapter: gives it the AsyncLocalStorage global that `next start` sets up.
import "next/dist/server/node-environment-baseline";
import { adapter } from "next/dist/server/web/adapter";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_PLAIN, SESSION_COOKIE_SECURE } from "@/lib/server/auth/session";
import { config, proxy } from "@/proxy";
import { restoreEnv, setEnv, signedInEnv } from "./env";

/**
 * The URL Next hands the proxy. Under `next start` it is the server's own hostname and port, not
 * the Host header. Deliberately not APP_URL's origin, so the tests can tell the two apart.
 */
const SERVER = "http://localhost:3800";

function run(pathAndQuery: string, cookie?: string): Response {
  const req = new NextRequest(`${SERVER}${pathAndQuery}`, {
    headers: cookie ? { cookie } : {},
  });
  return proxy(req);
}

/** A request with these headers (an Authorization header, for the extension's key routes). */
function runWith(pathAndQuery: string, headers: Record<string, string>, method = "GET"): Response {
  return proxy(new NextRequest(`${SERVER}${pathAndQuery}`, { method, headers }));
}

/**
 * The proxy run through Next's own proxy adapter, which post-processes its response before it is
 * sent: it parses a Location with new URL() and no base, and turns a Location on the request
 * URL's host into a relative one.
 */
async function runInNext(pathAndQuery: string, headers: Record<string, string> = {}): Promise<Response> {
  const { response } = await adapter({
    handler: async (req) => proxy(req),
    page: "/src/proxy",
    request: { url: `${SERVER}${pathAndQuery}`, headers, method: "GET", signal: new AbortController().signal },
  });
  return response;
}

/** NextResponse.next(): the request continues to the route. */
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

describe("proxy", () => {
  afterEach(restoreEnv);

  it("redirects a signed-out page request to /login with next, built from APP_URL", () => {
    signedInEnv({ APP_URL: "https://jobs.example.com" });
    const home = run("/");
    expect(home.status).toBe(307);
    expect(home.headers.get("location")).toBe("https://jobs.example.com/login?next=%2F");
    expect(home.headers.get("cache-control")).toBe("no-store");

    const jobs = run("/jobs/abc?tab=emails");
    expect(jobs.headers.get("location")).toBe("https://jobs.example.com/login?next=%2Fjobs%2Fabc%3Ftab%3Demails");
    expect(run("/settings").headers.get("location")).toBe("https://jobs.example.com/login?next=%2Fsettings");
  });

  it("never takes the redirect's host from the request", () => {
    signedInEnv({ APP_URL: "https://jobs.example.com" });
    const req = new NextRequest("http://evil.example/review", {
      headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
    });
    expect(proxy(req).headers.get("location")).toBe("https://jobs.example.com/login?next=%2Freview");
  });

  it("builds the Location on the request's URL when APP_URL is missing, never on its headers", () => {
    // Without APP_URL sign-in is locked, hence the error code. Next's adapter needs an absolute
    // Location; it sends this one as a relative one (next test).
    setEnv({});
    expect(run("/review").headers.get("location")).toBe(`${SERVER}/login?error=not_configured&next=%2Freview`);
    const req = new NextRequest(`${SERVER}/review`, {
      headers: { host: "evil.example.com", "x-forwarded-host": "evil.example.com" },
    });
    expect(proxy(req).headers.get("location")).toBe(`${SERVER}/login?error=not_configured&next=%2Freview`);
  });

  it("through Next's adapter: a relative Location without APP_URL, APP_URL's with it, whatever the Host", async () => {
    const spoofed = { host: "evil.example.com", "x-forwarded-host": "evil.example.com" };
    setEnv({});
    for (const [path, location] of [
      ["/", "/login?error=not_configured&next=%2F"],
      ["/login", "/login?error=not_configured"],
      ["/jobs/x?y=1", "/login?error=not_configured&next=%2Fjobs%2Fx%3Fy%3D1"],
    ]) {
      for (const headers of [{}, spoofed]) {
        const res = await runInNext(path, headers);
        expect(res.status, path).toBe(307);
        expect(res.headers.get("location"), path).toBe(location);
      }
    }
    expect((await runInNext("/login?error=not_configured")).headers.get("x-middleware-next")).toBe("1");

    signedInEnv({ GOOGLE_CLIENT_ID: "" });
    const res = await runInNext("/", spoofed);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://jobs.example.com/login?error=not_configured&next=%2F");
  });

  it("answers 401 JSON with no-store to a signed-out API request", async () => {
    signedInEnv();
    for (const p of ["/api/jobs", "/api/me", "/api/jobs/abc", "/api"]) {
      const res = run(p);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Not signed in" });
    }
  });

  it("lets requests with either session cookie through (route() checks it)", () => {
    signedInEnv();
    for (const cookie of [`${SESSION_COOKIE_SECURE}=x`, `${SESSION_COOKIE_PLAIN}=x`, `a=1; ${SESSION_COOKIE_SECURE}=x`]) {
      expect(passes(run("/", cookie))).toBe(true);
      expect(passes(run("/api/jobs", cookie))).toBe(true);
    }
  });

  it("lets an API request with Authorization: Bearer through without a cookie (route() checks the key)", () => {
    signedInEnv();
    // Any Bearer value: whether it is a key is route()'s question, and cookie routes ignore it.
    for (const authorization of ["Bearer jtx_invented", "bearer x", "BEARER   x"]) {
      for (const [p, method] of [
        ["/api/extension/session", "GET"],
        ["/api/extension/session", "DELETE"],
        ["/api/extension/read", "POST"],
        ["/api/jobs", "GET"],
      ]) {
        expect(passes(runWith(p, { authorization }, method)), `${method} ${p}`).toBe(true);
      }
    }
  });

  it("answers 401 to an API request whose Authorization is not Bearer", async () => {
    signedInEnv();
    for (const authorization of ["Basic eDp5", "Bearer", "Bearer ", "Bearerx", "Token x"]) {
      const res = runWith("/api/extension/session", { authorization });
      expect(res.status, authorization).toBe(401);
      expect(await res.json()).toEqual({ error: "Not signed in" });
    }
  });

  it("still sends a page with a Bearer header and no cookie to /login", () => {
    signedInEnv();
    const res = runWith("/settings", { authorization: "Bearer x" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://jobs.example.com/login?next=%2Fsettings");
  });

  it("treats an empty or other cookie as signed out", () => {
    signedInEnv();
    expect(run("/", `${SESSION_COOKIE_SECURE}=`).status).toBe(307);
    expect(run("/api/jobs", "session=x").status).toBe(401);
  });

  it.each([
    "/login",
    "/login?next=%2Fjobs",
    "/auth/google",
    "/auth/google/callback?code=x&state=y",
    "/auth/signout",
    "/privacy",
    "/api/health",
    "/_next/static/chunks/app.js",
    "/_next/image?url=x",
    "/favicon.ico",
    "/robots.txt",
    "/file.svg",
  ])("leaves %s alone when signed out", (p) => {
    signedInEnv();
    expect(passes(run(p))).toBe(true);
  });

  it("does not treat lookalike paths as open", () => {
    signedInEnv();
    expect(run("/loginx").status).toBe(307);
    expect(run("/authors").status).toBe(307);
    expect(run("/api/healthz").status).toBe(401);
    expect(run("/api/health/x").status).toBe(401);
    // Exactly /privacy: Google's consent screen links to it, nothing below or beside it is public.
    for (const p of ["/privacyx", "/privacy/x", "/privacy-policy"]) expect(run(p).status, p).toBe(307);
    expect(run("/api/privacy").status).toBe(401);
  });

  it("drops a next that the login page would refuse", () => {
    signedInEnv();
    // "//host/path" as a path: safeNextPath refuses it, so no next at all.
    expect(run("//evil/path").headers.get("location")).toBe("https://jobs.example.com/login");
  });

  it("leaves /login alone whatever its error code while sign-in is configured", () => {
    signedInEnv();
    for (const p of ["/login?error=failed", "/login?error=not_allowed&next=%2Fjobs", "/login?error=not_configured"]) {
      expect(passes(run(p))).toBe(true);
    }
  });

  describe("while sign-in is locked", () => {
    const LOCKED = "https://jobs.example.com/login?error=not_configured";

    it.each(["APP_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAILS"] as const)(
      "counts a missing %s as locked",
      (name) => {
        signedInEnv({ [name]: "" });
        const base = name === "APP_URL" ? `${SERVER}/login?error=not_configured` : LOCKED;
        expect(run("/login").headers.get("location")).toBe(base);
        expect(run("/jobs").headers.get("location")).toBe(`${base}&next=%2Fjobs`);
      },
    );

    it("redirects /login to /login?error=not_configured, keeping a safe next", () => {
      signedInEnv({ GOOGLE_CLIENT_SECRET: "" });
      const login = run("/login");
      expect(login.status).toBe(307);
      expect(login.headers.get("cache-control")).toBe("no-store");
      expect(login.headers.get("location")).toBe(LOCKED);

      expect(run("/login?next=%2Fjobs%2Fabc%3Ftab%3Demails").headers.get("location")).toBe(
        `${LOCKED}&next=%2Fjobs%2Fabc%3Ftab%3Demails`,
      );
      // Another error code is replaced; the cookie changes nothing.
      expect(run("/login?error=failed&next=%2Freview", `${SESSION_COOKIE_SECURE}=x`).headers.get("location")).toBe(
        `${LOCKED}&next=%2Freview`,
      );
      expect(run("/login?error=&next=%2Freview").headers.get("location")).toBe(`${LOCKED}&next=%2Freview`);
      // A next the login page would refuse is dropped.
      for (const next of ["%2F%2Fevil.example", "https%3A%2F%2Fevil.example", "%2Flogin", "%2Fauth%2Fgoogle"]) {
        expect(run(`/login?next=${next}`).headers.get("location")).toBe(LOCKED);
      }
    });

    it("never takes the redirect's host from the request", () => {
      signedInEnv({ GOOGLE_CLIENT_ID: "" });
      const req = new NextRequest("http://evil.example/login", {
        headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
      });
      expect(proxy(req).headers.get("location")).toBe(LOCKED);
    });

    it("leaves /login?error=not_configured alone, so the redirect does not loop", () => {
      signedInEnv({ ALLOWED_EMAILS: "" });
      expect(passes(run("/login?error=not_configured"))).toBe(true);
      expect(passes(run("/login?next=%2Fjobs&error=not_configured"))).toBe(true);
      for (const start of ["/login", "/login?error=failed&next=%2Fjobs", "/jobs/abc?tab=emails", "/"]) {
        const location = run(start, `${SESSION_COOKIE_SECURE}=x`).headers.get("location")!;
        const { pathname, search } = new URL(location);
        expect(passes(run(`${pathname}${search}`, `${SESSION_COOKIE_SECURE}=x`)), start).toBe(true);
      }
    });

    it("sends every page straight to /login?error=not_configured, with or without a session cookie", () => {
      signedInEnv({ GOOGLE_CLIENT_ID: "" });
      for (const cookie of [undefined, `${SESSION_COOKIE_SECURE}=x`, `${SESSION_COOKIE_PLAIN}=x`]) {
        const home = run("/", cookie);
        expect(home.status).toBe(307);
        expect(home.headers.get("cache-control")).toBe("no-store");
        expect(home.headers.get("location")).toBe(`${LOCKED}&next=%2F`);
        expect(run("/jobs/abc?tab=emails", cookie).headers.get("location")).toBe(
          `${LOCKED}&next=%2Fjobs%2Fabc%3Ftab%3Demails`,
        );
        expect(run("/settings", cookie).headers.get("location")).toBe(`${LOCKED}&next=%2Fsettings`);
        expect(run("//evil/path", cookie).headers.get("location")).toBe(LOCKED);
      }
    });

    it("treats a malformed environment as locked, with the Location on the request's URL", () => {
      // ALLOWED_EMAILS is malformed: getEnv() throws, so neither signInConfig() nor appUrl() answers.
      signedInEnv({ ALLOWED_EMAILS: "not an address" });
      expect(run("/login").headers.get("location")).toBe(`${SERVER}/login?error=not_configured`);
      expect(run("/review", `${SESSION_COOKIE_SECURE}=x`).headers.get("location")).toBe(
        `${SERVER}/login?error=not_configured&next=%2Freview`,
      );
      expect(passes(run("/login?error=not_configured"))).toBe(true);
    });

    it("leaves /api/* as it is: 401 without a cookie, through with one (route() answers 401)", async () => {
      signedInEnv({ GOOGLE_CLIENT_SECRET: "" });
      const res = run("/api/jobs");
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Not signed in" });
      expect(passes(run("/api/jobs", `${SESSION_COOKIE_SECURE}=x`))).toBe(true);
      expect(passes(run("/api/me", `${SESSION_COOKIE_PLAIN}=x`))).toBe(true);
      // The extension's key as well.
      expect(passes(runWith("/api/extension/session", { authorization: "Bearer x" }))).toBe(true);
    });

    it.each([
      "/auth/google",
      "/auth/google?next=%2Fjobs",
      "/auth/google/callback?code=x&state=y",
      "/auth/signout",
      "/privacy",
      "/api/health",
      "/_next/static/chunks/app.js",
      "/favicon.ico",
      "/robots.txt",
    ])("leaves %s alone", (p) => {
      signedInEnv({ GOOGLE_CLIENT_ID: "" });
      expect(passes(run(p))).toBe(true);
    });
  });

  it("matches everything except Next's assets and the favicon", () => {
    expect(config.matcher).toEqual(["/((?!_next/|favicon\\.ico$).*)"]);
  });

  it("knows the session cookie names of auth/session.ts and imports no database code", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../../src/proxy.ts"), "utf8");
    expect(source).toContain(`"${SESSION_COOKIE_SECURE}"`);
    expect(source).toContain(`"${SESSION_COOKIE_PLAIN}"`);
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["@/lib/domain/safe-next", "@/lib/server/env", "next/server"]);
  });
});
