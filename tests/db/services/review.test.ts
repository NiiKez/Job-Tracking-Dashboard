import { expect, it } from "vitest";
import { getDb } from "@/lib/server/db/client";
import { ConflictError, NotFoundError } from "@/lib/server/errors";
import { deleteJob, loadJob, updateJob } from "@/lib/server/services/jobs";
import { resolveReview } from "@/lib/server/services/review";
import { countRows, createUser, makeEmail, makeJob } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";

async function outcomeOf(emailId: string) {
  const [row] = await testSql()`SELECT outcome, detected_status, job_id FROM emails WHERE id = ${emailId}`;
  return row;
}

describeDb("review service", () => {
  it("dismisses an email without touching any job", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    const emailId = await makeEmail(user, { suggestedJobIds: [job.id], suggestedStatus: "rejected" });

    const result = await resolveReview(user, emailId, { action: "dismiss" });
    expect(result.job).toBeNull();
    expect(result.email).toMatchObject({ id: emailId, outcome: "dismissed", jobId: null, statusChange: null });
    expect(await loadJob(getDb(), user, job.id)).toMatchObject({ status: "applied", emailCount: 0 });
  });

  it("confirms the first suggested job with the suggested status", async () => {
    const user = await createUser();
    const first = await makeJob(user, { title: "First", status: "applied" });
    const second = await makeJob(user, { title: "Second", status: "applied" });
    const emailId = await makeEmail(user, {
      suggestedJobIds: [first.id, second.id],
      suggestedStatus: "interview",
      reviewReason: "ambiguous_job",
    });

    const { email, job } = await resolveReview(user, emailId, { action: "confirm" });
    expect(email).toMatchObject({
      outcome: "resolved",
      detectedStatus: "interview",
      jobId: first.id,
      statusChange: { from: "applied", to: "interview" },
      reviewReason: "ambiguous_job",
    });
    expect(job).toMatchObject({ id: first.id, status: "interview", statusSource: "review", emailCount: 1 });
    expect(job!.history.at(-1)).toMatchObject({ from: "applied", to: "interview", source: "review", emailId });
  });

  it("confirms the job's own status when nothing was suggested, and skips deleted suggestions", async () => {
    const user = await createUser();
    const gone = await makeJob(user, { title: "Gone", status: "applied" });
    const job = await makeJob(user, { title: "Here", status: "applied" });
    const emailId = await makeEmail(user, { suggestedJobIds: [gone.id, job.id], suggestedStatus: null, reviewReason: "no_keyword" });
    await deleteJob(user, gone.id);

    const result = await resolveReview(user, emailId, { action: "confirm" });
    expect(result.email).toMatchObject({ jobId: job.id, detectedStatus: "applied", statusChange: { from: "applied", to: "applied" } });
    expect(result.job!.history).toHaveLength(1);
  });

  it("answers NotFoundError when there is nothing to confirm", async () => {
    const user = await createUser();
    const gone = await makeJob(user, { status: "applied" });
    const noSuggestion = await makeEmail(user, { suggestedJobIds: [], reviewReason: "unknown_job" });
    const deletedSuggestion = await makeEmail(user, { suggestedJobIds: [gone.id] });
    await deleteJob(user, gone.id);

    for (const emailId of [noSuggestion, deletedSuggestion]) {
      const err = await resolveReview(user, emailId, { action: "confirm" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toBe("Nothing to confirm: no suggested job");
      expect((await outcomeOf(emailId)).outcome).toBe("review");
    }
  });

  it("assigns the email to a chosen job and status, even a locked one", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    await updateJob(user, job.id, { status: "interview" }); // locked by the manual change
    const emailId = await makeEmail(user, { suggestedJobIds: [], reviewReason: "unknown_job" });

    const result = await resolveReview(user, emailId, { action: "assign", jobId: job.id, status: "offer" });
    expect(result.email).toMatchObject({ outcome: "resolved", detectedStatus: "offer", jobId: job.id, statusChange: { from: "interview", to: "offer" } });
    expect(result.job).toMatchObject({ id: job.id, status: "offer", statusSource: "review", statusLocked: true });
  });

  it("answers NotFoundError when assigning to a job that does not exist", async () => {
    const user = await createUser();
    const emailId = await makeEmail(user);
    for (const jobId of ["nope", "0190a5b4-0000-7000-8000-000000000000"]) {
      await expect(resolveReview(user, emailId, { action: "assign", jobId, status: "applied" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
    expect((await outcomeOf(emailId)).outcome).toBe("review");
  });

  it("creates a job from the email as the mock did: applied first, then the chosen status", async () => {
    const user = await createUser();
    const emailId = await makeEmail(user, { subject: "Next steps", suggestedJobIds: [], reviewReason: "unknown_job" });

    const { email, job } = await resolveReview(user, emailId, {
      action: "create",
      company: "Vantage Bio",
      title: "Lab Data Engineer",
      status: "interview",
    });
    expect(job).toMatchObject({
      company: "Vantage Bio",
      title: "Lab Data Engineer",
      url: null,
      description: 'Created from an email: "Next steps"',
      status: "interview",
      statusSource: "review",
      captureMethod: "email",
      emailCount: 1,
    });
    expect(job!.appliedAt).not.toBeNull();
    // Both events happen in one transaction (same time) and keep their order.
    expect(job!.history.map((e) => [e.from, e.to, e.source, e.emailId])).toEqual([
      [null, "applied", "review", undefined],
      ["applied", "interview", "review", emailId],
    ]);
    expect(email).toMatchObject({ outcome: "resolved", detectedStatus: "interview", jobId: job!.id, statusChange: { from: "applied", to: "interview" } });
  });

  it("creates with status applied without a second event", async () => {
    const user = await createUser();
    const emailId = await makeEmail(user);
    const { email, job } = await resolveReview(user, emailId, {
      action: "create",
      company: "Silt & Stone",
      title: "Site Engineer",
      status: "applied",
    });
    expect(job!.history).toHaveLength(1);
    expect(email.statusChange).toEqual({ from: "applied", to: "applied" });
  });

  it("links to the job a created one would duplicate", async () => {
    const user = await createUser();
    const existing = await makeJob(user, { company: "Vantage Bio", title: "Lab Data Engineer", status: "applied", description: "Mine" });
    const emailId = await makeEmail(user);
    const { job } = await resolveReview(user, emailId, {
      action: "create",
      company: "VANTAGE BIO",
      title: "lab data engineer",
      status: "rejected",
    });
    expect(job).toMatchObject({ id: existing.id, status: "rejected", description: "Mine", captureMethod: "paste" });
    expect(await countRows("jobs")).toBe(1);
  });

  it("answers 409 when the email is no longer in review", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    const emailId = await makeEmail(user, { suggestedJobIds: [job.id], suggestedStatus: "interview" });
    await resolveReview(user, emailId, { action: "confirm" });

    const actions = [
      { action: "confirm" },
      { action: "dismiss" },
      { action: "assign", jobId: job.id, status: "offer" },
      { action: "create", company: "Acme", title: "Engineer", status: "applied" },
    ] as const;
    for (const action of actions) {
      await expect(resolveReview(user, emailId, action)).rejects.toBeInstanceOf(ConflictError);
    }
    const matched = await makeEmail(user, { outcome: "matched", reviewReason: null });
    await expect(resolveReview(user, matched, { action: "dismiss" })).rejects.toBeInstanceOf(ConflictError);
    expect(await countRows("jobs")).toBe(1);
    expect((await loadJob(getDb(), user, job.id)).history).toHaveLength(2);
  });

  it("resolves an email once when two requests race", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    const emailId = await makeEmail(user, { suggestedJobIds: [job.id], suggestedStatus: "interview" });
    const results = await Promise.allSettled([
      resolveReview(user, emailId, { action: "confirm" }),
      resolveReview(user, emailId, { action: "confirm" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
    expect((await loadJob(getDb(), user, job.id)).history).toHaveLength(2);
  });

  it("answers NotFoundError for unknown and malformed email ids", async () => {
    const user = await createUser();
    for (const id of ["x", "0190a5b4-0000-7000-8000-000000000000"]) {
      await expect(resolveReview(user, id, { action: "dismiss" })).rejects.toBeInstanceOf(NotFoundError);
    }
  });
});
