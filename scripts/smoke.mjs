#!/usr/bin/env node
// Smoke test for a running build: the pages and redirects a release can break while
// /api/health (which only asks the database) still answers 200.
//
//   node scripts/smoke.mjs <base-url>      e.g. http://127.0.0.1:3800
//   npm run smoke -- <base-url>
//
// CI runs it against `npm start` before a release is packaged. On the server, app-deploy runs
// the release's `npm run smoke` against the new release after its health check, and rolls back
// when it fails (docs/plan/3-deploy-cicd.md, "Smoke test").
//
// It works in both sign-in modes and tells them apart by GET /login: 200 when sign-in is
// configured, a 307 to /login?error=not_configured when it is locked (src/proxy.ts).
//
// Redirects are followed by hand, at most MAX_HOPS, and always against the base URL. A Location
// is built from APP_URL, which on the server is the public origin, so only its path and query
// are compared.
//
// Plain Node with no dependencies: the release has no devDependencies. Reads no environment.
// Prints one line per check (method, path, statuses, ok or FAIL and why) and never a header, a
// cookie value or a body: the output lands in public CI logs and in the server's deploy log.
// Exit 0 when every check passes, 1 when one fails, 2 on a usage error.
import { randomUUID } from "node:crypto";

const MAX_HOPS = 5;
const REQUEST_TIMEOUT_MS = 10_000;
// app-deploy stops the run after 60 s. Checks still waiting when this budget runs out fail.
const TOTAL_BUDGET_MS = 40_000;

// The proxy lets any non-empty session cookie through to the page (src/proxy.ts). route() turns
// this one away before any query (src/lib/server/auth/guard.ts): over http it is not a
// well-formed token, and over https only the __Host- cookie is read at all.
const JUNK_COOKIE = "jt_session=smoke-not-a-session";
const WITH_COOKIE = "[junk cookie]";

const NOT_CONFIGURED = "not_configured";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function usage(problem) {
  // The argument is not echoed: it could carry credentials.
  console.error(`smoke: ${problem}`);
  console.error("usage: node scripts/smoke.mjs <base-url>   (an http or https origin, e.g. http://127.0.0.1:3800)");
  process.exit(2);
}

/** The base URL's origin, or a usage error. */
function parseBase(args) {
  if (args.length === 0) usage("the base URL is missing");
  if (args.length > 1) usage("expected exactly one argument");
  let url;
  try {
    url = new URL(args[0]);
  } catch {
    usage("the base URL is not a valid URL");
  }
  const isOrigin =
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  if (!isOrigin) usage("the base URL must be an origin, without credentials, path or query");
  return url.origin;
}

const base = parseBase(process.argv.slice(2));
const deadline = Date.now() + TOTAL_BUDGET_MS;

/**
 * One GET without following redirects. { status, location, html } or { error }. The body is read
 * to the end (and dropped): a streamed page can still fail after its status line.
 */
async function request(path, cookie) {
  const left = deadline - Date.now();
  if (left <= 0) return { error: "out of time" };
  const timeout = Math.min(REQUEST_TIMEOUT_MS, left);
  try {
    const res = await fetch(new URL(path, base), {
      redirect: "manual",
      headers: cookie ? { cookie } : {},
      signal: AbortSignal.timeout(timeout),
    });
    const html = /^text\/html\b/i.test(res.headers.get("content-type") ?? "");
    const location = res.headers.get("location");
    await res.arrayBuffer();
    return { status: res.status, location, html };
  } catch (err) {
    if (err?.name === "TimeoutError") return { error: `no complete answer within ${Math.ceil(timeout / 1000)} s` };
    // A code such as ECONNREFUSED; never the message, which can quote the request.
    const code = err?.cause?.code;
    return { error: `no answer (${typeof code === "string" ? code : (err?.name ?? "error")})` };
  }
}

