import { expect, it } from "vitest";
import { manualStatusChange } from "@/lib/domain/status-change";
import { getDb } from "@/lib/server/db/client";
import { parseGmailMessage } from "@/lib/server/inbox/parse/gmail-message";
import { ingestParsed } from "@/lib/server/inbox/sync/ingest";
import { jobPatchSchema } from "@/lib/server/schemas";
import { listEmails } from "@/lib/server/services/emails";
import { loadJob, updateJob } from "@/lib/server/services/jobs";
import type { Job, JobInput, Status } from "@/lib/types";
import { createUser, makeJob } from "../../helpers/factories";
import { describeDb } from "../../helpers/test-db";
import { gmailMessage } from "../inbox/support";

// The status menu's and the board's "Moved to … / Undo" toast (useChangeStatus), on the
// database: each patch goes through the route's schema and updateJob, as PATCH /api/jobs/[id]
// sends it. Undo has to put back the lock as well as the status: a manual change locks the job
// against email, and an accidental drag plus Undo must not leave later mail unable to move it.

/** The change from the client, then its Undo; the job after each. */
async function changeThenUndo(userId: string, job: Job, to: Status) {
  const change = manualStatusChange(job, to);
  if (!change) throw new Error(`${job.status} -> ${to} is not a change`);
  const changed = await updateJob(userId, job.id, jobPatchSchema.parse(change.patch));
  const undone = await updateJob(userId, job.id, jobPatchSchema.parse(change.undo));
  return { changed, undone };
}

/** An email from Acme Robotics through the Gmail ingest, received after everything before it. */
async function ingestMail(userId: string, subject: string, body: string) {
  // A second ahead, so its event sorts after the manual ones whatever the clocks' rounding.
  const at = new Date(Date.now() + 1000);
  const message = gmailMessage({ from: "Jane Hart <jane@acmerobotics.example>", subject, body, at });
  const outcome = await ingestParsed(userId, message.id, await parseGmailMessage(message), {
    ownAddress: "owner@example.com",
    now: at,
  });
  expect(outcome.kind).toBe("stored");
  const [email] = await listEmails(getDb(), userId);
  return email;
}

function acmeJob(userId: string, status: JobInput["status"]): Promise<Job> {
  return makeJob(userId, { company: "Acme Robotics", title: "Platform Engineer", status });
}

describeDb("undoing a manual status change", () => {
  it("puts back an unlocked job's status and lock, so email moves it again", async () => {
    const user = await createUser({ rules: true });
    const job = await acmeJob(user, "applied");
    expect(job.statusLocked).toBe(false);

    const { changed, undone } = await changeThenUndo(user, job, "interview");
    expect(changed).toMatchObject({ status: "interview", statusSource: "manual", statusLocked: true });
    expect(undone).toMatchObject({ status: "applied", statusSource: "manual", statusLocked: false });
    // job_status_events: the change and the Undo are each a manual event; nothing is deleted.
    expect(undone.history.map((e) => [e.from, e.to, e.source])).toEqual([
      [null, "applied", "paste"],
      ["applied", "interview", "manual"],
      ["interview", "applied", "manual"],
    ]);

    const email = await ingestMail(user, "Interview for Platform Engineer", "We would like to invite you to an interview.");
    expect(email).toMatchObject({ outcome: "matched", jobId: job.id, statusChange: { from: "applied", to: "interview" } });
    const after = await loadJob(getDb(), user, job.id);
    expect(after).toMatchObject({ status: "interview", statusSource: "email", statusLocked: false, emailCount: 1 });
    expect(after.history.at(-1)).toMatchObject({ from: "applied", to: "interview", source: "email", emailId: email.id });
  });

  it("leaves a job saved and unlocked after saved -> applied and Undo", async () => {
    const user = await createUser({ rules: true });
    const job = await acmeJob(user, "saved");

    const { changed, undone } = await changeThenUndo(user, job, "applied");
    expect(changed).toMatchObject({ status: "applied", statusLocked: false });
    expect(undone).toMatchObject({ status: "saved", statusSource: "manual", statusLocked: false });
    expect(undone.history.map((e) => [e.from, e.to])).toEqual([
      [null, "saved"],
      ["saved", "applied"],
      ["applied", "saved"],
    ]);
  });

  it("keeps a job locked that was locked before the change", async () => {
    const user = await createUser({ rules: true });
    const job = await updateJob(user, (await acmeJob(user, "applied")).id, { status: "interview" });
    expect(job.statusLocked).toBe(true);

    const { changed, undone } = await changeThenUndo(user, job, "rejected");
    expect(changed).toMatchObject({ status: "rejected", statusLocked: true });
    expect(undone).toMatchObject({ status: "interview", statusLocked: true });

    // Still the manual choice: a rejection is linked and the status stays.
    const email = await ingestMail(user, "Your application for Platform Engineer", "Unfortunately we have decided not to move forward.");
    expect(email).toMatchObject({ outcome: "matched", jobId: job.id, statusChange: { from: "interview", to: "interview" } });
    expect(await loadJob(getDb(), user, job.id)).toMatchObject({ status: "interview", statusLocked: true, emailCount: 1 });
  });
});
