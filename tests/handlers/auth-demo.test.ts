import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as entryRoute from "@/app/auth/demo/route";
import { GET as getMe } from "@/app/api/me/route";
import { hashSessionToken } from "@/lib/server/auth/session";
import { ENTRY_LIMITS, resetEntryGateForTests } from "@/lib/server/demo/entry-gate";
import { DEMO_SUB_PREFIX, WORKSPACE_LIFETIME_SECONDS } from "@/lib/server/demo/marker";
import { createWorkspace, MAX_WORKSPACES } from "@/lib/server/demo/workspaces";
import type { Me } from "@/lib/types";
import { insertBareDemoUsers } from "../db/demo/support";
import { describeDb, testSql } from "../helpers/test-db";
import { APP_ORIGIN, demoEnv, restoreEnv, setEnv, signedInEnv } from "../unit/auth/env";
import { ctx, demoSignedIn, request, setCookies, signedIn } from "./helpers";

// POST /auth/demo, "Try the demo" (src/app/auth/demo/route.ts; docs/plan/5-public-demo.md,
// "Step 6"): every branch against a real database, in demo mode and outside it. The workspace
// itself (seed, cap, eviction) is tested in tests/db/demo/workspaces.test.ts, the gate's limits in
// tests/unit/demo/entry-gate.test.ts; here, that the route uses them as it should. Invented
// values only.

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

// The real createWorkspace, which single tests replace once (a failure, a slow creation).
vi.mock("@/lib/server/demo/workspaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/demo/workspaces")>();
  return { ...actual, createWorkspace: vi.fn(actual.createWorkspace) };
});

const { POST: enter } = entryRoute;
const SESSION = "__Host-jt_session";
const HOME = `${APP_ORIGIN}/`;
const BUSY = `${APP_ORIGIN}/login/demo?error=busy`;
const FAILED = `${APP_ORIGIN}/login/demo?error=failed`;

/** The entry form's post: a urlencoded body with nothing in it, from the app's own origin. */
function post(opts: { cookie?: string | null; origin?: string | null } = {}) {
  return request("/auth/demo", {
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: "",
    ...opts,
  });
}

/** "name=value" from a Set-Cookie value. */
const pair = (setCookie: string | undefined) => (setCookie ?? "").split("; ")[0];

async function demoUsers(): Promise<string[]> {
  const rows = await testSql()<{ id: string }[]>`
    SELECT id FROM users WHERE starts_with(google_sub, ${DEMO_SUB_PREFIX}) ORDER BY created_at, id`;
  return rows.map((r) => r.id);
}

async function userCount(): Promise<number> {
  const [row] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
  return row.n;
}

/** The user a session cookie value belongs to, or null. */
async function userOfCookie(cookie: string): Promise<string | null> {
  const hash = hashSessionToken(cookie.slice(cookie.indexOf("=") + 1));
  if (!hash) return null;
  const [row] = await testSql()<{ user_id: string }[]>`SELECT user_id FROM sessions WHERE token_hash = ${hash}`;
  return row?.user_id ?? null;
}

/** A successful entry: 303 to /, no-store, exactly the session's Set-Cookie. Returns "name=value". */
function expectEntered(res: Response): string {
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(HOME);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const cookies = setCookies(res);
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toMatch(
    new RegExp(`^${SESSION}=[A-Za-z0-9_-]{43}; Path=/; Max-Age=${WORKSPACE_LIFETIME_SECONDS}; Secure; HttpOnly; SameSite=Lax$`),
  );
  return pair(cookies[0]);
}

function expectRedirect(res: Response, location: string) {
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(location);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(setCookies(res)).toEqual([]);
}

