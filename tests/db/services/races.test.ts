// Races between the user-facing writes, made deterministic.
//
// A side connection holds ACCESS EXCLUSIVE on job_status_events. The first service call stops
// at its first read or write of events, with everything before it uncommitted and its locks
// held. The second call is started, the test waits until PostgreSQL shows it blocked by the
// first, then releases the table and lets both finish.
import { afterEach, expect, it } from "vitest";
import { createSql, getDb, type Sql } from "@/lib/server/db/client";
import { loadJob, updateJob, upsertJob } from "@/lib/server/services/jobs";
import { resolveReview } from "@/lib/server/services/review";
import { countRows, createUser, makeEmail, makeJob } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";

describeDb("races between writes", () => {
  let side: Sql | undefined;

  afterEach(async () => {
    await side?.end({ timeout: 5 });
    side = undefined;
  });

  /** A second client on this block's schema: holds the table lock and watches pg_locks. */
  async function sideClient(): Promise<Sql> {
    const [{ schema }] = await testSql()<{ schema: string }[]>`SELECT current_schema() AS schema`;
    side = createSql(process.env.TEST_DATABASE_URL!, { max: 2, searchPath: schema });
    return side;
  }

  async function until(check: () => Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for: ${what}`);
  }

  /** Holds ACCESS EXCLUSIVE on job_status_events until release() is called. */
  async function holdEventsTable(s: Sql) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const done = s.begin(async (t) => {
      await t`LOCK TABLE job_status_events IN ACCESS EXCLUSIVE MODE`;
      locked();
      await gate;
    });
    await isLocked;
    return { release, done };
  }

  /** Waits for a backend to queue on the job_status_events lock and returns its pid. */
  async function waiterOnEvents(s: Sql, what: string): Promise<number> {
    let pid: number | null = null;
    await until(async () => {
      const [row] = await s<{ pid: number }[]>`
        SELECT pid FROM pg_locks WHERE relation = 'job_status_events'::regclass AND NOT granted`;
      pid = row?.pid ?? null;
      return pid !== null;
    }, what);
    return pid!;
  }

  /** Waits until some backend is blocked by `pid`. */
  async function blockedBy(s: Sql, pid: number, what: string): Promise<void> {
    await until(async () => {
      const [row] = await s<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
      return row.n > 0;
    }, what);
  }

  it("makes an upsert wait for a concurrent link edit and merge into that job, not fail with 23505", async () => {
    const user = await createUser();
    const other = await makeJob(user, { company: "Kestrel", title: "Data Engineer", status: "applied" });
    const link = "https://boards.example.com/kestrel/jobs/99";

    const s = await sideClient();
    const hold = await holdEventsTable(s);
    // updateJob gives `other` the link (uncommitted), then stops in loadJob on the events table.
    const update = updateJob(user, other.id, { url: link });
    const updPid = await waiterOnEvents(s, "updateJob to stop at the events table");
    // upsertJob with the same link: waits for updateJob's per-user lock, so its duplicate lookup
    // runs after the commit. (Without that lock it inserted and failed on the unique index.)
    const upsert = upsertJob(user, {
      title: "Platform Engineer",
      company: "Nimbus",
      location: "",
      url: link,
      description: "",
      status: "saved",
      captureMethod: "paste",
    });
    await blockedBy(s, updPid, "upsertJob to wait on updateJob");
    hold.release();
    await hold.done;

    const [u1, u2] = await Promise.allSettled([update, upsert]);
    expect(u1.status).toBe("fulfilled");
    expect(u2).toMatchObject({ status: "fulfilled", value: { duplicate: true, job: { id: other.id, url: link } } });
    expect(await countRows("jobs")).toBe(1);
  });

  it("confirm without a suggested status keeps a status changed meanwhile", async () => {
    const user = await createUser();
    const job = await makeJob(user, { company: "Kestrel", title: "Data Engineer", status: "applied" });
    const emailId = await makeEmail(user, { suggestedJobIds: [job.id], suggestedStatus: null, reviewReason: "no_keyword" });

    const s = await sideClient();
    const hold = await holdEventsTable(s);
    // The user moves the job to interview in one tab: updateJob holds the row lock and stops at insertEvent.
    const update = updateJob(user, job.id, { status: "interview" });
    const updPid = await waiterOnEvents(s, "updateJob to stop at the events table");
    // And confirms the review email in another: "the job's own status" must be read under the
    // row lock, after the change commits, not before.
    const confirm = resolveReview(user, emailId, { action: "confirm" });
    await blockedBy(s, updPid, "resolveReview to wait on updateJob");
    hold.release();
    await hold.done;

    const [r1, r2] = await Promise.allSettled([update, confirm]);
    expect(r1.status).toBe("fulfilled");
    expect(r2).toMatchObject({
      status: "fulfilled",
      value: { email: { detectedStatus: "interview", statusChange: { from: "interview", to: "interview" } } },
    });
    const after = await loadJob(getDb(), user, job.id);
    expect(after).toMatchObject({ status: "interview", statusSource: "manual", statusLocked: true, emailCount: 1 });
    expect(after.history.map((e) => [e.from, e.to])).toEqual([
      [null, "applied"],
      ["applied", "interview"],
    ]);
  });
});