/** A Location's path and query, resolved against the base URL; null when it does not parse. */
function pathOf(location) {
  try {
    const url = new URL(location, base);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** True when `path` is /login and each given query parameter has that value (null: absent). */
function isLogin(path, params = {}) {
  const url = new URL(path, base);
  if (url.pathname !== "/login") return false;
  return Object.entries(params).every(([name, value]) => url.searchParams.get(name) === value);
}

/**
 * GET `path`, then each redirect by hand. Returns every hop ({ path, status, html }) and an error
 * when a request failed, a redirect had no usable Location, a path came round again, or there
 * were more than MAX_HOPS redirects.
 */
async function follow(path, cookie) {
  const hops = [];
  const seen = new Set();
  let current = path;
  for (;;) {
    seen.add(current);
    const res = await request(current, cookie);
    if (res.error) return { hops, error: res.error };
    hops.push({ path: current, status: res.status, html: res.html });
    if (!REDIRECTS.has(res.status)) return { hops };
    const next = res.location ? pathOf(res.location) : null;
    if (!next) return { hops, error: "a redirect without a usable Location" };
    if (seen.has(next)) return { hops, error: "redirect loop" };
    if (hops.length > MAX_HOPS) return { hops, error: `more than ${MAX_HOPS} redirects` };
    current = next;
  }
}

let passed = 0;
let failed = 0;

/** Prints one check's line. `problem` null or undefined: the check passed. */
function report(label, statuses, problem, note) {
  const shown = statuses.length > 0 ? statuses.join(" -> ") : "-";
  const verdict = problem ? `FAIL: ${problem}` : `ok${note ? ` (${note})` : ""}`;
  console.log(`${label.padEnd(60)} ${shown.padEnd(16)} ${verdict}`);
  if (problem) failed++;
  else passed++;
}

const statusesOf = (result) => result.hops.map((hop) => hop.status);
const last = (result) => result.hops.at(-1);

/** Ends at /login (with the locked mode's error code when given) answering 200 HTML. */
function endsAtLogin(result, params) {
  const end = last(result);
  return !result.error && end.status === 200 && end.html && isLogin(end.path, params);
}

/** A single answer that must have `status` (and be HTML when `html`). */
async function expectStatus(path, status, { cookie, html = false } = {}) {
  const label = `GET ${path}${cookie ? ` ${WITH_COOKIE}` : ""}`;
  const res = await request(path, cookie);
  if (res.error) return report(label, [], res.error);
  const ok = res.status === status && (!html || res.html);
  report(label, [res.status], ok ? null : `expected ${status}${html ? " HTML" : ""}`);
}

/** GET /login: the sign-in mode, "configured" or "locked", or null when the answer fits neither. */
async function checkLogin() {
  const label = "GET /login";
  const result = await follow("/login");
  if (result.error) {
    report(label, statusesOf(result), result.error);
    return null;
  }
  const [first, second] = result.hops;
  if (result.hops.length === 1 && first.status === 200 && first.html) {
    report(label, statusesOf(result), null, "sign-in configured");
    return "configured";
  }
  const locked =
    result.hops.length === 2 &&
    first.status === 307 &&
    isLogin(second.path, { error: NOT_CONFIGURED, next: null }) &&
    endsAtLogin(result);
  if (locked) {
    report(label, statusesOf(result), null, "sign-in locked");
    return "locked";
  }
  report(label, statusesOf(result), "expected 200 HTML, or a 307 to /login?error=not_configured that answers 200 HTML");
  return null;
}

/** Signed out, / goes to /login?next=/ (with the locked mode's error code) and that page loads. */
async function checkSignedOutHome(mode) {
  const label = "GET /";
  const result = await follow("/");
  if (result.error) return report(label, statusesOf(result), result.error);
  const [first, second] = result.hops;
  const params = { next: "/" };
  if (mode) params.error = mode === "locked" ? NOT_CONFIGURED : null;
  if (first.status !== 307 || !second || !isLogin(second.path, params)) {
    const expected = mode === "locked" ? "/login?error=not_configured&next=%2F" : "/login?next=%2F";
    return report(label, statusesOf(result), `expected a 307 to ${expected}`);
  }
  report(label, statusesOf(result), endsAtLogin(result) ? null : "expected to end at /login answering 200 HTML");
}

/**
 * A page with a session cookie the proxy accepts: configured, the page itself answers 200 HTML
 * (pages read no data on the server, so a junk session renders the same shell); locked, it ends
 * at /login?error=not_configured answering 200 HTML.
 */
async function checkPageWithCookie(path, mode) {
  const label = `GET ${path} ${WITH_COOKIE}`;
  if (mode === "configured") return expectStatus(path, 200, { cookie: JUNK_COOKIE, html: true });
  if (mode === "locked") {
    const result = await follow(path, JUNK_COOKIE);
    if (result.error) return report(label, statusesOf(result), result.error);
    const ok = endsAtLogin(result, { error: NOT_CONFIGURED });
    return report(label, statusesOf(result), ok ? null : "expected to end at /login?error=not_configured answering 200 HTML");
  }
  // The expectation depends on the mode, which GET /login could not tell (already a failure).
  console.log(`${label.padEnd(60)} ${"-".padEnd(16)} skipped: sign-in mode unknown`);
}

async function main() {
  console.log(`smoke: checking ${base}`);
  await expectStatus("/api/health", 200);
  await expectStatus("/privacy", 200, { html: true });
  const mode = await checkLogin();
  await checkSignedOutHome(mode);
  // /extension/connect sits outside the sidebar layout, like /login: a page of its own to break.
  for (const path of ["/", "/activity", "/review", "/settings", `/jobs/${randomUUID()}`, "/extension/connect"]) {
    await checkPageWithCookie(path, mode);
  }
  // The proxy passes the cookie on; the route's own guard must refuse it.
  await expectStatus("/api/jobs", 401, { cookie: JUNK_COOKIE });

  if (failed > 0) {
    console.log(`smoke: ${failed} of ${passed + failed} checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`smoke: all ${passed} checks passed`);
  }
}

try {
  await main();
} catch (err) {
  console.error(`smoke: failed: ${err instanceof Error ? err.name : "unknown error"}`);
  process.exitCode = 1;
}
