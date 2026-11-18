import { expect, it } from "vitest";
import { getDb, withTx } from "@/lib/server/db/client";
import { BadRequestError, NotFoundError } from "@/lib/server/errors";
import { insertEmail, listEmails } from "@/lib/server/services/emails";
import {
  applyStatusChange,
  createJobFromEmail,
  deleteJob,
  linkEmail,
  loadJob,
  updateJob,
} from "@/lib/server/services/jobs";
import { getStats } from "@/lib/server/services/stats";
import { ageJob, countRows, createUser, makeEmail, makeJob } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";

const db = () => getDb();

describeDb("write path, emails and stats", () => {
  /* -------------------------------------------------- applyStatusChange */

  it("records a change with the given time, note and email", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "saved" });
    const emailId = await makeEmail(user, { outcome: "matched", reviewReason: null });
    const at = new Date(Date.now() + 60_000);

    const result = await withTx((tx) =>
      applyStatusChange(tx, user, job.id, { to: "applied", source: "email", at, emailId, note: "From mail" }),
    );
    expect(result).toEqual({ from: "saved", to: "applied", changed: true });
    const after = await loadJob(db(), user, job.id);
    expect(after).toMatchObject({
      status: "applied",
      statusSource: "email",
      statusLocked: false,
      appliedAt: at.toISOString(),
      lastActivityAt: at.toISOString(),
    });
    expect(after.history.at(-1)).toEqual({
      id: expect.any(String),
      from: "saved",
      to: "applied",
      at: at.toISOString(),
      source: "email",
      emailId,
      note: "From mail",
    });
  });

  it("records nothing for the same status and only moves the last activity", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    await ageJob(job.id);
    const before = await loadJob(db(), user, job.id);

    const result = await withTx((tx) => applyStatusChange(tx, user, job.id, { to: "applied", source: "email" }));
    expect(result).toEqual({ from: "applied", to: "applied", changed: false });
    const after = await loadJob(db(), user, job.id);
    expect(after.history).toHaveLength(1);
    expect(after.lastActivityAt > before.lastActivityAt).toBe(true);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.statusSource).toBe("paste");
  });

  it("never moves the last activity backwards", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    const old = new Date(Date.now() - 7 * 86_400_000);
    await withTx((tx) => applyStatusChange(tx, user, job.id, { to: "interview", source: "email", at: old }));
    const after = await loadJob(db(), user, job.id);
    expect(after.lastActivityAt).toBe(job.lastActivityAt);
    // History is ordered by time, so the back-dated change sorts first.
    expect(after.history.map((e) => [e.to, e.at])).toEqual([
      ["interview", old.toISOString()],
      ["applied", job.createdAt],
    ]);
  });

  it("sets the lock only with a real change", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    await withTx((tx) => applyStatusChange(tx, user, job.id, { to: "applied", source: "manual", lock: true }));
    expect((await loadJob(db(), user, job.id)).statusLocked).toBe(false);
    await withTx((tx) => applyStatusChange(tx, user, job.id, { to: "offer", source: "manual", lock: true }));
    expect((await loadJob(db(), user, job.id)).statusLocked).toBe(true);
  });

  /* ---------------------------------------------------------- linkEmail */

  it("links an email and applies its status to an unlocked job", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    const emailId = await makeEmail(user, { outcome: "matched", reviewReason: null });
    await ageJob(job.id);

    const { email, changed } = await withTx((tx) =>
      linkEmail(tx, user, { emailId, jobId: job.id, to: "interview", source: "email" }),
    );
    expect(changed).toBe(true);
    expect(email).toMatchObject({ id: emailId, jobId: job.id, statusChange: { from: "applied", to: "interview" } });
    const after = await loadJob(db(), user, job.id);
    expect(after).toMatchObject({ status: "interview", statusSource: "email", statusLocked: false, emailCount: 1 });
    expect(after.history.at(-1)).toMatchObject({ from: "applied", to: "interview", source: "email", emailId });
    expect(after.lastActivityAt > job.lastActivityAt).toBe(true);
  });

  it("links an email to a locked job but keeps its status", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    await updateJob(user, job.id, { status: "interview" }); // manual: locked
    await ageJob(job.id);
    const before = await loadJob(db(), user, job.id);
    const emailId = await makeEmail(user, { outcome: "matched", reviewReason: null });

    const { email, changed } = await withTx((tx) =>
      linkEmail(tx, user, { emailId, jobId: job.id, to: "rejected", source: "email" }),
    );
    expect(changed).toBe(false);
    expect(email).toMatchObject({ jobId: job.id, statusChange: { from: "interview", to: "interview" } });
    const after = await loadJob(db(), user, job.id);
    expect(after).toMatchObject({ status: "interview", statusLocked: true, statusSource: "manual", emailCount: 1 });
    expect(after.history).toHaveLength(before.history.length);
    expect(after.lastActivityAt > before.lastActivityAt).toBe(true);
  });

  it("applies a review-sourced link to a locked job", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    await updateJob(user, job.id, { status: "interview" });
    const emailId = await makeEmail(user, { outcome: "matched", reviewReason: null });

    const { email } = await withTx((tx) =>
      linkEmail(tx, user, { emailId, jobId: job.id, to: "rejected", source: "review" }),
    );
    expect(email.statusChange).toEqual({ from: "interview", to: "rejected" });
    expect(await loadJob(db(), user, job.id)).toMatchObject({ status: "rejected", statusSource: "review", statusLocked: true });
  });

  it("rolls back the whole transaction when a step fails", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    await expect(
      withTx(async (tx) => {
        await applyStatusChange(tx, user, job.id, { to: "interview", source: "email" });
        await linkEmail(tx, user, { emailId: "nope", jobId: job.id, to: "offer", source: "email" });
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await loadJob(db(), user, job.id)).toMatchObject({ status: "applied", history: [expect.anything()] });
  });

  /* ------------------------------------------------- createJobFromEmail */

  it("creates a job from an email and links the email to it", async () => {
    const user = await createUser();
    const at = new Date(Date.now() - 3_600_000);
    const created = await withTx(async (tx) => {
      const email = await insertEmail(tx, user, {
        fromName: "Bramble Careers",
        fromAddress: "careers@bramble.example.com",
        subject: "Thank you for applying – Product Designer",
        body: "We received your application.",
        receivedAt: at,
        language: "en",
        outcome: "created",
        detectedStatus: "applied",
        matchedKeywords: ["thank you for applying"],
        confidence: 0.85,
      });
      return createJobFromEmail(tx, user, {
        company: "  Bramble  ",
        title: "Product Designer",
        status: "applied",
        source: "email",
        emailId: email.id,
        note: "Created from a confirmation email",
        description: "Created automatically from a confirmation email.",
        at,
      });
    });
    expect(created.created).toBe(true);
    expect(created.job).toMatchObject({
      company: "Bramble",
      title: "Product Designer",
      url: null,
      status: "applied",
      statusSource: "email",
      captureMethod: "email",
      appliedAt: at.toISOString(),
      lastActivityAt: at.toISOString(),
      emailCount: 1,
    });
    expect(created.job.history).toEqual([
      {
        id: expect.any(String),
        from: null,
        to: "applied",
        at: at.toISOString(),
        source: "email",
        emailId: created.email!.id,
        note: "Created from a confirmation email",
      },
    ]);
    expect(created.email).toMatchObject({
      jobId: created.job.id,
      outcome: "created",
      statusChange: { from: null, to: "applied" },
      matchedKeywords: ["thank you for applying"],
    });
  });

  it("links to the job it duplicates instead of creating one, with the note", async () => {
    const user = await createUser();
    const job = await makeJob(user, { company: "Bramble GmbH", title: "Product Designer", status: "saved", description: "Mine" });
    const emailId = await makeEmail(user, { outcome: "matched", reviewReason: null });
    const result = await withTx((tx) =>
      createJobFromEmail(tx, user, {
        company: "BRAMBLE",
        title: "product designer",
        status: "applied",
        source: "email",
        emailId,
        note: "Created from a confirmation email",
        description: "Created automatically from a confirmation email.",
      }),
    );
    expect(result.created).toBe(false);
    expect(result.job).toMatchObject({ id: job.id, status: "applied", captureMethod: "paste", description: "Mine" });
    expect(result.job.history.at(-1)).toMatchObject({
      from: "saved",
      to: "applied",
      source: "email",
      emailId,
      note: "Created from a confirmation email",
    });
    expect(result.email).toMatchObject({ jobId: job.id, statusChange: { from: "saved", to: "applied" } });
    expect(await countRows("jobs")).toBe(1);
  });

  it("never moves an existing job back to applied, with or without an email", async () => {
    // A late "thank you for applying" for a job already at interview (unlocked, so the lock
    // rule does not hide this). Area 2's rule, as in upsertJob: applied never moves backwards.
    const user = await createUser();
    const job = await makeJob(user, { company: "Bramble", title: "Product Designer", status: "applied" });
    await withTx((tx) => applyStatusChange(tx, user, job.id, { to: "interview", source: "email" }));
    const before = await loadJob(db(), user, job.id);
    const emailId = await makeEmail(user, { outcome: "created", reviewReason: null });
    const input = { company: "Bramble", title: "Product Designer", status: "applied", source: "email" } as const;

    const result = await withTx((tx) =>
      createJobFromEmail(tx, user, { ...input, emailId, note: "Created from a confirmation email" }),
    );
    expect(result.created).toBe(false);
    expect(result.job).toMatchObject({ id: job.id, status: "interview", statusLocked: false, emailCount: 1 });
    expect(result.job.history).toEqual(before.history);
    expect(result.email).toMatchObject({ jobId: job.id, statusChange: { from: "interview", to: "interview" } });

    const { job: again } = await withTx((tx) => createJobFromEmail(tx, user, input));
    expect(again).toMatchObject({ id: job.id, status: "interview" });
    expect(again.history).toEqual(before.history);
  });

  it("dates a job made from back-dated mail at the mail's time, createdAt included", async () => {
    // Area 2's backfill passes the received time as `at`, and sends mail older than the job to
    // review: a createdAt of "now" would send every later backfilled email there.
    const user = await createUser();
    const at = new Date(Date.now() - 20 * 86_400_000);
    const { job } = await withTx((tx) =>
      createJobFromEmail(tx, user, { company: "Kestrel", title: "Data Engineer", status: "applied", source: "email", at }),
    );
    expect(job).toMatchObject({
      createdAt: at.toISOString(),
      appliedAt: at.toISOString(),
      lastActivityAt: at.toISOString(),
    });
    expect(job.history.map((e) => e.at)).toEqual([at.toISOString()]);
  });

  it("cuts guessed values to fit and refuses blank ones", async () => {
    const user = await createUser();
    const { job } = await withTx((tx) =>
      createJobFromEmail(tx, user, { company: "Acme", title: "x".repeat(250), status: "applied", source: "email" }),
    );
    expect(job.title).toHaveLength(200);
    await expect(
      withTx((tx) => createJobFromEmail(tx, user, { company: "   ", title: "Role", status: "applied", source: "email" })),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  /* ------------------------------------------------- insertEmail, lists */

  it("drops suggested ids that are malformed or no longer exist", async () => {
    const user = await createUser();
    const a = await makeJob(user, { title: "A" });
    const b = await makeJob(user, { title: "B" });
    const email = await withTx((tx) =>
      insertEmail(tx, user, {
        receivedAt: new Date(),
        outcome: "review",
        reviewReason: "ambiguous_job",
        suggestedJobIds: [b.id, "junk", a.id],
        suggestedStatus: "interview",
        confidence: 0.5,
      }),
    );
    expect(email).toMatchObject({ jobId: null, statusChange: null, suggestedJobIds: [b.id, a.id], fromName: "" });
    await deleteJob(user, b.id);
    const [listed] = await listEmails(db(), user, { outcomes: ["review"] });
    expect(listed.suggestedJobIds).toEqual([a.id]);
  });

  it("lists emails newest first, filtered by outcome and job", async () => {
    const user = await createUser();
    const job = await makeJob(user);
    const day = (d: number) => new Date(Date.UTC(2026, 10, d, 9));
    const e1 = await makeEmail(user, { receivedAt: day(1), outcome: "matched", jobId: job.id, reviewReason: null });
    const e2 = await makeEmail(user, { receivedAt: day(3), outcome: "review" });
    const e3 = await makeEmail(user, { receivedAt: day(2), outcome: "ignored", reviewReason: null });

    expect((await listEmails(db(), user)).map((e) => e.id)).toEqual([e2, e3, e1]);
    expect((await listEmails(db(), user, { outcomes: ["review", "matched"] })).map((e) => e.id)).toEqual([e2, e1]);
    expect((await listEmails(db(), user, { jobId: job.id })).map((e) => e.id)).toEqual([e1]);
    expect(await listEmails(db(), user, { jobId: "not-a-uuid" })).toEqual([]);
    expect(await listEmails(db(), user, { jobId: "" })).toHaveLength(3);
  });

  it("counts jobs per status and emails in review", async () => {
    const user = await createUser();
    expect(await getStats(db(), user)).toEqual({
      byStatus: { saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0, no_response: 0 },
      total: 0,
      reviewCount: 0,
    });
    await makeJob(user, { title: "A", status: "saved" });
    await makeJob(user, { title: "B", status: "applied" });
    const c = await makeJob(user, { title: "C", status: "applied" });
    await updateJob(user, c.id, { status: "offer" });
    await makeEmail(user, { outcome: "review" });
    await makeEmail(user, { outcome: "review" });
    await makeEmail(user, { outcome: "dismissed" });
    expect(await getStats(db(), user)).toEqual({
      byStatus: { saved: 1, applied: 1, interview: 0, offer: 1, rejected: 0, no_response: 0 },
      total: 3,
      reviewCount: 2,
    });
  });

  it("keeps a linked email's row when its job is deleted", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    const emailId = await makeEmail(user, { outcome: "matched", reviewReason: null });
    await withTx((tx) => linkEmail(tx, user, { emailId, jobId: job.id, to: "interview", source: "email" }));
    await deleteJob(user, job.id);
    const [email] = await listEmails(db(), user);
    expect(email).toMatchObject({ id: emailId, jobId: null, statusChange: { from: "applied", to: "interview" } });
    const [{ count }] = await testSql()`SELECT count(*)::int AS count FROM job_status_events`;
    expect(count).toBe(0);
  });
});
