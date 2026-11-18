import { expect, it } from "vitest";
import { getDb, withTx } from "@/lib/server/db/client";
import { NotFoundError } from "@/lib/server/errors";
import { classify } from "@/lib/server/services/classify";
import { insertEmail, listEmails } from "@/lib/server/services/emails";
import {
  applyStatusChange,
  createJobFromEmail,
  deleteJob,
  getJob,
  linkEmail,
  listAllJobs,
  listJobs,
  loadJob,
  updateJob,
  upsertJob,
} from "@/lib/server/services/jobs";
import { parseInput } from "@/lib/server/services/parse";
import { resolveReview } from "@/lib/server/services/review";
import { addRule, deleteRule, listRules } from "@/lib/server/services/rules";
import { getSettings, updateSettings } from "@/lib/server/services/settings";
import { getStats } from "@/lib/server/services/stats";
import type { ReviewAction } from "@/lib/types";
import { createUser, makeEmail, makeJob } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";

const LINK = "https://boards.example.com/parcelwerk/jobs/4711";

/** User A with a job, a review email suggesting it, a linked email and a rule. */
async function aliceWithData() {
  const alice = await createUser();
  const job = await makeJob(alice, { company: "Parcelwerk", title: "Frontend Engineer", url: LINK, status: "applied" });
  const reviewEmail = await makeEmail(alice, { suggestedJobIds: [job.id], suggestedStatus: "interview" });
  const linkedEmail = await makeEmail(alice, { jobId: job.id, outcome: "matched", reviewReason: null });
  const rule = await addRule(alice, { status: "offer", phrase: "vertragsangebot", language: "de" });
  await updateSettings(alice, { noResponseDays: 60 });
  return { alice, job, reviewEmail, linkedEmail, rule };
}

/** Everything of A's, to check that nothing B does changes it. */
async function snapshot(userId: string) {
  const db = getDb();
  return {
    jobs: await listJobs(db, userId),
    emails: await listEmails(db, userId),
    rules: await listRules(db, userId),
    settings: await getSettings(db, userId),
  };
}

