import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GET as getMe } from "@/app/api/me/route";
import { GET as listJobs, POST as createJob } from "@/app/api/jobs/route";
import { DELETE as deleteJob } from "@/app/api/jobs/[id]/route";
import { POST as addRule } from "@/app/api/rules/route";
import { GET as getExtensionSession } from "@/app/api/extension/session/route";
import { authenticate, MAX_JSON_BYTES, readJson, redirectTo, requireUser, route } from "@/lib/server/auth/guard";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "@/lib/server/errors";
import { createExtensionKey } from "@/lib/server/services/extension";
import { describeDb, testSql } from "../helpers/test-db";
import { APP_ORIGIN, restoreEnv, setEnv, signedInEnv } from "../unit/auth/env";
import { ctx, request, setCookieFor, setCookies, signedIn } from "./helpers";

// connection() needs a request scope; called directly, handlers only need it to resolve.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

const SESSION = "__Host-jt_session";
const THIRTY_DAYS = 30 * 24 * 60 * 60;
const CLEARED = `${SESSION}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`;

/** Makes every session due for a sliding extension: last extended 2 days ago, 3 days left. */
async function dueForExtension() {
  await testSql()`UPDATE sessions SET last_seen_at = now() - interval '2 days', expires_at = now() + interval '3 days'`;
}

async function sessionTimes() {
  return testSql()<{ expires_at: Date; last_seen_at: Date }[]>`SELECT expires_at, last_seen_at FROM sessions`;
}

async function expectNotSignedIn(res: Response, { cleared }: { cleared: boolean }) {
  expect(res.status).toBe(401);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ error: "Not signed in" });
  const cookie = setCookieFor(res, SESSION);
  if (cleared) {
    expect(cookie).toMatch(/^__Host-jt_session=; Path=\/; Max-Age=0; .*Secure; HttpOnly; SameSite=Lax$/);
  } else {
    expect(cookie).toBeUndefined();
  }
}

