import "server-only";
import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { isSitePath } from "@/lib/domain/safe-next";
import { getDb } from "@/lib/server/db/client";
import { appOrigin, appUrl, signInConfig, signInMode } from "@/lib/server/env";
import { BadRequestError, isErrorNamed, PayloadTooLargeError, UnauthorizedError } from "@/lib/server/errors";
import { deleteSession } from "@/lib/server/repo/sessions";
import type { User } from "@/lib/server/repo/users";
import { mayUse } from "./access";
import { authenticateExtensionKey } from "./extension-key";
import { clearedSessionCookie, extendSession, lookupSession } from "./session";

/**
 * The check that counts (docs/plan/1-backend-core.md, "Three layers"). Every API Route Handler
 * except /api/health is written as
 *
 *   export const GET = route(async ({ req, user, params }) => …);
 *   export const POST = route(async ({ req, user }) => create(user.id, await readJson(req, schema)), { status: 201 });
 *   export const PATCH = route<{ id: string }>(async ({ req, user, params }) => …);  // dynamic segments
 *   export const GET = route(async ({ user, extensionKeyId }) => …, { auth: "extension" });  // key routes
 *
 * Sign-in modes (signInMode() in env.ts; docs/plan/5-public-demo.md, "Three sign-in modes"):
 *   google  the real app: Google sign-in for the addresses on ALLOWED_EMAILS. A session passes
 *           while its user is on the allowlist and is not a demo user.
 *   demo    the public demo (DEMO_MODE=on): no Google values at all; visitors get a workspace
 *           (a demo user and a session of fixed lifetime, never extended: session.ts) from
 *           POST /auth/demo. A session passes only when its user is a demo user. The key routes
 *           stay shut (below).
 *   locked  neither: every request is signed out and no session is looked up.
 * Who passes is mayUse() in access.ts, asked on every request after the session lookup.
 *
 * route():
 * 1. awaits connection(), so nothing is prerendered at build time and no environment is read then;
 * 2. answers 401 to everything while sign-in is locked (signInMode() is "locked");
 * 3. for any method but GET and HEAD: 403 unless Origin equals APP_URL's origin (a missing Origin
 *    is refused) and Content-Type is application/json (parameters allowed). A cross-site form
 *    cannot send JSON, and SameSite=Lax keeps the cookie off other sites' subrequests. APP_URL is
 *    set in google mode and required in demo mode (checkEnv);
 * 4. reads the session cookie before any query: none → 401; malformed, unknown or expired → 401
 *    and clears it; a user who may not use the app (mayUse(): google mode, the email no longer on
 *    ALLOWED_EMAILS, or a demo user; demo mode, anyone but a demo user) → 401, deletes that
 *    session and clears the cookie;
 * 5. runs the handler: a Response passes through, anything else is sent as JSON with
 *    `opts.status` (default 200). The sliding-expiry cookie is added when the session was extended
 *    (also to error responses, except a 401);
 * 6. maps errors: ZodError → 400 { error: "Invalid request", issues }; BadRequestError → 400,
 *    UnauthorizedError → 401, NotFoundError → 404, ConflictError → 409, PayloadTooLargeError →
 *    413, each { error: message }; anything else → 500 { error: "Something went wrong" }, logged.
 *
 * Every response it produces carries Cache-Control: no-store.
 *
 * Key routes: route(handler, { auth: "extension" }) is the Chrome extension's variant
 * (docs/plan/4-chrome-extension.md, "Key routes"). Its requests come from chrome-extension://
 * with a key of their own (src/lib/server/auth/extension-key.ts), never with the cookie:
 * 1. awaits connection() and answers 401 unless Google sign-in is set up (signInConfig() is not
 *    null): in locked mode, and in the demo too, which has no extension (a key does not expire,
 *    a workspace does). The demo's cookie routes for the extension refuse with 403 (access.ts);
 * 2. for any method but GET and HEAD: 403 unless Content-Type is application/json. No Origin
 *    check: a browser never attaches the key by itself, so another site cannot send it;
 * 3. `Authorization: Bearer <key>`: missing, malformed, unknown or revoked → 401; the key's user
 *    may not use the app (mayUse(): no longer on ALLOWED_EMAILS, or a demo user) → 401 and the
 *    key is deleted. last_used_at moves when due;
 * 4. runs the handler with `user` and `extensionKeyId`, and maps errors as in 6. above.
 * Its 401s carry WWW-Authenticate: Bearer. The session cookie is never read, set or cleared.
 * The other way round, cookie routes never look at an Authorization header (extensionKeyId is
 * null there).
 *
 * Also here, for handlers that cannot use route() (area 2's redirect flows):
 *   requireUser(req)               the user or UnauthorizedError; never extends the session
 *   authenticate(req, { extend })  the same checks as a result; extends the session when due
 *                                  (unless extend: false) and returns the Set-Cookie to send
 * and readJson(req, schema), and redirectTo(path, setCookies) for redirects built from APP_URL.
 */

