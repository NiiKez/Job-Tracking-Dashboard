import { afterEach, beforeEach, expect, it } from "vitest";
import { getDb, withTx } from "@/lib/server/db/client";
import {
  claimMessage,
  deleteSeenBefore,
  ensureDemoConnection,
  finishedMessageIds,
  finishMessage,
  markSkipped,
  recordFailedAttempt,
} from "@/lib/server/inbox/repo";
import type { MailSource } from "@/lib/server/inbox/source/types";
import { inboxError } from "@/lib/server/inbox/sync/errors";
import { listEmails } from "@/lib/server/services/emails";
import { listAllJobs } from "@/lib/server/services/jobs";
import { createUser, makeJob } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";
import { connectionRow, DAY, gmailMessage, ledger, messageSource, NOW, restoreInboxEnv, stubInboxEnv, sync } from "./support";

// The ledger (inbox_seen_messages): claims, failed attempts, and the 90-day clean-up.

const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);

/** A user with a demo connection and an applied job at Acme Robotics from a month before NOW. */
async function acmeUser(): Promise<{ userId: string; jobId: string }> {
  const userId = await createUser({ rules: true });
  await ensureDemoConnection(getDb(), userId);
  const job = await makeJob(userId, { company: "Acme Robotics", title: "Platform Engineer", status: "applied" });
  await testSql()`
    UPDATE jobs SET created_at = ${at(30)}, applied_at = ${at(30)}, last_activity_at = ${at(30)} WHERE id = ${job.id}`;
  await testSql()`UPDATE job_status_events SET at = ${at(30)} WHERE job_id = ${job.id}`;
  return { userId, jobId: job.id };
}

const invite = (subject: string, daysAgo = 1) =>
  gmailMessage({
    from: "Jane Hart <jane@acmerobotics.example>",
    subject,
    body: "We would like to invite you to an interview.",
    at: at(daysAgo),
  });

/**
 * Makes linking fail for emails whose subject contains "[fail]", in this test schema only: the
 * email row is inserted first and linked afterwards, so a rollback must remove it again.
 */
async function failMarkedMail(): Promise<void> {
  await testSql().unsafe(`
    CREATE OR REPLACE FUNCTION fail_marked_mail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.job_id IS NOT NULL AND NEW.subject LIKE '%[fail]%' THEN
        RAISE EXCEPTION 'test: refused';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER fail_marked_mail BEFORE UPDATE ON emails
      FOR EACH ROW EXECUTE FUNCTION fail_marked_mail();`);
}

/** Makes storing fail for emails whose subject contains "[fail]", linked or not (insert time). */
async function failMarkedInserts(): Promise<void> {
  await testSql().unsafe(`
    CREATE OR REPLACE FUNCTION fail_marked_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.subject LIKE '%[fail]%' THEN
        RAISE EXCEPTION 'test: refused';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER fail_marked_insert BEFORE INSERT ON emails
      FOR EACH ROW EXECUTE FUNCTION fail_marked_insert();`);
}

async function allowMarkedMail(): Promise<void> {
  await testSql().unsafe(`DROP TRIGGER IF EXISTS fail_marked_mail ON emails; DROP TRIGGER IF EXISTS fail_marked_insert ON emails`);
}

