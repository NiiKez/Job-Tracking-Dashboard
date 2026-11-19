import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/domain/safe-next";
import { appUrl, signInMode, type SignInMode } from "@/lib/server/env";

/**
 * A convenience layer, not the security boundary (route() in src/lib/server/auth/guard.ts is).
 * It only looks at whether a session cookie exists and at the sign-in mode (signInMode() in
 * src/lib/server/env.ts). In Google mode (the real app):
 * - a page without one → redirect to /login?next=<path and query>;
 * - /api/* without one → 401 { error: "Not signed in" }, except
 *   - a request with `Authorization: Bearer …`: the Chrome extension calls its key routes with a
 *     key instead of the cookie (docs/plan/4-chrome-extension.md). It goes on to the handler,
 *     where route() checks the key; a cookie route ignores the header and answers 401 itself;
 *   - the Gmail connect flow's two browser navigations (GET /api/inbox/connect and
 *     /api/inbox/callback), which go to /login?next=/settings like a page.
 * - /login/demo (the public demo's entry page) → /login.
 * - /auth/demo (the demo's entry route) is rewritten to a path that does not exist, so every
 *   method gets Next's own 404 page, exactly as an unknown path does. The route answers 404
 *   itself outside demo mode as well (src/app/auth/demo/route.ts); this makes the two look alike.
 * Open: /login, /auth/*, /privacy, /api/health, /_next/*, and paths whose last segment has a dot
 * (files). /privacy is the privacy policy Google's consent screen links to: it must load signed out.
 *
 * Locked mode (sign-in not configured: docs/plan/1-backend-core.md, "Locked mode"): /login is
 * redirected to /login?error=not_configured unless it already says so, and every other page that
 * is not open goes there too, cookie or not; so does /login/demo. /auth/demo is rewritten as in
 * Google mode. /api/* is unchanged (route() answers 401 anyway). A malformed environment counts
 * as locked.
 *
 * Demo mode (DEMO_MODE=on, the public demo: docs/plan/5-public-demo.md, "Step 6"): the entry page
 * /login/demo takes the place of /login. /login (whatever its query) and every signed-out page
 * go there, without ?next= (entering always lands on /). A page with a session cookie passes as
 * in Google mode, and so does /login/demo itself: a visitor inside a workspace may open it, and
 * "Try the demo" there starts over (POST /auth/demo replaces their workspace), so the proxy never
 * sends anyone away from it. /api/*, /auth/*, /privacy and files behave as in Google mode, except
 * that the inbox flows' navigations go to /login/demo too. Every response the proxy handles
 * carries X-Robots-Tag: noindex, nofollow (search engines are told not to index the demo);
 * Next's assets and the favicon never reach it (config.matcher).
 *
 * Imports no database code. Redirects are built from APP_URL, never from request headers. Without
 * APP_URL the browser gets a relative Location: see redirect().
 */

// The names from src/lib/server/auth/session.ts, which this file cannot import (it pulls in the
// database client). tests/unit/auth/proxy.test.ts checks they match.
const SESSION_COOKIES = ["__Host-jt_session", "jt_session"];

// The ?error= code the login page shows as "Sign-in isn't set up on this server yet."
const NOT_CONFIGURED = "not_configured";

/** The public demo's entry page (src/app/login/demo/page.tsx). */
const DEMO_LOGIN = "/login/demo";
/** The public demo's entry route (src/app/auth/demo/route.ts), and where it goes outside the demo. */
const DEMO_ENTRY = "/auth/demo";
const NOT_FOUND = "/auth/demo/not-found";

/** What the demo's responses tell search engines (docs/plan/5-public-demo.md, "Defaults I chose"). */
const NO_INDEX = "noindex, nofollow";

function isOpen(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/auth" ||
    pathname.startsWith("/auth/") ||
    // Exactly the page: a static Server Component that reads no session and no data.
    pathname === "/privacy" ||
    pathname === "/api/health" ||
    pathname.startsWith("/_next/") ||
    // Next's own development endpoints (error overlay, stack frames).
    pathname.startsWith("/__nextjs") ||
    // A file: favicon.ico, robots.txt, images. A dynamic segment with a dot also passes here
    // unchecked (/jobs/a.b, /api/jobs/a.b). That is safe: route() guards every API handler, and
    // pages read no data on the server; they fetch it from /api in the browser.
    // tests/unit/boundaries.test.ts fails a page or layout that imports server code.
    /\.[^/]*$/.test(pathname)
  );
}