/** The signed-in user handed to handlers (and returned by requireUser). */
export type AuthUser = User;

/** A route's awaited params: { id: string } for [id]. Nothing for routes without segments. */
export type RouteParams = Record<string, string | string[] | undefined>;

export interface RouteArgs<P extends RouteParams> {
  req: NextRequest;
  user: AuthUser;
  params: P;
  /** The extension key the request was made with, on key routes; null on cookie routes. */
  extensionKeyId: string | null;
}

export interface RouteOptions {
  /** Status for a non-Response result (default 200), e.g. 201 for a create. */
  status?: number;
  /**
   * "session" (default): the session cookie, with the Origin check. "extension": the Chrome
   * extension's key in `Authorization: Bearer`, no Origin check (see the top of this file).
   */
  auth?: "session" | "extension";
}

/** What Next.js calls: (request, { params }) → Response. Matches the generated RouteContext. */
export type RouteHandler<P extends RouteParams> = (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;

const NOT_SIGNED_IN = "Not signed in";
const SAFE_METHODS = new Set(["GET", "HEAD"]);
/** readJson() refuses larger bodies. The largest legitimate one (a 50 000-character description) is far below. */
export const MAX_JSON_BYTES = 1024 * 1024;

/** What a handler made by route() takes: the session cookie, or the extension's key. */
export type RouteAuth = NonNullable<RouteOptions["auth"]>;

/**
 * Handlers made by route() and what each takes, so tests can tell them from plain functions and
 * pin which routes take the extension's key (tests/unit/routes-use-route.test.ts).
 */
const routeHandlers = new WeakMap<object, RouteAuth>();

/** True if `fn` was made by route(). */
export function isRouteHandler(fn: unknown): boolean {
  return authOf(fn) !== null;
}

/** "session" or "extension" for a handler made by route(); null for anything else. */
export function authOf(fn: unknown): RouteAuth | null {
  return typeof fn === "function" ? (routeHandlers.get(fn) ?? null) : null;
}

export function route<P extends RouteParams = Record<string, never>>(
  handler: (args: RouteArgs<P>) => unknown,
  opts: RouteOptions = {},
): RouteHandler<P> {
  const wrapped: RouteHandler<P> = async (req, ctx) => {
    await connection();
    if (opts.auth === "extension") return runWithKey(req, ctx, handler, opts);
    let setCookie: string | null = null;
    try {
      if (signInMode() === "locked") return notSignedIn(false);
      if (!SAFE_METHODS.has(req.method.toUpperCase()) && !(isSameOrigin(req) && isJson(req))) {
        return json({ error: "Forbidden" }, 403);
      }
      const auth = await authenticate(req);
      if (!auth.ok) return notSignedIn(auth.clearCookie);
      setCookie = auth.setCookie;

      const params = await ctx.params;
      const result = await handler({ req, user: auth.user, params, extensionKeyId: null });
      return withCookies(toResponse(result, opts), setCookie ? [setCookie] : []);
    } catch (err) {
      // A 401 must not re-send the cookie it may be clearing: the browser would keep the session.
      const keep = setCookie && !isErrorNamed(err, "UnauthorizedError") ? [setCookie] : [];
      return withCookies(errorResponse(err), keep);
    }
  };
  // As the handler decides: anything but "extension" is a cookie route.
  routeHandlers.set(wrapped, opts.auth === "extension" ? "extension" : "session");
  return wrapped;
}

/** A key route's request (route(…, { auth: "extension" })): the steps at the top of this file. */
async function runWithKey<P extends RouteParams>(
  req: NextRequest,
  ctx: { params: Promise<P> },
  handler: (args: RouteArgs<P>) => unknown,
  opts: RouteOptions,
): Promise<Response> {
  try {
    // Google mode only: the demo has no extension (see the top of this file).
    if (!signInConfig()) return keyNotSignedIn();
    if (!SAFE_METHODS.has(req.method.toUpperCase()) && !isJson(req)) return json({ error: "Forbidden" }, 403);
    const auth = await authenticateExtensionKey(getDb(), req);
    if (!auth.ok) return keyNotSignedIn();

    const params = await ctx.params;
    const result = await handler({ req, user: auth.user, params, extensionKeyId: auth.keyId });
    return withCookies(toResponse(result, opts), []);
  } catch (err) {
    return withCookies(errorResponse(err, "extension"), []);
  }
}

/* ---------------------------------------------------------------- session */

export type AuthResult =
  | {
      ok: true;
      user: AuthUser;
      /** Set-Cookie re-sending the session cookie after a sliding extension, else null. */
      setCookie: string | null;
    }
  | {
      ok: false;
      /** Send clearedSessionCookie(): the cookie named an unknown, expired or revoked session. */
      clearCookie: boolean;
    };

export interface AuthenticateOptions {
  /**
   * Extend the session when due (default true). The caller must then send `setCookie`, or the
   * cookie can expire before the row. Pass false when the response cannot carry it.
   */
  extend?: boolean;
}

/**
 * The request's user, checked like route() does (locked mode, session, mayUse()), without the
 * Origin and JSON checks. Extends the session when due unless `{ extend: false }`; send the
 * returned `setCookie` with the response. Prefer route(); this is for handlers that must answer
 * with a redirect instead of a 401.
 */
export async function authenticate(req: NextRequest, opts: AuthenticateOptions = {}): Promise<AuthResult> {
  if (signInMode() === "locked") return { ok: false, clearCookie: false };
  const db = getDb();
  const found = await lookupSession(db, req);
  if (found.status === "none") return { ok: false, clearCookie: false };
  if (found.status === "invalid") return { ok: false, clearCookie: true };
  if (!mayUse(found.user)) {
    // Removed from ALLOWED_EMAILS since signing in, or a user of the other mode (a demo user in
    // the real app, a Google account in the demo): end this session now.
    await deleteSession(db, found.session.id);
    return { ok: false, clearCookie: true };
  }
  const setCookie = opts.extend === false ? null : await extendSession(db, found);
  return { ok: true, user: found.user, setCookie };
}

/**
 * The signed-in user, or throws UnauthorizedError (route() turns it into a 401 that clears the
 * cookie when needed). Never extends the session: it has no response to re-send the cookie on,
 * and an extended row whose cookie was not re-sent could outlive the cookie. The next route()
 * call or authenticate() extends it instead.
 */
export async function requireUser(req: NextRequest): Promise<AuthUser> {
  const auth = await authenticate(req, { extend: false });
  if (!auth.ok) throw new UnauthorizedError(auth.clearCookie);
  return auth.user;
}

/* ------------------------------------------------------------- requests */

/** Origin is exactly APP_URL's origin. */
function isSameOrigin(req: Request): boolean {
  const expected = appOrigin();
  return !!expected && req.headers.get("origin") === expected;
}

/** The body is declared as JSON (parameters allowed). */
function isJson(req: Request): boolean {
  const type = req.headers.get("content-type");
  return type !== null && type.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * The request body parsed as JSON and validated: malformed JSON (or an empty body) → 400,
 * a body over MAX_JSON_BYTES → 413, a schema failure → ZodError (400 in route()).
 */
export async function readJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  const text = await readText(req, MAX_JSON_BYTES);
  let data: unknown;
  // PostgreSQL text cannot hold NUL, so a string with one would fail the save with a 500.
  let hasNul = false;
  try {
    data = JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === "string" && value.includes("\u0000")) hasNul = true;
      return value;
    });
  } catch {
    throw new BadRequestError("Invalid JSON");
  }
  if (hasNul) throw new BadRequestError("Text must not contain NUL characters");
  return schema.parse(data);
}

