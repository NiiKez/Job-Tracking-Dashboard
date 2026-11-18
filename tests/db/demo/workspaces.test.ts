import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { DEFAULT_RULES } from "@/lib/domain/defaults";
import { hashSessionToken } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/client";
import { buildSeed } from "@/lib/server/demo/fixtures";
import { DEMO_SUB_PREFIX, WORKSPACE_LIFETIME_SECONDS } from "@/lib/server/demo/marker";
import {
  countWorkspaces,
  createWorkspace,
  deleteWorkspace,
  EVICT_AFTER_SECONDS,
  MAX_WORKSPACES,
  purgeExpiredWorkspaces,
  workspaceExpiresAt,
} from "@/lib/server/demo/workspaces";
import { createUser } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";
import { allUsers, insertBareDemoUsers, restoreDemoEnv, stubDemoMode } from "./support";

// The public demo's workspaces (src/lib/server/demo/workspaces.ts): create, start over, leave,
// the cap with its eviction, the purge, and that no path ever deletes a user that is not a demo
// user. Run in demo mode, as the demo runs them (the per-workspace caps then check the seed too).

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Table = "users" | "settings" | "rules" | "jobs" | "events" | "emails" | "connections" | "sessions";

/** The user's rows in every table a workspace fills. */
async function rowsOf(userId: string): Promise<Record<Table, number>> {
  const [row] = await testSql()<Record<Table, number>[]>`
    SELECT
      (SELECT count(*)::int FROM users WHERE id = ${userId}) AS users,
      (SELECT count(*)::int FROM user_settings WHERE user_id = ${userId}) AS settings,
      (SELECT count(*)::int FROM keyword_rules WHERE user_id = ${userId}) AS rules,
      (SELECT count(*)::int FROM jobs WHERE user_id = ${userId}) AS jobs,
      (SELECT count(*)::int FROM job_status_events WHERE user_id = ${userId}) AS events,
      (SELECT count(*)::int FROM emails WHERE user_id = ${userId}) AS emails,
      (SELECT count(*)::int FROM inbox_connections WHERE user_id = ${userId}) AS connections,
      (SELECT count(*)::int FROM sessions WHERE user_id = ${userId}) AS sessions`;
  return row;
}

const NONE: Record<Table, number> = {
  users: 0,
  settings: 0,
  rules: 0,
  jobs: 0,
  events: 0,
  emails: 0,
  connections: 0,
  sessions: 0,
};

/** createWorkspace that must succeed. */
async function newWorkspace(opts: Parameters<typeof createWorkspace>[1] = {}) {
  const result = await createWorkspace(getDb(), opts);
  if (!result.ok) throw new Error("expected a workspace, the demo was full");
  return result;
}

/** The session token in a Set-Cookie value. */
function tokenOf(setCookie: string): string {
  const match = /^jt_session=([A-Za-z0-9_-]+);/.exec(setCookie);
  if (!match) throw new Error("no session cookie");
  return match[1];
}

/** Users that are not demo users, made the way a Google sign-in makes them, some of them old. */
async function realUsers(): Promise<string[]> {
  const plain = [await createUser({ rules: true }), await createUser()];
  // google_subs that a sloppy match (LIKE 'demo_%', ILIKE, a missing colon) would take for demo users.
  const lookalikes: string[] = [];
  for (const [n, sub] of ["demo_1", "demoX:1", "Demo:1", "DEMO:1", " demo:1", "xdemo:1", "demo"].entries()) {
    const [row] = await testSql()<{ id: string }[]>`
      INSERT INTO users (google_sub, email, name) VALUES (${sub}, ${`lookalike${n}@example.com`}, 'Look Alike')
      RETURNING id`;
    await testSql()`INSERT INTO user_settings (user_id) VALUES (${row.id})`;
    lookalikes.push(row.id);
  }
  const ids = [...plain, ...lookalikes];
  // Older than any lifetime or eviction age.
  await testSql()`UPDATE users SET created_at = now() - interval '30 days' WHERE id = ANY(${ids}::uuid[])`;
  return ids;
}