function isApi(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/** `Authorization: Bearer <something>`: whether the key is any good is route()'s question. */
function hasBearer(req: NextRequest): boolean {
  return /^bearer[ \t]+\S/i.test(req.headers.get("authorization") ?? "");
}

/** API paths a browser navigates to (src/lib/server/inbox/oauth/connect.ts); sign-in returns to Settings. */
const INBOX_FLOWS = new Set(["/api/inbox/connect", "/api/inbox/callback"]);

/** The sign-in mode; a malformed environment counts as locked. */
function currentMode(): SignInMode {
  try {
    return signInMode();
  } catch {
    return "locked";
  }
}

/**
 * A 307 to a path on this site.
 *
 * The Location must be absolute here: Next's proxy adapter (next/dist/server/web/adapter.js)
 * parses it with new URL() and no base, so a relative one throws and the request answers 500.
 * With APP_URL it is built from APP_URL. Without it, it is built on req.nextUrl's origin (under
 * `next start` the server's own hostname and port, not the Host header), and the adapter turns a
 * Location on the request URL's host into a relative one before sending it. Either way no host
 * from the request reaches the browser.
 */
function redirect(req: NextRequest, path: string): Response {
  let base: URL | string = req.nextUrl.origin;
  try {
    base = appUrl() ?? base;
  } catch {
    // A malformed environment stops the start (src/instrumentation.ts); keep the request's origin.
  }
  return new Response(null, {
    status: 307,
    headers: { Location: new URL(path, base).href, "Cache-Control": "no-store" },
  });
}

/** 307 to /login[?error=…][&next=…]; `next` is kept only when safeNextPath accepts it. */
function redirectToLogin(req: NextRequest, nextPath: string | null, error?: typeof NOT_CONFIGURED): Response {
  const next = safeNextPath(nextPath);
  const params = [
    ...(error ? [`error=${encodeURIComponent(error)}`] : []),
    ...(next ? [`next=${encodeURIComponent(next)}`] : []),
  ];
  return redirect(req, params.length > 0 ? `/login?${params.join("&")}` : "/login");
}

/** Where a signed-out visitor signs in: the demo's entry page, or /login (with the locked code). */
function toSignIn(req: NextRequest, mode: SignInMode, nextPath: string | null): Response {
  if (mode === "demo") return redirect(req, DEMO_LOGIN);
  return redirectToLogin(req, nextPath, mode === "locked" ? NOT_CONFIGURED : undefined);
}

export function proxy(req: NextRequest): Response {
  const mode = currentMode();
  const res = decide(req, mode);
  if (mode === "demo") res.headers.set("X-Robots-Tag", NO_INDEX);
  return res;
}

function decide(req: NextRequest, mode: SignInMode): Response {
  const { pathname, search, searchParams } = req.nextUrl;
  if (pathname === "/login") {
    if (mode === "demo") return redirect(req, DEMO_LOGIN);
    // The page reads ?error= in the browser (src/components/auth/sign-in.tsx). The redirect always
    // lands on error=not_configured, which passes here: no loop.
    if (mode === "locked" && searchParams.get("error") !== NOT_CONFIGURED) {
      return redirectToLogin(req, searchParams.get("next"), NOT_CONFIGURED);
    }
  }
  // The demo's entry page and route exist in every build. Outside the demo the page leads to the
  // real sign-in, and the route is as unknown as any path that has no page (Next's 404).
  if (pathname === DEMO_LOGIN && mode !== "demo") return toSignIn(req, mode, null);
  if (pathname === DEMO_ENTRY && mode !== "demo") return NextResponse.rewrite(new URL(NOT_FOUND, req.nextUrl));
  if (isOpen(pathname)) return NextResponse.next();
  const hasSession = SESSION_COOKIES.some((name) => req.cookies.get(name)?.value);
  if (isApi(pathname)) {
    if (hasSession || hasBearer(req)) return NextResponse.next();
    if (INBOX_FLOWS.has(pathname) && req.method === "GET") return toSignIn(req, mode, "/settings");
    return Response.json({ error: "Not signed in" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (mode === "locked") return toSignIn(req, mode, `${pathname}${search}`);
  if (hasSession) return NextResponse.next();
  return toSignIn(req, mode, `${pathname}${search}`);
}

export const config = {
  // Static assets never reach the proxy; the same paths are open in isOpen() as well.
  matcher: ["/((?!_next/|favicon\\.ico$).*)"],
};