describeDb("POST /auth/demo", () => {
  beforeEach(() => {
    resetEntryGateForTests();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    restoreEnv();
    resetEntryGateForTests();
    // Back to the real createWorkspace (vi.fn's own implementation) for the next test.
    vi.mocked(createWorkspace).mockReset();
    vi.restoreAllMocks();
  });

  describe("outside demo mode", () => {
    it.each([
      ["Google sign-in", () => signedInEnv()],
      ["locked", () => setEnv({})],
      ["a malformed environment", () => signedInEnv({ ALLOWED_EMAILS: "not an address" })],
    ])("with %s, answers 404 with an empty body to every method and creates nothing", async (_, arrange) => {
      signedInEnv();
      const { cookie } = await signedIn();
      arrange();
      const before = await userCount();
      for (const res of [await enter(post()), await enter(post({ cookie })), await enter(post({ origin: null }))]) {
        expect(res.status).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("location")).toBeNull();
        expect(setCookies(res)).toEqual([]);
        expect(await res.text()).toBe("");
      }
      for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
        const res = await entryRoute[method]();
        expect(res.status, method).toBe(404);
        expect(res.headers.get("allow"), method).toBeNull();
        expect(await res.text(), method).toBe("");
      }
      expect(createWorkspace).not.toHaveBeenCalled();
      expect(await userCount()).toBe(before);
    });
  });

  describe("in demo mode", () => {
    beforeEach(() => demoEnv());

    it("answers the other methods 405, Allow: POST", async () => {
      for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
        const res = await entryRoute[method]();
        expect(res.status, method).toBe(405);
        expect(res.headers.get("allow"), method).toBe("POST");
        expect(res.headers.get("cache-control"), method).toBe("no-store");
      }
      expect(Object.keys(entryRoute).sort()).toEqual(["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"]);
    });

    it("creates a workspace and its session: 303 to / with the cookie, which /api/me accepts", async () => {
      const res = await enter(post());
      const cookie = expectEntered(res);
      const [userId] = await demoUsers();
      expect(await userOfCookie(cookie)).toBe(userId);
      expect(createWorkspace).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createWorkspace).mock.calls[0][1]).toEqual({ replaceUserId: null });

      const me = await getMe(request("/api/me", { cookie }), ctx());
      expect(me.status).toBe(200);
      const body = (await me.json()) as Me;
      expect(body).toMatchObject({ name: "Alex Demo", demo: { expiresAt: expect.any(String) } });
      // The workspace's seed is there: the board is not empty.
      const [jobs] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE user_id = ${userId}`;
      expect(jobs.n).toBeGreaterThan(0);
    });

    it("gives each press a workspace of its own", async () => {
      const a = expectEntered(await enter(post()));
      const b = expectEntered(await enter(post()));
      expect(a).not.toBe(b);
      expect(await demoUsers()).toHaveLength(2);
    });

    it.each([
      ["no Origin", null],
      ["another site", "https://evil.example.com"],
      ["the opaque origin", "null"],
      ["APP_URL over http", "http://jobs.example.com"],
      ["APP_URL with a path", `${APP_ORIGIN}/`],
    ])("refuses %s with 403: nothing created, the visitor's workspace stays", async (_, origin) => {
      const visitor = await demoSignedIn();
      const res = await enter(post({ origin, cookie: visitor.cookie }));
      expect(res.status).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(setCookies(res)).toEqual([]);
      expect(await res.json()).toEqual({ error: "Forbidden" });
      expect(createWorkspace).not.toHaveBeenCalled();
      expect(await demoUsers()).toEqual([visitor.user.id]);
    });

    it("starts over: the visitor's workspace is replaced by a new one, other visitors' stay", async () => {
      const first = expectEntered(await enter(post()));
      const other = await demoSignedIn();
      const [firstId] = (await demoUsers()).filter((id) => id !== other.user.id);

      const again = expectEntered(await enter(post({ cookie: first })));
      expect(vi.mocked(createWorkspace).mock.calls[1][1]).toEqual({ replaceUserId: firstId });
      const now = await demoUsers();
      expect(now).toHaveLength(2);
      expect(now).toContain(other.user.id);
      expect(now).not.toContain(firstId);
      // The old cookie names nothing any more; the new one is the new workspace's.
      expect(await userOfCookie(first)).toBeNull();
      const newId = now.find((id) => id !== other.user.id);
      expect(await userOfCookie(again)).toBe(newId);
    });

    it("never replaces a user that is not a demo user, and ignores an unknown or expired session", async () => {
      // A Google account cannot be in a demo's database; if one were, its cookie must not delete it.
      const owner = await signedIn();
      const expired = await demoSignedIn();
      await testSql()`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = ${expired.user.id}`;
      const unknown = `${SESSION}=${"A".repeat(43)}`;

      for (const cookie of [owner.cookie, expired.cookie, unknown, `${SESSION}=not-a-token`]) {
        expectEntered(await enter(post({ cookie })));
        expect(vi.mocked(createWorkspace).mock.lastCall?.[1]).toEqual({ replaceUserId: null });
      }
      const [row] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE id = ${owner.user.id}`;
      expect(row.n).toBe(1);
    });

    it("sends the visitor to the busy page when the demo is full; their workspace stays", async () => {
      const visitor = await demoSignedIn();
      // Full even without the visitor's own (which starting over would delete), and none old
      // enough to make room for.
      await insertBareDemoUsers(MAX_WORKSPACES);
      const before = await userCount();

      expectRedirect(await enter(post({ cookie: visitor.cookie })), BUSY);
      expectRedirect(await enter(post()), BUSY);
      expect(await userCount()).toBe(before);
      expect(await userOfCookie(visitor.cookie)).toBe(visitor.user.id);
    });

    it("lets a visitor start over in a full demo: their own workspace makes the room", async () => {
      const visitor = await demoSignedIn();
      await insertBareDemoUsers(MAX_WORKSPACES - 1);
      expectRedirect(await enter(post()), BUSY);
      const cookie = expectEntered(await enter(post({ cookie: visitor.cookie })));
      expect(await userOfCookie(visitor.cookie)).toBeNull();
      expect(await userOfCookie(cookie)).not.toBeNull();
      expect(await demoUsers()).toHaveLength(MAX_WORKSPACES);
    });

    it("sends the visitor to the busy page when the gate's queue is full, without creating anything", async () => {
      // The first creation holds the gate; ENTRY_LIMITS.waiting more wait behind it; the next is refused.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      vi.mocked(createWorkspace).mockImplementation(async () => {
        await held;
        return { ok: false, reason: "busy" };
      });
      const waiting = Array.from({ length: ENTRY_LIMITS.waiting + 1 }, () => enter(post()));
      // Let the first one start and the others queue.
      await new Promise((resolve) => setImmediate(resolve));

      expectRedirect(await enter(post()), BUSY);
      expect(createWorkspace).toHaveBeenCalledTimes(1);

      release();
      for (const res of await Promise.all(waiting)) expectRedirect(res, BUSY);
      expect(createWorkspace).toHaveBeenCalledTimes(ENTRY_LIMITS.waiting + 1);
      expect(await demoUsers()).toEqual([]);
    });

    it("sends the visitor to the busy page after the gate's minute is used up", async () => {
      vi.mocked(createWorkspace).mockResolvedValue({ ok: false, reason: "busy" });
      for (let i = 0; i < ENTRY_LIMITS.perMinute; i++) await enter(post());
      expect(createWorkspace).toHaveBeenCalledTimes(ENTRY_LIMITS.perMinute);
      expectRedirect(await enter(post()), BUSY);
      expect(createWorkspace).toHaveBeenCalledTimes(ENTRY_LIMITS.perMinute);
    });

    it("logs a failure and sends the visitor to the entry page with error=failed; their workspace stays", async () => {
      const visitor = await demoSignedIn();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(createWorkspace).mockRejectedValueOnce(Object.assign(new Error("deadlock detected"), { code: "40P01" }));

      expectRedirect(await enter(post({ cookie: visitor.cookie })), FAILED);
      expect(error).toHaveBeenCalledTimes(1);
      expect(await demoUsers()).toEqual([visitor.user.id]);
      // The gate let the failure go: the next press works.
      expectEntered(await enter(post({ cookie: visitor.cookie })));
    });
  });
});
