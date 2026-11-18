import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as checkInbox } from "@/app/api/inbox/check/route";
import { GET as getSettings } from "@/app/api/settings/route";
import { GET as getStats } from "@/app/api/stats/route";
import { getDb, withTx } from "@/lib/server/db/client";
import { saveConnection } from "@/lib/server/inbox/connection";
import { DEMO_ON_GMAIL_MESSAGE, ensureDemoConnection } from "@/lib/server/inbox/repo";
import { isSyncing } from "@/lib/server/inbox/sync/engine";
import { inboxError } from "@/lib/server/inbox/sync/errors";
import type { InboxCheckResult, InboxDryRunResult, Settings, Stats } from "@/lib/types";
import { seedUser } from "../../db/seed/seed";
import { makeJob } from "../helpers/factories";
import { describeDb, testSql } from "../helpers/test-db";
import { restoreEnv, signedInEnv } from "../unit/auth/env";
import { fakeGoogle, GMAIL_SCOPE, inboxEnv, REFRESH_TOKEN } from "../unit/inbox/connect-fakes";
import { ctx, OWNER, request, signedIn } from "./helpers";

// POST /api/inbox/check on the real database: the demo mode (MAIL_SOURCE=fixture) runs the sync
// over fixtures/mail; the answers 401, 409 and 502; the lease; the development-only dry run. The
// sync itself is tested in tests/db/inbox (with Gmail: gmail-sync.test.ts).

// connection() needs a request scope; called directly, handlers only need it to resolve.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

// A switch to make the mail source fail as a whole (a setup problem, Google down), and a gate
// that holds every message fetch while it is set (a slow mailbox).
const failure = vi.hoisted(() => ({ error: null as unknown, gate: null as Promise<void> | null }));
vi.mock("@/lib/server/inbox/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/inbox/source")>();
  return {
    ...actual,
    createMailSource: (...args: Parameters<typeof actual.createMailSource>) => {
      if (failure.error) throw failure.error;
      const source = actual.createMailSource(...args);
      return {
        ...source,
        getMessage: async (id: string) => {
          await failure.gate;
          return source.getMessage(id);
        },
      };
    },
  };
});

// The route's wait ("up to 20 seconds"), shorter where a test says so.
const wait = vi.hoisted(() => ({ ms: null as number | null }));
vi.mock("@/lib/server/inbox/sync/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/inbox/sync/engine")>();
  return {
    ...actual,
    get CHECK_WAIT_MS() {
      return wait.ms ?? actual.CHECK_WAIT_MS;
    },
  };
});

const check = (cookie: string | null, query = "") =>
  checkInbox(request(`/api/inbox/check${query}`, { method: "POST", cookie }), ctx());

/** Every table's row count in the test schema: "the dry run writes nothing". */
async function tableCounts(): Promise<Record<string, number>> {
  const tables = await testSql()<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`;
  const counts: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [{ count }] = await testSql().unsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM "${table_name}"`);
    counts[table_name] = count;
  }
  return counts;
}

async function ok<T>(res: Response): Promise<T> {
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return body as T;
}

async function fails(res: Response, status: number): Promise<string> {
  const body = (await res.json()) as { error: string };
  expect(res.status, JSON.stringify(body)).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return body.error;
}