describeDb("demo workspaces", () => {
  let info: MockInstance<typeof console.info>;

  beforeEach(() => {
    stubDemoMode(true);
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    info.mockRestore();
    restoreDemoEnv();
  });

  /** The log lines so far. */
  const logged = () => info.mock.calls.map((call) => String(call[0]));

  it("exports the plan's limits", () => {
    expect(MAX_WORKSPACES).toBe(300);
    expect(EVICT_AFTER_SECONDS).toBe(3600);
    expect(WORKSPACE_LIFETIME_SECONDS).toBe(86_400);
  });

  /* ---------------------------------------------------------------- create */

  it("creates a whole workspace: a marked user, defaults, the seed, a demo inbox and a 24-hour session", async () => {
    const result = await newWorkspace();
    const seed = buildSeed(Date.now());

    const [user] = await testSql()<{ google_sub: string; email: string; name: string; picture_url: string | null }[]>`
      SELECT google_sub, email, name, picture_url FROM users WHERE id = ${result.userId}`;
    expect(user.google_sub).toMatch(/^demo:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(user.email).toMatch(/^alex\.[0-9a-f]{16}@demo\.invalid$/);
    expect(user).toMatchObject({ name: "Alex Demo", picture_url: null });

    expect(await rowsOf(result.userId)).toEqual({
      users: 1,
      settings: 1,
      rules: DEFAULT_RULES.length,
      jobs: seed.jobs.length,
      events: expect.any(Number),
      emails: seed.emails.length,
      connections: 1,
      sessions: 1,
    });
    expect((await rowsOf(result.userId)).events).toBeGreaterThan(seed.jobs.length);
    const [connection] = await testSql()<{ demo: boolean; status: string; google_sub: string; email_address: string }[]>`
      SELECT demo, status, google_sub, email_address FROM inbox_connections WHERE user_id = ${result.userId}`;
    expect(connection).toEqual({ demo: true, status: "connected", google_sub: user.google_sub, email_address: user.email });

    // The session: the cookie's token, ending exactly 24 hours after the user was created.
    const [session] = await testSql()<{ expires_at: Date; exact: boolean }[]>`
      SELECT s.expires_at, s.expires_at = u.created_at + interval '24 hours' AS exact
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${hashSessionToken(tokenOf(result.setCookie))!}`;
    expect(session.exact).toBe(true);
    expect(result.expiresAt).toEqual(session.expires_at);
    expect(result.setCookie).toContain(`Max-Age=${WORKSPACE_LIFETIME_SECONDS}`);
    expect(await workspaceExpiresAt(getDb(), result.userId)).toEqual(session.expires_at);
    expect(await countWorkspaces(getDb())).toBe(1);
  });

  it("dates the seed from `now` when given", async () => {
    const now = new Date(Date.UTC(2026, 0, 15, 12));
    const { userId } = await newWorkspace({ now });
    const [{ newest }] = await testSql()<{ newest: Date }[]>`
      SELECT max(created_at) AS newest FROM jobs WHERE user_id = ${userId}`;
    expect(newest.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(newest.getTime()).toBeGreaterThan(now.getTime() - 30 * DAY);
  });

  it("logs one line per creation with its duration, and no id or address", async () => {
    const { userId } = await newWorkspace();
    const lines = logged();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^demo: workspace created in \d+ ms \(1 live\)$/);
    const [{ email }] = await testSql()<{ email: string }[]>`SELECT email FROM users WHERE id = ${userId}`;
    for (const line of lines) {
      expect(line).not.toContain(userId);
      expect(line).not.toContain(email);
    }
    // Kept for the report: how long one creation takes here.
    process.stdout.write(`[workspaces.test] ${lines[0]}\n`);
  });

  it("gives every workspace its own user, address and session", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    expect(a.userId).not.toBe(b.userId);
    expect(tokenOf(a.setCookie)).not.toBe(tokenOf(b.setCookie));
    const users = await allUsers();
    expect(users.get(a.userId)).not.toBe(users.get(b.userId));
    expect(await countWorkspaces(getDb())).toBe(2);
  });

  /* ----------------------------------------------------------- start over */

  it("starts over: the old workspace is deleted and a new one made", async () => {
    const old = await newWorkspace();
    const fresh = await newWorkspace({ replaceUserId: old.userId });
    expect(fresh.userId).not.toBe(old.userId);
    expect(await rowsOf(old.userId)).toEqual(NONE);
    expect((await rowsOf(fresh.userId)).jobs).toBeGreaterThan(0);
    expect(await countWorkspaces(getDb())).toBe(1);
  });

  it("starts over in one transaction: when creating fails, the old workspace is still there", async () => {
    const old = await newWorkspace();
    const before = await rowsOf(old.userId);
    const sql = testSql();
    // The last step (the session) fails, after the old workspace was deleted and the new one seeded.
    await sql.unsafe(`
      CREATE FUNCTION test_refuse_session() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test: no new sessions'; END $$`);
    await sql.unsafe(`
      CREATE TRIGGER test_refuse_session BEFORE INSERT ON sessions
      FOR EACH ROW EXECUTE FUNCTION test_refuse_session()`);
    try {
      await expect(createWorkspace(getDb(), { replaceUserId: old.userId })).rejects.toThrow("test: no new sessions");
    } finally {
      await sql.unsafe(`DROP TRIGGER test_refuse_session ON sessions`);
      await sql.unsafe(`DROP FUNCTION test_refuse_session()`);
    }
    expect(await rowsOf(old.userId)).toEqual(before);
    expect([...(await allUsers()).keys()]).toEqual([old.userId]);
  });

  it("starting over with a user that is not a demo user leaves that user alone", async () => {
    const real = await createUser({ rules: true });
    const before = await rowsOf(real);
    const fresh = await newWorkspace({ replaceUserId: real });
    expect(await rowsOf(real)).toEqual(before);
    expect(fresh.userId).not.toBe(real);
  });

  it("starting over with an unknown or malformed id just creates", async () => {
    await newWorkspace({ replaceUserId: "00000000-0000-7000-8000-000000000000" });
    await newWorkspace({ replaceUserId: "not-a-uuid" });
    await newWorkspace({ replaceUserId: null });
    expect(await countWorkspaces(getDb())).toBe(3);
  });

  /* ---------------------------------------------------------------- leave */

  it("leaves: deleteWorkspace removes every row of the workspace, once", async () => {
    const workspace = await newWorkspace();
    const other = await newWorkspace();
    const otherRows = await rowsOf(other.userId);

    expect(await deleteWorkspace(getDb(), workspace.userId)).toBe(true);
    expect(await rowsOf(workspace.userId)).toEqual(NONE);
    expect(await rowsOf(other.userId)).toEqual(otherRows);
    expect(await workspaceExpiresAt(getDb(), workspace.userId)).toBeNull();

    expect(await deleteWorkspace(getDb(), workspace.userId)).toBe(false);
    expect(await deleteWorkspace(getDb(), "not-a-uuid")).toBe(false);
  });

  it("deleteWorkspace refuses a user that is not a demo user", async () => {
    const real = await createUser({ rules: true });
    const before = await rowsOf(real);
    expect(await deleteWorkspace(getDb(), real)).toBe(false);
    expect(await rowsOf(real)).toEqual(before);
    expect(await workspaceExpiresAt(getDb(), real)).toBeNull();
    expect(await workspaceExpiresAt(getDb(), "not-a-uuid")).toBeNull();
  });

  /* ---------------------------------------------------------------- purge */

  it("purges only the demo users past their lifetime, and logs it", async () => {
    const live = await newWorkspace();
    const expired = await newWorkspace();
    await testSql()`UPDATE users SET created_at = created_at - interval '24 hours' WHERE id = ${expired.userId}`;
    const bare = await insertBareDemoUsers(3, 25 * 60);
    const almost = await insertBareDemoUsers(1, 23 * 60);
    info.mockClear();

    expect(await countWorkspaces(getDb())).toBe(2);
    expect(await purgeExpiredWorkspaces(getDb())).toBe(4);
    expect(logged()).toEqual(["demo: purged 4 expired workspaces"]);
    const users = await allUsers();
    expect([...users.keys()].sort()).toEqual([live.userId, ...almost].sort());
    for (const id of [expired.userId, ...bare]) expect(await rowsOf(id)).toEqual(NONE);

    info.mockClear();
    expect(await purgeExpiredWorkspaces(getDb())).toBe(0);
    expect(logged()).toEqual([]);
  });

  it("purges by the clock it is given", async () => {
    const { userId } = await newWorkspace();
    expect(await purgeExpiredWorkspaces(getDb(), new Date(Date.now() + DAY - HOUR))).toBe(0);
    expect(await countWorkspaces(getDb(), new Date(Date.now() + DAY + HOUR))).toBe(0);
    expect(await purgeExpiredWorkspaces(getDb(), new Date(Date.now() + DAY + HOUR))).toBe(1);
    expect(await rowsOf(userId)).toEqual(NONE);
  });

  it("purges the expired ones before creating", async () => {
    await insertBareDemoUsers(2, 25 * 60);
    const { userId } = await newWorkspace();
    expect([...(await allUsers()).keys()]).toEqual([userId]);
  });

  /* ------------------------------------------------------ cap and eviction */

  it("makes the 300th workspace, then is busy while none is an hour old", async () => {
    await insertBareDemoUsers(MAX_WORKSPACES - 1, 30);
    await newWorkspace();
    expect(await countWorkspaces(getDb())).toBe(MAX_WORKSPACES);
    const before = await allUsers();
    info.mockClear();

    expect(await createWorkspace(getDb())).toEqual({ ok: false, reason: "busy" });
    expect(await allUsers()).toEqual(before);
    expect(logged()).toEqual(["demo: full, no workspace created (300 live, none older than an hour)"]);
  });

  it("at the cap, deletes the oldest workspace older than an hour to make room", async () => {
    const [oldest] = await insertBareDemoUsers(1, 180);
    const old = await insertBareDemoUsers(3, 120);
    await insertBareDemoUsers(MAX_WORKSPACES - 4, 10);
    info.mockClear();

    const fresh = await newWorkspace();
    const users = await allUsers();
    expect(users.has(oldest)).toBe(false);
    for (const id of old) expect(users.has(id)).toBe(true);
    expect(users.has(fresh.userId)).toBe(true);
    expect(await countWorkspaces(getDb())).toBe(MAX_WORKSPACES);
    expect(logged()[0]).toBe("demo: deleted 1 workspace older than an hour to make room");
    expect(logged()[1]).toMatch(/^demo: workspace created in \d+ ms \(300 live\)$/);
  });

  it("starting over at the cap reuses the visitor's own place", async () => {
    await insertBareDemoUsers(MAX_WORKSPACES - 1, 5);
    const mine = await newWorkspace();
    const fresh = await newWorkspace({ replaceUserId: mine.userId });
    expect(await rowsOf(mine.userId)).toEqual(NONE);
    expect((await rowsOf(fresh.userId)).users).toBe(1);
    expect(await countWorkspaces(getDb())).toBe(MAX_WORKSPACES);
  });

  it("when eviction cannot make room, changes nothing: no eviction, no start over", async () => {
    // Over the cap (as after a lower cap was deployed): 302 live, one of them old enough to go.
    const [evictable] = await insertBareDemoUsers(1, 120);
    const [mine] = await insertBareDemoUsers(MAX_WORKSPACES + 1, 5);
    const before = await allUsers();

    expect(await createWorkspace(getDb(), { replaceUserId: mine })).toEqual({ ok: false, reason: "busy" });
    expect(await allUsers()).toEqual(before);
    expect(before.has(evictable)).toBe(true);
  });

  it("lets only one of two racing creations take the last place", async () => {
    await insertBareDemoUsers(MAX_WORKSPACES - 1, 5);
    const results = await Promise.all([createWorkspace(getDb()), createWorkspace(getDb())]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "busy" }]);
    expect(await countWorkspaces(getDb())).toBe(MAX_WORKSPACES);
  });

  it("does not count users that are not demo users, nor expired workspaces, against the cap", async () => {
    await realUsers();
    await insertBareDemoUsers(5, 25 * 60);
    await insertBareDemoUsers(MAX_WORKSPACES - 1, 5);
    expect(await countWorkspaces(getDb())).toBe(MAX_WORKSPACES - 1);
    await newWorkspace();
  });

  /* --------------------------------------- never a user that is not a demo user */

  it("never deletes a user that is not a demo user, on any path", async () => {
    const real = await realUsers();
    const before = new Map<string, Record<Table, number>>();
    for (const id of real) before.set(id, await rowsOf(id));

    // Leave and start over, with each of their ids: one new workspace each, nobody replaced.
    for (const id of real) {
      expect(await deleteWorkspace(getDb(), id)).toBe(false);
      await newWorkspace({ replaceUserId: id });
    }
    // The purge, with a clock that makes every user expired: only those workspaces go.
    const far = new Date(Date.now() + 365 * DAY);
    expect(await purgeExpiredWorkspaces(getDb(), far)).toBe(real.length);
    // Eviction at the cap. The real users are 30 days old, older than any demo user; only the
    // oldest demo user may go.
    const [oldestDemo] = await insertBareDemoUsers(1, 180);
    await insertBareDemoUsers(MAX_WORKSPACES - 1, 120);
    await newWorkspace();
    expect((await allUsers()).has(oldestDemo)).toBe(false);
    // 300 live and none old enough: busy, and nobody else was taken instead.
    await testSql()`
      UPDATE users SET created_at = now() WHERE starts_with(google_sub, ${DEMO_SUB_PREFIX})`;
    expect(await createWorkspace(getDb())).toEqual({ ok: false, reason: "busy" });

    for (const id of real) expect(await rowsOf(id)).toEqual(before.get(id));
  });
});