async function readText(req: Request, limit: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError("Request body too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new PayloadTooLargeError("Request body too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/* ------------------------------------------------------------ responses */

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** A handler's result as a response: its own Response, or JSON with `opts.status`. */
function toResponse(result: unknown, opts: RouteOptions): Response {
  return result instanceof Response ? copyResponse(result) : json(result ?? null, opts.status ?? 200);
}

function notSignedIn(clearCookie: boolean): Response {
  return withCookies(json({ error: NOT_SIGNED_IN }, 401), clearCookie ? [clearedSessionCookie()] : []);
}

/** A key route's 401: says which scheme it wants, and never touches the session cookie. */
function keyNotSignedIn(): Response {
  const res = json({ error: NOT_SIGNED_IN }, 401);
  res.headers.set("WWW-Authenticate", "Bearer");
  return res;
}

function errorResponse(err: unknown, auth: RouteOptions["auth"] = "session"): Response {
  if (err instanceof z.ZodError) return json({ error: "Invalid request", issues: err.issues }, 400);
  // By name, not instanceof: see isErrorNamed (an error may come from another bundle's copy).
  if (isErrorNamed(err, "BadRequestError")) return json({ error: err.message }, 400);
  if (isErrorNamed(err, "UnauthorizedError")) {
    return auth === "extension" ? keyNotSignedIn() : notSignedIn(err.clearSessionCookie === true);
  }
  if (isErrorNamed(err, "NotFoundError")) return json({ error: err.message }, 404);
  if (isErrorNamed(err, "ConflictError")) return json({ error: err.message }, 409);
  if (isErrorNamed(err, "PayloadTooLargeError")) return json({ error: err.message }, 413);
  console.error(err);
  return json({ error: "Something went wrong" }, 500);
}

/** A handler's own Response, with headers we may change (Response.redirect's are immutable). */
function copyResponse(res: Response): Response {
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) });
}

/** Adds Set-Cookie values and Cache-Control: no-store (always, overriding the handler's). */
function withCookies(res: Response, setCookies: string[]): Response {
  for (const cookie of setCookies) res.headers.append("Set-Cookie", cookie);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * A 303 to a path on this site, absolute from APP_URL (never from Host or X-Forwarded-*), or a
 * relative Location when APP_URL is missing. Route Handlers send a Location as it is; only the
 * proxy needs an absolute one (src/proxy.ts). No-store, with the given Set-Cookie values.
 * Throws unless `path` is a site path (isSitePath: one leading "/", no "\", no control
 * characters) that, with APP_URL set, resolves to APP_URL's origin.
 */
export function redirectTo(path: string, setCookies: string[] = []): Response {
  if (!isSitePath(path)) throw new Error("redirectTo: path must be a path on this site");
  const base = appUrl();
  let location = path;
  if (base) {
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error("redirectTo: path must be a path on this site");
    location = url.href;
  }
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}