describeDb("POST /api/inbox/check", () => {
  let cookie: string;
  let userId: string;

  beforeEach(async () => {
    signedInEnv();
    vi.stubEnv("INBOX_BACKFILL_DAYS", "30");
    inboxEnv({ mailSource: "fixture" });
    const session = await signedIn();
    cookie = session.cookie;
    userId = session.user.id;
  });
  afterEach(() => {
    failure.error = null;
    failure.gate = null;
    wait.ms = null;
    vi.unstubAllGlobals();
    restoreEnv();
  });

  it("401 signed out", async () => {
    expect(await fails(await check(null), 401)).toBe("Not signed in");
  });

  it("demo mode: connects the user's own account, checks the demo mail, and a second check changes nothing", async () => {
    await withTx((tx) => seedUser(tx, userId));
    const res = await ok<InboxCheckResult>(await check(cookie));

    expect(res).toMatchObject({ state: "done", scanned: 14 });
    expect(Number.isNaN(Date.parse(res.checkedAt))).toBe(false);
    // Job mail only, linked as the pipeline decided (the full table: tests/db/inbox/ingest.test.ts).
    expect(res.processed.map((e) => [e.fromAddress, e.outcome]).sort()).toEqual([
      ["careers@driftwoodaudio.example", "created"],
      ["careers@lumenhealth.example", "matched"],
      ["ines.moreau@kelpie-analytics.example", "review"],
      ["jobs@brightline-energy.example", "matched"],
      ["jonas.huber@fernweh-mobility.example", "matched"],
      ["mara.lindqvist@northwindlabs.example", "matched"],
      ["no-reply@quillmark.teamtailor-mail.example", "review"],
      ["no-reply@us.greenhouse-mail.example", "matched"],
      ["priya.raman@nimbusdocs.example", "matched"],
      ["talent@emberfinance.co.example", "matched"],
      ["talent@orbitpayments.example", "matched"],
    ]);
    // The sweep runs after the sync: Orbit Payments (applied 31 days ago) would be due, but its
    // rejection arrived in this check. The sweep itself: tests/db/inbox/sweep.test.ts.
    expect(res.noResponseMarked).toEqual([]);

    const settings = await ok<Settings>(await getSettings(request("/api/settings", { cookie }), ctx()));
    expect(settings.inbox).toMatchObject({
      address: OWNER.email,
      connected: true,
      state: "connected",
      syncing: false,
      backfill: null,
      lastError: null,
      demo: true,
    });
    expect(settings.inbox.lastCheckedAt).not.toBeNull();

    const stats = await ok<Stats>(await getStats(request("/api/stats", { cookie }), ctx()));
    const again = await ok<InboxCheckResult>(await check(cookie));
    expect(again).toMatchObject({ state: "done", scanned: 0, processed: [], noResponseMarked: [] });
    expect(await ok<Stats>(await getStats(request("/api/stats", { cookie }), ctx()))).toEqual(stats);
  });

  it("runs the no-response sweep after a sync that finished completely, and not while a message waits for a retry", async () => {
    await withTx((tx) => seedUser(tx, userId));
    const stale = await makeJob(userId, { company: "Stillwater Systems", title: "Platform Engineer", status: "applied" });
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    await testSql()`UPDATE jobs SET last_activity_at = ${longAgo} WHERE id = ${stale.id}`;
    // One demo mail cannot be stored for now: the sync ends with it left to retry.
    await testSql().unsafe(`
      CREATE OR REPLACE FUNCTION fail_ember_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.subject = 'Interview invitation: Software Engineer' THEN RAISE EXCEPTION 'test: refused'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_ember_insert BEFORE INSERT ON emails FOR EACH ROW EXECUTE FUNCTION fail_ember_insert();`);
    try {
      const first = await ok<InboxCheckResult>(await check(cookie));
      expect(first).toMatchObject({ state: "done", scanned: 14, noResponseMarked: [] });
      expect(first.processed).toHaveLength(10);
    } finally {
      await testSql().unsafe(`DROP TRIGGER IF EXISTS fail_ember_insert ON emails`);
    }
    const [{ status }] = await testSql()<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${stale.id}`;
    expect(status).toBe("applied");

    // The retry succeeds: the scan is complete, and the sweep marks the stale job.
    const second = await ok<InboxCheckResult>(await check(cookie));
    expect(second).toMatchObject({ state: "done", scanned: 1 });
    expect(second.processed.map((e) => e.subject)).toEqual(["Interview invitation: Software Engineer"]);
    expect(second.noResponseMarked.map((j) => [j.id, j.status])).toEqual([[stale.id, "no_response"]]);
  });

  it("answers running when the sync outlasts the wait; the sync goes on, then sweeps", async () => {
    await withTx((tx) => seedUser(tx, userId));
    const stale = await makeJob(userId, { company: "Stillwater Systems", title: "Platform Engineer", status: "applied" });
    await testSql()`UPDATE jobs SET last_activity_at = ${new Date(Date.now() - 40 * 86_400_000)} WHERE id = ${stale.id}`;
    let open!: () => void;
    failure.gate = new Promise((resolve) => (open = resolve));
    wait.ms = 200;

    const res = await ok<InboxCheckResult>(await check(cookie));
    expect(res).toMatchObject({ state: "running", scanned: 0, processed: [], noResponseMarked: [] });
    expect(isSyncing(userId)).toBe(true);
    // Another check meanwhile joins the same run.
    expect(await ok<InboxCheckResult>(await check(cookie))).toMatchObject({ state: "running" });

    open();
    await vi.waitFor(() => expect(isSyncing(userId)).toBe(false), { timeout: 10_000 });
    // The run finished on its own and the sweep ran after it.
    await vi.waitFor(async () => {
      const [{ status }] = await testSql()<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${stale.id}`;
      expect(status).toBe("no_response");
    });
    const [{ count }] = await testSql()<{ count: number }[]>`
      SELECT count(*)::int AS count FROM emails WHERE user_id = ${userId} AND gmail_message_id IS NOT NULL`;
    expect(count).toBe(11);
  });

  it("demo mode: 409 for a Gmail connection, which keeps its token, position, ledger and jobs", async () => {
    // A server started with MAIL_SOURCE=fixture by mistake, on a database with a real mailbox.
    await withTx((tx) => seedUser(tx, userId));
    await saveConnection(getDb(), userId, {
      googleSub: OWNER.sub,
      emailAddress: OWNER.email,
      refreshToken: REFRESH_TOKEN,
      grantedScopes: [GMAIL_SCOPE],
    });
    await testSql()`
      UPDATE inbox_connections SET history_id = '9000123', backfill_state = 'done', last_sync_ok_at = now() - interval '1 hour'
      WHERE user_id = ${userId}`;
    await testSql()`INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result) VALUES (${userId}, '18c0ffee', 'ignored')`;
    const google = fakeGoogle();
    const tables = ["inbox_connections", "inbox_seen_messages", "jobs", "emails", "job_status_events"];
    const rows = async () => Promise.all(tables.map((t) => testSql().unsafe(`SELECT * FROM "${t}" ORDER BY 1`)));
    const before = await rows();

    expect(await fails(await check(cookie), 409)).toBe(DEMO_ON_GMAIL_MESSAGE);

    expect(await rows()).toEqual(before);
    expect(isSyncing(userId)).toBe(false);
    expect(google.urls).toEqual([]); // no token refreshed, none revoked
    const settings = await ok<Settings>(await getSettings(request("/api/settings", { cookie }), ctx()));
    expect(settings.inbox).toMatchObject({ address: OWNER.email, state: "connected", lastError: null });
  });

  it("409 when no inbox is connected (Gmail mode)", async () => {
    inboxEnv({ mailSource: "" });
    expect(await fails(await check(cookie), 409)).toBe("Connect Gmail in Settings first.");
    const [{ count }] = await testSql()<{ count: number }[]>`SELECT count(*)::int AS count FROM inbox_connections`;
    expect(count).toBe(0);
  });

  it("409 when the inbox needs reconnecting", async () => {
    inboxEnv({ mailSource: "" });
    await testSql()`
      INSERT INTO inbox_connections (user_id, google_sub, email_address, status, last_error_code)
      VALUES (${userId}, ${OWNER.sub}, ${OWNER.email}, 'needs_reconnect', 'token_revoked')`;
    expect(await fails(await check(cookie), 409)).toBe("Gmail needs to be reconnected. Reconnect it in Settings.");
  });

  it("502 with the fixed text when the mail source is not set up, recorded on the connection", async () => {
    failure.error = inboxError("fixtures_missing", { cause: new Error("ENOENT /srv/somewhere") });
    expect(await fails(await check(cookie), 502)).toBe("The demo mail folder (fixtures/mail) is missing on the server.");
    const settings = await ok<Settings>(await getSettings(request("/api/settings", { cookie }), ctx()));
    expect(settings.inbox.lastError).toMatchObject({
      code: "fixtures_missing",
      message: "The demo mail folder (fixtures/mail) is missing on the server.",
    });

    // A temporary failure: 502 as well, with its own fixed text.
    failure.error = inboxError("google_unavailable");
    expect(await fails(await check(cookie), 502)).toBe("Google's servers had a problem. The app will try again.");

    // Fixed: the next check works and clears the error.
    failure.error = null;
    expect(await ok<InboxCheckResult>(await check(cookie))).toMatchObject({ state: "done" });
    expect((await ok<Settings>(await getSettings(request("/api/settings", { cookie }), ctx()))).inbox.lastError).toBeNull();
  });

  it("409 with the fixed text when the sync finds the token revoked", async () => {
    failure.error = inboxError("token_revoked");
    expect(await fails(await check(cookie), 409)).toMatch(/^Google no longer accepts this app's access/);
    const settings = await ok<Settings>(await getSettings(request("/api/settings", { cookie }), ctx()));
    expect(settings.inbox.state).toBe("needs_reconnect");
  });

  it("answers running when another process holds the sync lease, and records nothing", async () => {
    await ensureDemoConnection(getDb(), userId);
    await testSql()`
      UPDATE inbox_connections SET lease_owner = '4242.another-process', lease_until = now() + interval '3 minutes'
      WHERE user_id = ${userId}`;
    expect(await ok<InboxCheckResult>(await check(cookie))).toMatchObject({ state: "running", scanned: 0, processed: [] });
    const [{ count }] = await testSql()<{ count: number }[]>`SELECT count(*)::int AS count FROM inbox_seen_messages`;
    expect(count).toBe(0);
    const settings = await ok<Settings>(await getSettings(request("/api/settings", { cookie }), ctx()));
    expect(settings.inbox).toMatchObject({ syncing: true, lastError: null });
  });

  describe("?dryRun=1", () => {
    it("classifies what the next sync would, as readable JSON, and writes nothing", async () => {
      await withTx((tx) => seedUser(tx, userId));
      await ensureDemoConnection(getDb(), userId);
      const before = await tableCounts();
      const [row] = await testSql()`SELECT * FROM inbox_connections WHERE user_id = ${userId}`;

      const res = await ok<InboxDryRunResult>(await check(cookie, "?dryRun=1"));

      expect(res).toMatchObject({
        dryRun: true,
        mode: "full_scan",
        listed: 14,
        alreadyDone: 0,
        fetchLimit: 200,
        fetched: 14,
        notFetched: 0,
        ignored: 3,
        outcomes: { matched: 8, created: 1, review: 2 },
        reviewReasons: { status_mismatch: 1, unknown_job: 1 },
        failed: {},
      });
      expect(res.sample).toHaveLength(14);
      for (const s of res.sample) expect([...s.subject].length).toBeLessThanOrEqual(80);
      expect(await tableCounts()).toEqual(before);
      expect((await testSql()`SELECT * FROM inbox_connections WHERE user_id = ${userId}`)[0]).toEqual(row);

      // limit: fewer messages fetched, and said so.
      expect(await ok<InboxDryRunResult>(await check(cookie, "?dryRun=1&limit=4"))).toMatchObject({ fetchLimit: 4, fetched: 4, notFetched: 10 });
      expect(await fails(await check(cookie, "?dryRun=1&limit=0"), 400)).toBe("limit must be a whole number from 1 to 200");
      expect(await fails(await check(cookie, "?dryRun=1&limit=500"), 400)).toMatch(/^limit must be/);
    });

    it("404 in production, before anything else", async () => {
      vi.stubEnv("NODE_ENV", "production");
      expect(await fails(await check(cookie, "?dryRun=1"), 404)).toBe("Not found");
      const [{ count }] = await testSql()<{ count: number }[]>`SELECT count(*)::int AS count FROM inbox_connections`;
      expect(count).toBe(0);
    });

    it("409 without a connected inbox (it creates no demo connection), or while a sync runs", async () => {
      expect(await fails(await check(cookie, "?dryRun=1"), 409)).toBe("Connect Gmail in Settings first.");
      const [{ count }] = await testSql()<{ count: number }[]>`SELECT count(*)::int AS count FROM inbox_connections`;
      expect(count).toBe(0);

      await ensureDemoConnection(getDb(), userId);
      await testSql()`UPDATE inbox_connections SET lease_owner = 'other', lease_until = now() + interval '3 minutes'`;
      expect(await fails(await check(cookie, "?dryRun=1"), 409)).toBe("A sync is running. Try the dry run again when it has finished.");
    });

    it("502 with the fixed text when the mail source fails, recorded nowhere", async () => {
      await ensureDemoConnection(getDb(), userId);
      failure.error = inboxError("google_unavailable");
      expect(await fails(await check(cookie, "?dryRun=1"), 502)).toBe("Google's servers had a problem. The app will try again.");
      const [row] = await testSql()`SELECT last_error_code, lease_owner FROM inbox_connections WHERE user_id = ${userId}`;
      expect(row).toEqual({ last_error_code: null, lease_owner: null });

      failure.error = inboxError("token_revoked");
      expect(await fails(await check(cookie, "?dryRun=1"), 409)).toMatch(/^Google no longer accepts this app's access/);
      expect((await testSql()`SELECT status FROM inbox_connections WHERE user_id = ${userId}`)[0].status).toBe("connected");
    });
  });
});