describeDb("user isolation", () => {
  it("answers NotFoundError to user B for each of user A's rows, on every path", async () => {
    const a = await aliceWithData();
    const bob = await createUser();
    const bobsJob = await makeJob(bob, { title: "Bob's job", status: "applied" });
    const bobsEmail = await makeEmail(bob);
    const before = await snapshot(a.alice);
    const db = getDb();

    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["getJob", () => getJob(db, bob, a.job.id)],
      ["loadJob", () => loadJob(db, bob, a.job.id)],
      ["updateJob", () => updateJob(bob, a.job.id, { title: "Mine now" })],
      ["updateJob status", () => updateJob(bob, a.job.id, { status: "rejected" })],
      ["deleteJob", () => deleteJob(bob, a.job.id)],
      ["deleteRule", () => deleteRule(bob, a.rule.id)],
      ...(["dismiss", "confirm", "create"] as const).map(
        (action): [string, () => Promise<unknown>] => [
          `resolveReview ${action}`,
          () =>
            resolveReview(
              bob,
              a.reviewEmail,
              (action === "create"
                ? { action, company: "Acme", title: "Engineer", status: "applied" }
                : { action }) as ReviewAction,
            ),
        ],
      ),
      [
        "resolveReview assign A's email to B's job",
        () => resolveReview(bob, a.reviewEmail, { action: "assign", jobId: bobsJob.id, status: "offer" }),
      ],
      [
        "resolveReview assign B's email to A's job",
        () => resolveReview(bob, bobsEmail, { action: "assign", jobId: a.job.id, status: "offer" }),
      ],
      [
        "applyStatusChange",
        () => withTx((tx) => applyStatusChange(tx, bob, a.job.id, { to: "offer", source: "email" })),
      ],
      [
        "linkEmail A's email to B's job",
        () => withTx((tx) => linkEmail(tx, bob, { emailId: a.reviewEmail, jobId: bobsJob.id, to: "offer", source: "email" })),
      ],
      [
        "linkEmail B's email to A's job",
        () => withTx((tx) => linkEmail(tx, bob, { emailId: bobsEmail, jobId: a.job.id, to: "offer", source: "review" })),
      ],
      [
        "createJobFromEmail with A's email",
        () =>
          withTx((tx) =>
            createJobFromEmail(tx, bob, { company: "Acme", title: "Engineer", status: "applied", source: "email", emailId: a.reviewEmail }),
          ),
      ],
    ];
    for (const [name, attempt] of attempts) {
      const err = await attempt().catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(NotFoundError);
    }

    expect(await snapshot(a.alice)).toEqual(before);
    // B's own rows are untouched too.
    expect(await loadJob(db, bob, bobsJob.id)).toMatchObject({ status: "applied", emailCount: 0 });
  });

  it("never shows user A's rows in user B's lists, stats, suggestions or duplicates", async () => {
    const a = await aliceWithData();
    const bob = await createUser();
    const db = getDb();

    expect(await listJobs(db, bob)).toEqual([]);
    expect(await listJobs(db, bob, { q: "parcelwerk" })).toEqual([]);
    expect(await listAllJobs(db, bob)).toEqual([]);
    expect(await listEmails(db, bob)).toEqual([]);
    expect(await listEmails(db, bob, { jobId: a.job.id })).toEqual([]);
    expect(await listEmails(db, bob, { outcomes: ["review", "matched"] })).toEqual([]);
    expect(await listRules(db, bob)).toEqual([]);
    expect(await getStats(db, bob)).toEqual({
      byStatus: { saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0, no_response: 0 },
      total: 0,
      reviewCount: 0,
    });
    expect((await getSettings(db, bob)).noResponseDays).toBe(30);

    // Duplicate lookups.
    expect((await parseInput(db, bob, LINK)).duplicateOf).toBeNull();
    expect((await parseInput(db, bob, "Title: Frontend Engineer\nCompany: Parcelwerk")).duplicateOf).toBeNull();
    const own = await upsertJob(bob, {
      title: "Frontend Engineer",
      company: "Parcelwerk",
      location: "",
      url: LINK,
      description: "",
      status: "saved",
      captureMethod: "paste",
    });
    expect(own.duplicate).toBe(false);
    expect(own.job.id).not.toBe(a.job.id);
    const fromMail = await withTx((tx) =>
      createJobFromEmail(tx, bob, { company: "Parcelwerk", title: "Frontend Engineer", status: "applied", source: "email" }),
    );
    expect(fromMail.job.id).toBe(own.job.id);

    // A's job id in B's email suggestions is dropped on read, so there is nothing to confirm.
    const bobsEmail = await makeEmail(bob, { suggestedJobIds: [a.job.id] });
    const [listed] = await listEmails(db, bob);
    expect(listed.suggestedJobIds).toEqual([]);
    await expect(resolveReview(bob, bobsEmail, { action: "confirm" })).rejects.toThrow("Nothing to confirm");
    const inserted = await withTx((tx) =>
      insertEmail(tx, bob, { receivedAt: new Date(), outcome: "review", suggestedJobIds: [a.job.id, own.job.id], confidence: 0.5 }),
    );
    expect(inserted.suggestedJobIds).toEqual([own.job.id]);

    // The rule tester sees only B's jobs and rules.
    const result = await classify(db, bob, {
      fromAddress: "jobs@parcelwerk.example.com",
      subject: "Vertragsangebot",
      body: "Frontend Engineer at Parcelwerk",
    });
    expect(result.candidates.map((j) => j.id)).toEqual([own.job.id]);
    expect(result.matchedKeywords).toEqual([]);

    // And A still sees exactly A's rows.
    expect((await listJobs(db, a.alice)).map((j) => j.id)).toEqual([a.job.id]);
    expect((await getStats(db, a.alice)).reviewCount).toBe(1);
  });

  it("keeps user B's same rule and settings separate", async () => {
    const a = await aliceWithData();
    const bob = await createUser();
    const bobsRule = await addRule(bob, { status: "offer", phrase: "Vertragsangebot", language: "de" });
    expect(bobsRule.id).not.toBe(a.rule.id);
    await updateSettings(bob, { noResponseDays: 14, languages: ["en"] });
    expect((await getSettings(getDb(), a.alice)).noResponseDays).toBe(60);
    const [{ count }] = await testSql()`SELECT count(*)::int AS count FROM keyword_rules`;
    expect(count).toBe(2);
  });
});