async function sessionCount(): Promise<number> {
  const [row] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM sessions`;
  return row.n;
}

describeDb("route(): the check on every API handler", () => {
  beforeEach(() => signedInEnv());
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  /* ------------------------------------------------------------ sign-in */

  it("a protected GET answers 401 when signed out", async () => {
    await expectNotSignedIn(await getMe(request("/api/me"), ctx()), { cleared: false });
    await expectNotSignedIn(await listJobs(request("/api/jobs"), ctx()), { cleared: false });
  });

  it("answers 200 with no-store for a valid session", async () => {
    const { cookie } = await signedIn();
    const res = await getMe(request("/api/me", { cookie }), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      email: "owner@example.com",
      name: "Olive Owner",
      pictureUrl: "https://lh3.googleusercontent.com/a/one",
    });
    // Fresh session: no cookie re-sent.
    expect(setCookies(res)).toEqual([]);
  });

  it("answers 401 to everything in locked mode, even with a valid session, and keeps the session", async () => {
    const { cookie } = await signedIn();
    for (const missing of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAILS", "APP_URL"] as const) {
      signedInEnv({ [missing]: "" });
      // Not even the session lookup runs: no database involved.
      await expectNotSignedIn(await getMe(request("/api/me", { cookie }), ctx()), { cleared: false });
      await expectNotSignedIn(
        await createJob(request("/api/jobs", { method: "POST", cookie, body: "{}" }), ctx()),
        { cleared: false },
      );
    }
    expect(await sessionCount()).toBe(1);
  });

  it("ignores a plain jt_session cookie over https", async () => {
    const { token } = await signedIn();
    await expectNotSignedIn(await getMe(request("/api/me", { cookie: `jt_session=${token}` }), ctx()), {
      cleared: false,
    });
  });

  it("answers 401 and clears the cookie for a malformed or unknown token", async () => {
    await expectNotSignedIn(await getMe(request("/api/me", { cookie: `${SESSION}=junk` }), ctx()), {
      cleared: true,
    });
    const unknown = Buffer.alloc(32, 1).toString("base64url");
    await expectNotSignedIn(await getMe(request("/api/me", { cookie: `${SESSION}=${unknown}` }), ctx()), {
      cleared: true,
    });
  });

  it("answers 401 and clears the cookie for an expired session", async () => {
    const { cookie } = await signedIn();
    await testSql()`UPDATE sessions SET expires_at = now() - interval '1 minute'`;
    await expectNotSignedIn(await getMe(request("/api/me", { cookie }), ctx()), { cleared: true });
  });

  it("answers 401, deletes the session and clears the cookie once the email leaves the allowlist", async () => {
    const { cookie } = await signedIn();
    signedInEnv({ ALLOWED_EMAILS: "someone-else@example.com" });
    await expectNotSignedIn(await getMe(request("/api/me", { cookie }), ctx()), { cleared: true });
    expect(await sessionCount()).toBe(0);
    // Back on the list: the session is gone for good.
    signedInEnv();
    await expectNotSignedIn(await getMe(request("/api/me", { cookie }), ctx()), { cleared: true });
  });

  it("extends a session last extended over a day ago and re-sends the cookie", async () => {
    const { cookie, token } = await signedIn();
    await testSql()`UPDATE sessions SET last_seen_at = now() - interval '2 days', expires_at = now() + interval '3 days'`;
    const res = await getMe(request("/api/me", { cookie }), ctx());
    expect(res.status).toBe(200);
    expect(setCookieFor(res, SESSION)).toBe(
      `${SESSION}=${token}; Path=/; Max-Age=${THIRTY_DAYS}; Secure; HttpOnly; SameSite=Lax`,
    );
    const [row] = await testSql()<{ days: number }[]>`
      SELECT extract(epoch FROM expires_at - now()) / 86400 AS days FROM sessions`;
    expect(Number(row.days)).toBeGreaterThan(29.9);
  });

  it("a 401 thrown by the handler after an extension only clears the cookie, never re-sends it", async () => {
    const { cookie, token } = await signedIn();
    const extended = `${SESSION}=${token}; Path=/; Max-Age=${THIRTY_DAYS}; Secure; HttpOnly; SameSite=Lax`;

    await dueForExtension();
    const clearing = await route(() => {
      throw new UnauthorizedError(true);
    })(request("/x", { cookie }), ctx());
    expect(clearing.status).toBe(401);
    expect(setCookies(clearing)).toEqual([CLEARED]);

    await dueForExtension();
    const plain = await route(() => {
      throw new UnauthorizedError(false);
    })(request("/x", { cookie }), ctx());
    expect(plain.status).toBe(401);
    expect(setCookies(plain)).toEqual([]);

    // Any other error still carries the extension: the session stays valid.
    await dueForExtension();
    const notFound = await route(() => {
      throw new NotFoundError("Job x not found");
    })(request("/x", { cookie }), ctx());
    expect(notFound.status).toBe(404);
    expect(setCookies(notFound)).toEqual([extended]);
  });

  /* ---------------------------------------------------- cross-site checks */

  it("refuses a changing request from another origin, or without Origin, with 403", async () => {
    const { cookie } = await signedIn();
    for (const origin of ["https://evil.example", "http://jobs.example.com", `${APP_ORIGIN}:443`, "null", null]) {
      const res = await createJob(request("/api/jobs", { method: "POST", cookie, origin, body: "{}" }), ctx());
      expect(res.status).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Forbidden" });
    }
  });

  it("refuses a changing request whose body is not declared as JSON, with 403", async () => {
    const { cookie } = await signedIn();
    for (const contentType of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/jsonx",
      "application/json-patch+json",
      null,
    ]) {
      const res = await addRule(
        request("/api/rules", { method: "POST", cookie, contentType, body: '{"status":"offer"}' }),
        ctx(),
      );
      expect(res.status).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    // DELETE carries no body but must still say JSON (the client always does).
    const del = await deleteJob(request("/api/jobs/x", { method: "DELETE", cookie, contentType: null }), ctx({ id: "x" }));
    expect(del.status).toBe(403);
  });

  it("checks Origin and JSON before the session (no cookie needed for the 403)", async () => {
    const res = await createJob(request("/api/jobs", { method: "POST", origin: "https://evil.example" }), ctx());
    expect(res.status).toBe(403);
  });

  it("accepts the app's origin with application/json, parameters and case allowed", async () => {
    const { cookie } = await signedIn();
    const echo = route(async ({ req }) => readJson(req, z.object({ a: z.number() })));
    for (const contentType of ["application/json", "application/json; charset=utf-8", "Application/JSON"]) {
      const res = await echo(request("/x", { method: "POST", cookie, contentType, body: '{"a":1}' }), ctx());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ a: 1 });
    }
  });

  it("a signed-out changing request from the app gets 401, not the handler", async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const post = route(handler);
    await expectNotSignedIn(await post(request("/x", { method: "POST", body: "{}" }), ctx()), { cleared: false });
    expect(handler).not.toHaveBeenCalled();
  });

  /* -------------------------------------------------- results and errors */

  it("passes the user and the awaited params to the handler", async () => {
    const { cookie, user } = await signedIn();
    const handler = vi.fn(({ user: u, params }: { user: unknown; params: { id: string } }) => ({ u, params }));
    const get = route<{ id: string }>(handler);
    const res = await get(request("/x/42", { cookie }), ctx({ id: "42" }));
    expect(await res.json()).toEqual({ u: user, params: { id: "42" } });
  });

  it("sends opts.status for a plain result, and passes a Response through with no-store", async () => {
    const { cookie } = await signedIn();
    const created = route(() => ({ id: "1" }), { status: 201 });
    expect((await created(request("/x", { method: "POST", cookie }), ctx())).status).toBe(201);

    const redirect = route(() => Response.redirect("https://jobs.example.com/next", 303));
    const res = await redirect(request("/x", { cookie }), ctx());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://jobs.example.com/next");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const cached = route(() => new Response("x", { headers: { "Cache-Control": "public, max-age=600" } }));
    expect((await cached(request("/x", { cookie }), ctx())).headers.get("cache-control")).toBe("no-store");
  });

  it("maps errors to 400, 404, 409 and 500, each with no-store", async () => {
    const { cookie } = await signedIn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: Array<[() => unknown, number, unknown]> = [
      [() => z.object({ a: z.string() }).parse({}), 400, { error: "Invalid request", issues: expect.any(Array) }],
      [() => { throw new BadRequestError("Nothing to confirm"); }, 400, { error: "Nothing to confirm" }],
      [() => { throw new NotFoundError("Job x not found"); }, 404, { error: "Job x not found" }],
      [() => { throw new ConflictError("Another job has this link"); }, 409, { error: "Another job has this link" }],
      [() => { throw new Error("secret detail: postgres://x"); }, 500, { error: "Something went wrong" }],
    ];
    for (const [fn, status, body] of cases) {
      const res = await route(fn)(request("/x", { cookie }), ctx());
      expect(res.status).toBe(status);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual(body);
    }
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("maps the errors of another copy of errors.ts by name, as the scheduler's bundle throws them", async () => {
    // Next.js bundles src/instrumentation.ts (the inbox scheduler and its engine) apart from the
    // routes: a route that joins a sync the scheduler started gets that bundle's classes, which
    // instanceof does not recognise. Plain Errors with the same name and fields stand in for them.
    const foreign = (name: string, message: string, fields: Record<string, unknown> = {}) =>
      Object.assign(new Error(message), { name, ...fields });
    const { cookie, token } = await signedIn();
    const extended = `${SESSION}=${token}; Path=/; Max-Age=${THIRTY_DAYS}; Secure; HttpOnly; SameSite=Lax`;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: Array<[Error, number, unknown]> = [
      [foreign("BadRequestError", "Nothing to confirm"), 400, { error: "Nothing to confirm" }],
      [foreign("NotFoundError", "Job x not found"), 404, { error: "Job x not found" }],
      [foreign("ConflictError", "Connect Gmail in Settings first."), 409, { error: "Connect Gmail in Settings first." }],
      [foreign("PayloadTooLargeError", "Request body too large"), 413, { error: "Request body too large" }],
    ];
    for (const [err, status, body] of cases) {
      await dueForExtension();
      const res = await route(() => {
        throw err;
      })(request("/x", { cookie }), ctx());
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
      expect(setCookies(res)).toEqual([extended]);
    }

    // A 401 from another copy clears the cookie when asked to, and never re-sends the extension.
    await dueForExtension();
    const clearing = await route(() => {
      throw foreign("UnauthorizedError", "Not signed in", { clearSessionCookie: true });
    })(request("/x", { cookie }), ctx());
    expect(clearing.status).toBe(401);
    expect(setCookies(clearing)).toEqual([CLEARED]);
    expect(log).not.toHaveBeenCalled();
  });

  it("readJson: malformed or empty JSON is a 400, a schema failure lists the issues", async () => {
    const { cookie } = await signedIn();
    const post = route(async ({ req }) => readJson(req, z.object({ title: z.string().min(1) })));
    for (const body of ["{not json", "", "undefined"]) {
      const res = await post(request("/x", { method: "POST", cookie, body }), ctx());
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid JSON" });
    }
    const res = await post(request("/x", { method: "POST", cookie, body: '{"title":""}' }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).issues[0].path).toEqual(["title"]);
  });

  it("readJson refuses NUL characters in any string with 400, before the database sees them", async () => {
    const { cookie } = await signedIn();
    const post = route(async ({ req }) => readJson(req, z.unknown()));
    for (const body of ['{"title":"a\\u0000b"}', '{"nested":{"list":["ok","\\u0000"]}}']) {
      const res = await post(request("/x", { method: "POST", cookie, body }), ctx());
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Text must not contain NUL characters" });
    }
    // An escaped backslash followed by "u0000" is ordinary text.
    const ok = await post(request("/x", { method: "POST", cookie, body: '{"title":"a\\\\u0000b"}' }), ctx());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ title: "a\\u0000b" });

    // Through a real route: the job is refused, not a 500.
    const res = await createJob(
      request("/api/jobs", {
        method: "POST",
        cookie,
        body: JSON.stringify({ title: "Engineer\u0000", company: "Example", status: "saved" }),
      }),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  it("readJson refuses a body over the limit with 413", async () => {
    const { cookie } = await signedIn();
    const post = route(async ({ req }) => readJson(req, z.unknown()));
    const big = JSON.stringify({ text: "x".repeat(MAX_JSON_BYTES) });
    const res = await post(request("/x", { method: "POST", cookie, body: big }), ctx());
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("requireUser returns the user, or throws a 401 that route() turns into a response", async () => {
    const { cookie, user } = await signedIn();
    expect(await requireUser(request("/x", { cookie }))).toEqual(user);
    await expect(requireUser(request("/x"))).rejects.toMatchObject({ name: "UnauthorizedError" });

    const nested = route(async ({ req }) => {
      await requireUser(new NextRequest(req.url, { headers: { cookie: `${SESSION}=junk` } }));
      return { ok: true };
    });
    await expectNotSignedIn(await nested(request("/x", { cookie }), ctx()), { cleared: true });
  });

  it("requireUser never extends the session, so route() still extends it and re-sends the cookie", async () => {
    const { cookie, token, user } = await signedIn();
    await dueForExtension();
    const before = await sessionTimes();

    expect(await requireUser(request("/x", { cookie }))).toEqual(user);
    expect(await sessionTimes()).toEqual(before);

    const res = await getMe(request("/api/me", { cookie }), ctx());
    expect(setCookieFor(res, SESSION)).toBe(
      `${SESSION}=${token}; Path=/; Max-Age=${THIRTY_DAYS}; Secure; HttpOnly; SameSite=Lax`,
    );
    expect((await sessionTimes())[0].expires_at.getTime()).toBeGreaterThan(before[0].expires_at.getTime());
  });

  it("authenticate extends when due and returns the cookie, unless extend: false", async () => {
    const { cookie, token, user } = await signedIn();
    await dueForExtension();
    const before = await sessionTimes();

    expect(await authenticate(request("/x", { cookie }), { extend: false })).toEqual({
      ok: true,
      user,
      setCookie: null,
    });
    expect(await sessionTimes()).toEqual(before);

    expect(await authenticate(request("/x", { cookie }))).toEqual({
      ok: true,
      user,
      setCookie: `${SESSION}=${token}; Path=/; Max-Age=${THIRTY_DAYS}; Secure; HttpOnly; SameSite=Lax`,
    });
    expect((await sessionTimes())[0].expires_at.getTime()).toBeGreaterThan(before[0].expires_at.getTime());
  });

  describe("route(…, { auth: \"extension\" }): the extension's key routes", () => {
    /** The owner, signed in, with a key for one browser. */
    async function withKey() {
      const session = await signedIn();
      const { token, key } = await createExtensionKey(session.user.id, "Chrome on Linux");
      return { ...session, token, keyId: key.id, authorization: `Bearer ${token}` };
    }

    /** A request from the extension: no Origin, no cookie, JSON for anything but GET. */
    const fromExtension = (path: string, opts: { method?: string; authorization?: string; cookie?: string; body?: string } = {}) =>
      request(path, {
        method: opts.method,
        origin: null,
        cookie: opts.cookie,
        body: opts.body,
        headers: opts.authorization ? { authorization: opts.authorization } : {},
      });

    async function expectKeyRefused(res: Response) {
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(setCookies(res)).toEqual([]);
      expect(await res.json()).toEqual({ error: "Not signed in" });
    }

    async function keyCount(): Promise<number> {
      const [row] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM extension_keys`;
      return row.n;
    }

    it("passes the key's user and the key's id to the handler", async () => {
      const { user, keyId, authorization } = await withKey();
      const handler = vi.fn(({ user: u, extensionKeyId }: { user: unknown; extensionKeyId: string | null }) => ({ u, extensionKeyId }));
      const res = await route(handler, { auth: "extension" })(fromExtension("/x", { authorization }), ctx());
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(await res.json()).toEqual({ u: user, extensionKeyId: keyId });
    });

    it("answers 401 with WWW-Authenticate: Bearer for a missing, malformed or unknown key", async () => {
      const { token } = await withKey();
      const unknown = `jtx_${Buffer.alloc(32, 9).toString("base64url")}`;
      for (const authorization of [undefined, "Bearer", `Basic ${token}`, `Bearer ${token}x`, `Bearer ${token.slice(4)}`, `Bearer ${unknown}`]) {
        await expectKeyRefused(await getExtensionSession(fromExtension("/api/extension/session", { authorization }), ctx()));
      }
    });

    it("answers 401 for a revoked key", async () => {
      const { authorization } = await withKey();
      await testSql()`DELETE FROM extension_keys`;
      await expectKeyRefused(await getExtensionSession(fromExtension("/api/extension/session", { authorization }), ctx()));
    });

    it("answers 401 and deletes the key once the email leaves the allowlist", async () => {
      const { authorization } = await withKey();
      signedInEnv({ ALLOWED_EMAILS: "someone-else@example.com" });
      await expectKeyRefused(await getExtensionSession(fromExtension("/api/extension/session", { authorization }), ctx()));
      expect(await keyCount()).toBe(0);
      signedInEnv();
      await expectKeyRefused(await getExtensionSession(fromExtension("/api/extension/session", { authorization }), ctx()));
    });

    it("answers 401 to everything in locked mode, even with a valid key, and keeps the key", async () => {
      const { authorization } = await withKey();
      const handler = vi.fn(() => ({ ok: true }));
      for (const missing of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAILS", "APP_URL"] as const) {
        signedInEnv({ [missing]: "" });
        await expectKeyRefused(await route(handler, { auth: "extension" })(fromExtension("/x", { authorization }), ctx()));
        await expectKeyRefused(
          await route(handler, { auth: "extension" })(fromExtension("/x", { method: "POST", authorization, body: "{}" }), ctx()),
        );
      }
      expect(handler).not.toHaveBeenCalled();
      expect(await keyCount()).toBe(1);
    });

    it("needs no Origin: none, another site's or the app's are all accepted", async () => {
      const { authorization } = await withKey();
      const post = route(async ({ req }) => readJson(req, z.object({ a: z.number() })), { auth: "extension" });
      for (const origin of [null, "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "https://evil.example", APP_ORIGIN]) {
        const res = await post(
          request("/x", { method: "POST", origin, body: '{"a":1}', headers: { authorization } }),
          ctx(),
        );
        expect(res.status, String(origin)).toBe(200);
        expect(await res.json()).toEqual({ a: 1 });
      }
    });

    it("needs a JSON body type for anything but GET and HEAD, before the key is looked at", async () => {
      const { authorization } = await withKey();
      const handler = vi.fn(() => ({ ok: true }));
      const post = route(handler, { auth: "extension" });
      for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", null]) {
        for (const method of ["POST", "DELETE"]) {
          const res = await post(request("/x", { method, origin: null, contentType, body: method === "POST" ? "{}" : undefined, headers: { authorization } }), ctx());
          expect(res.status).toBe(403);
          expect(res.headers.get("cache-control")).toBe("no-store");
          expect(await res.json()).toEqual({ error: "Forbidden" });
        }
      }
      // Without a key: still the 403 first.
      expect((await post(request("/x", { method: "POST", origin: null, contentType: "text/plain" }), ctx())).status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
      expect((await post(request("/x", { method: "POST", origin: null, headers: { authorization } }), ctx())).status).toBe(200);
    });

    it("never reads, extends or clears the session cookie", async () => {
      const { cookie, authorization } = await withKey();
      await dueForExtension();
      const before = await sessionTimes();

      // A valid session alone is not enough.
      await expectKeyRefused(await getExtensionSession(fromExtension("/api/extension/session", { cookie }), ctx()));
      // A junk cookie is not cleared.
      await expectKeyRefused(await getExtensionSession(fromExtension("/api/extension/session", { cookie: `${SESSION}=junk` }), ctx()));
      // With the key, the session due for extension is left alone and no cookie is sent.
      const res = await getExtensionSession(fromExtension("/api/extension/session", { cookie, authorization }), ctx());
      expect(res.status).toBe(200);
      expect(setCookies(res)).toEqual([]);
      expect(await sessionTimes()).toEqual(before);
    });

    it("cookie routes ignore the Authorization header", async () => {
      const { cookie, user, authorization } = await withKey();
      await expectNotSignedIn(await getMe(request("/api/me", { headers: { authorization } }), ctx()), { cleared: false });
      const res = await getMe(request("/api/me", { cookie, headers: { authorization: "Bearer jtx_not-a-real-key" } }), ctx());
      expect(res.status).toBe(200);

      const handler = vi.fn(({ extensionKeyId }: { extensionKeyId: string | null }) => ({ extensionKeyId }));
      const plain = await route(handler)(request("/x", { cookie, headers: { authorization } }), ctx());
      expect(await plain.json()).toEqual({ extensionKeyId: null });
      expect(handler.mock.calls[0][0]).toMatchObject({ user: { id: user.id } });
    });

    it("maps errors as every route does; a 401 from the handler asks for Bearer and sets no cookie", async () => {
      const { authorization, cookie } = await withKey();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const keyRoute = (fn: () => unknown) => route(fn, { auth: "extension" });
      const cases: Array<[() => unknown, number]> = [
        [() => z.object({ a: z.string() }).parse({}), 400],
        [() => { throw new NotFoundError("Job x not found"); }, 404],
        [() => { throw new ConflictError("Taken"); }, 409],
        [() => { throw new Error("secret detail"); }, 500],
      ];
      for (const [fn, status] of cases) {
        const res = await keyRoute(fn)(fromExtension("/x", { authorization }), ctx());
        expect(res.status).toBe(status);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
      await expectKeyRefused(
        await keyRoute(() => {
          throw new UnauthorizedError(true);
        })(fromExtension("/x", { authorization, cookie }), ctx()),
      );
    });
  });
});

describe("redirectTo", () => {
  afterEach(restoreEnv);

  it("builds an absolute Location from APP_URL, with no-store and the given cookies", () => {
    signedInEnv();
    const res = redirectTo("/review?x=1", ["a=b"]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://jobs.example.com/review?x=1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(setCookies(res)).toEqual(["a=b"]);
  });

  it.each([
    ["/\t/evil.example/x"],
    ["/\n/evil.example/x"],
    ["/\r\n/evil.example/x"],
    ["/x\u0000"],
    ["/x\u007f"],
    ["/x\u0085"],
    ["//evil.example/x"],
    ["/\\evil.example/x"],
    ["https://evil.example/x"],
    ["review"],
  ])("refuses %j, with or without APP_URL", (path) => {
    signedInEnv();
    expect(() => redirectTo(path)).toThrow("redirectTo: path must be a path on this site");
    setEnv({});
    expect(() => redirectTo(path)).toThrow("redirectTo: path must be a path on this site");
  });

  it("uses a relative Location when APP_URL is missing", () => {
    setEnv({});
    expect(redirectTo("/login?error=failed").headers.get("location")).toBe("/login?error=failed");
  });
});