describeDb("the inbox ledger", () => {
  beforeEach(stubInboxEnv);
  afterEach(async () => {
    restoreInboxEnv();
    await allowMarkedMail();
  });

  it("claims a new or retry row, never a finished one, and a rollback leaves the ledger as it was", async () => {
    const userId = await createUser();
    const sql = testSql();
    expect(await withTx((tx) => claimMessage(tx, userId, "m-new", at(1)))).toBe(true);
    // Claimed but not finished (the transaction committed without finishMessage): still "retry".
    expect((await ledger(userId)).get("m-new")).toMatchObject({ result: "retry", attempts: 0 });

    await withTx(async (tx) => {
      expect(await claimMessage(tx, userId, "m-new", null)).toBe(true);
      await finishMessage(tx, userId, "m-new", "stored");
    });
    expect(await withTx((tx) => claimMessage(tx, userId, "m-new", null))).toBe(false);

    await expect(
      withTx(async (tx) => {
        expect(await claimMessage(tx, userId, "m-rolled-back", at(2))).toBe(true);
        throw new Error("test: roll back");
      }),
    ).rejects.toThrow("test: roll back");
    expect((await ledger(userId)).has("m-rolled-back")).toBe(false);

    await markSkipped(sql, userId, "m-skipped", at(3));
    expect(await withTx((tx) => claimMessage(tx, userId, "m-skipped", null))).toBe(false);
    expect(await finishedMessageIds(sql, userId, ["m-new", "m-skipped", "m-unknown"])).toEqual(
      new Set(["m-new", "m-skipped"]),
    );
  });

  it("counts failed attempts: retry, retry, failed, and leaves finished rows alone", async () => {
    const userId = await createUser();
    const sql = testSql();
    expect(await recordFailedAttempt(sql, userId, "m-1", at(1))).toEqual({ result: "retry", attempts: 1 });
    expect(await recordFailedAttempt(sql, userId, "m-1", null)).toEqual({ result: "retry", attempts: 2 });
    expect(await recordFailedAttempt(sql, userId, "m-1", null)).toEqual({ result: "failed", attempts: 3 });
    expect(await recordFailedAttempt(sql, userId, "m-1", null)).toBeNull();
    expect((await ledger(userId)).get("m-1")).toMatchObject({ result: "failed", attempts: 3, internal_date: at(1) });

    await markSkipped(sql, userId, "m-2", null);
    expect(await recordFailedAttempt(sql, userId, "m-2", null)).toBeNull();
    expect((await ledger(userId)).get("m-2")).toMatchObject({ result: "skipped", attempts: 0 });
  });

  it("a message that fails rolls back; after three runs it is given up and the position moves on", async () => {
    const { userId, jobId } = await acmeUser();
    const first = invite("Interview invitation", 3);
    const failing = invite("Interview time [fail]", 1);
    // The first scan sees only the first message; the second arrives afterwards.
    expect(await sync(userId, messageSource([first]))).toMatchObject({ mode: "full_scan", stored: [expect.anything()] });
    expect((await connectionRow(userId)).history_id).toBe("100001");
    await failMarkedMail();
    const mailbox = messageSource([first, failing]);

    for (const attempt of [1, 2]) {
      const run = await sync(userId, mailbox);
      expect(run, `run ${attempt}`).toMatchObject({ mode: "incremental", scanned: 1, retry: 1, failed: 0, complete: false });
      expect((await ledger(userId)).get(failing.id)).toMatchObject({ result: "retry", attempts: attempt });
      // Rolled back: no email, no history, the position stays.
      expect((await listEmails(getDb(), userId)).map((e) => e.subject)).toEqual(["Interview invitation"]);
      expect((await connectionRow(userId)).history_id).toBe("100001");
    }

    const third = await sync(userId, mailbox);
    expect(third).toMatchObject({ scanned: 1, retry: 0, failed: 1, complete: true });
    expect((await ledger(userId)).get(failing.id)).toMatchObject({ result: "failed", attempts: 3 });
    expect((await connectionRow(userId)).history_id).toBe("100002");
    const [job] = await listAllJobs(getDb(), userId);
    expect(job).toMatchObject({ id: jobId, status: "interview", emailCount: 1 });
    expect(job.history).toHaveLength(2);

    // Given up for good: even with the failure gone, the next run does not look at it again.
    await allowMarkedMail();
    expect(await sync(userId, mailbox)).toMatchObject({ scanned: 0, complete: true });
    expect(await listEmails(getDb(), userId)).toHaveLength(1);
  });

  it("a first scan with a message to retry stays open, and the next run retries only that message", async () => {
    const { userId } = await acmeUser();
    const ok = invite("Interview invitation", 3);
    const failing = invite("Second round [fail]", 1);
    const mailbox = messageSource([ok, failing]);
    await failMarkedMail();

    expect(await sync(userId, mailbox)).toMatchObject({ mode: "full_scan", scanned: 2, retry: 1, complete: false });
    expect(await connectionRow(userId)).toMatchObject({ backfill_state: "running", backfill_total: 2, backfill_done: 2, history_id: "100002" });

    await allowMarkedMail();
    const resumed = await sync(userId, mailbox);
    expect(resumed).toMatchObject({ mode: "full_scan", scanned: 1, retry: 0, complete: true });
    expect(resumed.stored.map((e) => e.subject)).toEqual(["Second round [fail]"]);
    expect(await connectionRow(userId)).toMatchObject({ backfill_state: "done", backfill_total: 2, backfill_done: 2 });
    expect((await ledger(userId)).get(failing.id)).toMatchObject({ result: "stored", attempts: 1 });
    expect(await listEmails(getDb(), userId)).toHaveLength(2);
  });

  it("a fetch that fails for that message counts as an attempt; an outage ends the run without blaming it", async () => {
    const { userId } = await acmeUser();
    const tooLarge = invite("Huge", 2);
    const fine = invite("Interview invitation", 1);
    const base = messageSource([tooLarge, fine]);
    let outage = false;
    const mailbox: MailSource = {
      ...base,
      // An outage fails everything, so the engine's probe (getProfile) fails too.
      getProfile: async () => {
        if (outage) throw inboxError("google_unavailable");
        return base.getProfile();
      },
      getMessage: async (id) => {
        if (outage) throw inboxError("google_unavailable");
        if (id === tooLarge.id) throw inboxError("response_too_large");
        return base.getMessage(id);
      },
    };

    // The rest of the run goes on.
    expect(await sync(userId, mailbox)).toMatchObject({ scanned: 2, retry: 1, stored: [expect.anything()], complete: false });
    expect((await ledger(userId)).get(tooLarge.id)).toMatchObject({ result: "retry", attempts: 1 });

    outage = true;
    await expect(sync(userId, mailbox)).rejects.toMatchObject({ kind: "temporary", code: "google_unavailable" });
    expect((await ledger(userId)).get(tooLarge.id)).toMatchObject({ result: "retry", attempts: 1 });
    expect(await connectionRow(userId)).toMatchObject({ last_error_code: "google_unavailable", consecutive_failures: 1, backfill_state: "running" });
  });

  it("an unreadable answer or an unknown error is the message's only when Google still answers; otherwise nothing is blamed", async () => {
    const { userId } = await acmeUser();
    await sync(userId, messageSource([])); // the position is set: the runs below are incremental
    const odd = invite("Odd", 3);
    const broken = invite("Broken", 2);
    const fine = invite("Interview invitation", 1);
    const base = messageSource([odd, broken, fine]);
    // E.g. the database failing while the access token is refreshed inside the request (getRefreshToken).
    const dbError = Object.assign(new Error("terminating connection"), { code: "57P01" });
    let down = true;
    const mailbox: MailSource = {
      ...base,
      // The probe: fails while `down`, as everything that needs the token or Google would.
      getProfile: async () => {
        if (down) throw dbError;
        return base.getProfile();
      },
      getMessage: async (id) => {
        if (id === odd.id) throw inboxError("bad_response");
        if (id === broken.id) throw down ? dbError : new TypeError("a parser bug");
        return base.getMessage(id);
      },
    };

    await expect(sync(userId, mailbox)).rejects.toMatchObject({ code: "bad_response" });
    let seen = await ledger(userId);
    expect(seen.has(odd.id) || seen.has(broken.id)).toBe(false);
    expect(seen.get(fine.id)).toMatchObject({ result: "stored" });

    // Google answers the probe: then the failures are the messages' own.
    down = false;
    expect(await sync(userId, mailbox)).toMatchObject({ scanned: 2, retry: 2, complete: false });
    seen = await ledger(userId);
    expect(seen.get(odd.id)).toMatchObject({ result: "retry", attempts: 1 });
    expect(seen.get(broken.id)).toMatchObject({ result: "retry", attempts: 1 });
  });

  it("deletes rows older than 90 days after a run, by received time or else by when they were seen; never a retry row", async () => {
    const userId = await createUser();
    const other = await createUser();
    await ensureDemoConnection(getDb(), userId);
    const sql = testSql();
    const rows: Array<[string, Date | null, Date, string]> = [
      ["old", at(91), at(91), "ignored"],
      ["old-failed", at(91), at(91), "failed"],
      ["old-retry", at(120), at(1), "retry"],
      // No run has looked at it for 90 days (the mailbox was disconnected, or the position
      // moved past it): nothing will retry it, so it goes like any other row.
      ["old-retry-abandoned", at(120), at(91), "retry"],
      ["recent", at(89), at(89), "ignored"],
      ["old-unread", null, at(91), "skipped"],
      ["recent-unread", null, at(10), "skipped"],
      ["old-received-seen-lately", at(120), at(1), "stored"],
    ];
    for (const [id, internalDate, seenAt, result] of rows) {
      for (const user of [userId, other]) {
        await sql`
          INSERT INTO inbox_seen_messages (user_id, gmail_message_id, result, internal_date, seen_at)
          VALUES (${user}, ${id}, ${result}, ${internalDate}, ${seenAt})`;
      }
    }

    await sync(userId, messageSource([]));

    expect([...(await ledger(userId)).keys()].sort()).toEqual(["old-retry", "recent", "recent-unread"]);
    expect((await ledger(other)).size).toBe(rows.length);
    expect(await deleteSeenBefore(sql, other, at(90))).toBe(5);
    expect([...(await ledger(other)).keys()].sort()).toEqual(["old-retry", "recent", "recent-unread"]);
  });

  it("a message received long ago (imported into Gmail) that keeps failing keeps its attempts: given up after three runs", async () => {
    const { userId } = await acmeUser();
    await sync(userId, messageSource([])); // the position is set
    const start = (await connectionRow(userId)).history_id;
    await failMarkedInserts();
    // Imported now with its original date: older than the 90 days the ledger keeps.
    const imported = invite("Interview invitation [fail]", 100);
    const fresh = gmailMessage({ from: "Sam <sam@friends.example>", subject: "Saturday", body: "Bike ride at nine?", at: at(0.5) });
    const mailbox = messageSource([imported, fresh]);

    for (const attempt of [1, 2]) {
      const run = await sync(userId, mailbox);
      expect(run, `run ${attempt}`).toMatchObject({ retry: 1, failed: 0, complete: false });
      // Not cleaned up after the run: the attempts add up.
      expect((await ledger(userId)).get(imported.id)).toMatchObject({ result: "retry", attempts: attempt, internal_date: at(100) });
      expect((await connectionRow(userId)).history_id).toBe(start);
    }
    expect(await sync(userId, mailbox)).toMatchObject({ retry: 0, failed: 1, complete: true });
    expect((await connectionRow(userId)).history_id).not.toBe(start);
    // Given up; the clean-up after that run removed its row (older than 90 days), and the
    // position has moved past it.
    expect((await ledger(userId)).has(imported.id)).toBe(false);
    expect(await sync(userId, mailbox)).toMatchObject({ scanned: 0, complete: true });
  });
});
