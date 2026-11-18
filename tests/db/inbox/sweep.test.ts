import { expect, it } from "vitest";
import { getDb } from "@/lib/server/db/client";
import { ensureDemoConnection } from "@/lib/server/inbox/repo";
import { sweepableUserIds, sweepNoResponse } from "@/lib/server/inbox/sweep";
import { listAllJobs } from "@/lib/server/services/jobs";
import { updateSettings } from "@/lib/server/services/settings";
import type { Status } from "@/lib/types";
import { createUser, makeJob } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";
import { DAY, NOW } from "./support";

// The no-response sweep: applied, not locked, no activity for noResponseDays → no_response. And
// its gate: whom the scheduler's periodic sweep may run for.

/** A job with its status and last activity `days` before NOW. */
async function job(userId: string, company: string, status: Status, days: number, locked = false) {
  const made = await makeJob(userId, { company, title: "Engineer", status: status === "saved" ? "saved" : "applied" });
  const at = new Date(NOW.getTime() - days * DAY);
  await testSql()`
    UPDATE jobs SET status = ${status}, status_locked = ${locked}, last_activity_at = ${at}, created_at = ${at}
    WHERE id = ${made.id}`;
  await testSql()`UPDATE job_status_events SET at = ${at} WHERE job_id = ${made.id}`;
  return made.id;
}

describeDb("the no-response sweep", () => {
  it("marks only unlocked applied jobs whose last activity is past the cutoff, by time", async () => {
    const userId = await createUser();
    const other = await createUser();
    const due = await job(userId, "Due Corp", "applied", 31);
    const exactlyDue = await job(userId, "Edge Corp", "applied", 30);
    await job(userId, "Recent Corp", "applied", 29);
    await job(userId, "Locked Corp", "applied", 60, true);
    await job(userId, "Interview Corp", "interview", 60);
    await job(userId, "Saved Corp", "saved", 60);
    await job(userId, "Rejected Corp", "rejected", 60);
    const othersJob = await job(other, "Due Corp", "applied", 60);

    const marked = await sweepNoResponse(userId, { now: NOW });

    expect(marked.map((j) => j.id)).toEqual([due, exactlyDue]);
    for (const j of marked) {
      expect(j).toMatchObject({ status: "no_response", statusSource: "time", lastActivityAt: NOW.toISOString() });
      expect(j.history.at(-1)).toEqual({
        id: expect.any(String),
        from: "applied",
        to: "no_response",
        at: NOW.toISOString(),
        source: "time",
        note: "No reply in 30 days",
      });
    }
    const statuses = Object.fromEntries((await listAllJobs(getDb(), userId)).map((j) => [j.company, j.status]));
    expect(statuses).toEqual({
      "Due Corp": "no_response",
      "Edge Corp": "no_response",
      "Recent Corp": "applied",
      "Locked Corp": "applied",
      "Interview Corp": "interview",
      "Saved Corp": "saved",
      "Rejected Corp": "rejected",
    });
    expect((await listAllJobs(getDb(), other)).find((j) => j.id === othersJob)?.status).toBe("applied");

    // Nothing left to mark.
    expect(await sweepNoResponse(userId, { now: NOW })).toEqual([]);
  });

  it("uses the user's noResponseDays", async () => {
    const userId = await createUser();
    await updateSettings(userId, { noResponseDays: 45 });
    await job(userId, "Forty Corp", "applied", 40);
    const old = await job(userId, "Fifty Corp", "applied", 50);
    const marked = await sweepNoResponse(userId, { now: NOW });
    expect(marked.map((j) => j.id)).toEqual([old]);
    expect(marked[0].history.at(-1)?.note).toBe("No reply in 45 days");
  });
});

describeDb("the sweep gate", () => {
  const MINUTE = 60_000;

  /** A user whose inbox is in the given state at NOW. */
  async function inbox(
    status: "connected" | "needs_reconnect" | "disconnected",
    opts: { lastOkMinutesAgo?: number | null; backfill?: "pending" | "running" | "done"; interval?: number } = {},
  ): Promise<string> {
    const userId = await createUser();
    await ensureDemoConnection(getDb(), userId);
    const lastOk = opts.lastOkMinutesAgo == null ? null : new Date(NOW.getTime() - opts.lastOkMinutesAgo * MINUTE);
    await testSql()`
      UPDATE inbox_connections SET status = ${status}, backfill_state = ${opts.backfill ?? "done"}, last_sync_ok_at = ${lastOk}
      WHERE user_id = ${userId}`;
    if (opts.interval) await testSql()`UPDATE user_settings SET inbox_interval_minutes = ${opts.interval} WHERE user_id = ${userId}`;
    return userId;
  }

  it("lets through disconnected inboxes and connected ones at most two intervals behind, never a user without one", async () => {
    const yes = [
      await inbox("disconnected", { lastOkMinutesAgo: 10_000 }), // chose to stop reading mail
      await inbox("connected", { lastOkMinutesAgo: 5 }),
      await inbox("connected", { lastOkMinutesAgo: 30 }), // exactly two intervals of 15
      await inbox("connected", { lastOkMinutesAgo: 119, interval: 60 }),
    ];
    const no = [
      // Never connected: not before the first scan has read the replies (production after the
      // merge, before Gmail is connected, sweeps nobody).
      await createUser(),
      await inbox("needs_reconnect", { lastOkMinutesAgo: 1 }),
      await inbox("connected", { lastOkMinutesAgo: 31 }),
      await inbox("connected", { lastOkMinutesAgo: 121, interval: 60 }),
      await inbox("connected", { lastOkMinutesAgo: null }), // never synced
      await inbox("connected", { lastOkMinutesAgo: 1, backfill: "running" }), // first scan or re-scan not done
      await inbox("connected", { lastOkMinutesAgo: 1, backfill: "pending" }),
    ];
    const allowed = await sweepableUserIds(getDb(), NOW);
    expect(allowed).toEqual([...yes].sort());
    for (const userId of no) expect(allowed).not.toContain(userId);
  });

  it("uses the default interval when a user has no settings row", async () => {
    const userId = await inbox("connected", { lastOkMinutesAgo: 25 });
    await testSql()`DELETE FROM user_settings WHERE user_id = ${userId}`;
    expect(await sweepableUserIds(getDb(), NOW)).toEqual([userId]);
    expect(await sweepableUserIds(getDb(), new Date(NOW.getTime() + 6 * MINUTE))).toEqual([]);
  });
});
