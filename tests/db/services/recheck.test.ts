import { expect, it } from "vitest";
import { getDb } from "@/lib/server/db/client";
import { listEmails } from "@/lib/server/services/emails";
import { listAllJobs } from "@/lib/server/services/jobs";
import { recheckReview } from "@/lib/server/services/recheck";
import { resolveReview } from "@/lib/server/services/review";
import { addRule } from "@/lib/server/services/rules";
import type { Email } from "@/lib/types";
import { countRows, createUser, makeEmail, makeJob, type EmailFields } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";

// "Check again" on the review list (src/lib/server/services/recheck.ts): the mail that waits
// for review, classified again oldest first and written as the sync writes new mail.

const NOW = new Date(Date.UTC(2026, 10, 17, 12));
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

/** An email waiting in review as "No matching job", as an older release left it. */
const waiting = (userId: string, days: number, e: EmailFields) =>
  makeEmail(userId, { receivedAt: daysAgo(days), reviewReason: "unknown_job", ...e });

const TESSIN = { fromName: "Tessin Recruiting", fromAddress: "tessin@successfactors.example" };

async function emailById(userId: string, id: string): Promise<Email> {
  return (await listEmails(getDb(), userId)).find((e) => e.id === id)!;
}

describeDb("review re-check", () => {
  it("replays a chain oldest first: the confirmation creates the job, the rejection finds it", async () => {
    const user = await createUser({ rules: true });
    // Stored newest first, to show that the order is the received time.
    const rejection = await waiting(user, 3, {
      ...TESSIN,
      subject: "Deine Bewerbung als IT-Operations Engineer (m/w/d) (40021)",
      body: "vielen Dank für deine Bewerbung. Wir können dich bedauerlicherweise nicht in die engere Wahl nehmen. Tessin AG",
      detectedStatus: "rejected",
      suggestedStatus: "rejected",
    });
    const confirmation = await waiting(user, 10, {
      ...TESSIN,
      subject: "Deine Bewerbung als IT-Operations Engineer (m/w/d) (40021)",
      body: "herzlichen Dank für deine Bewerbung. Deine Unterlagen prüfen wir sehr sorgfältig. Tessin AG",
    });

    expect(await recheckReview(user, NOW)).toEqual({ checked: 2, linked: 1, created: 1, dismissed: 0, remaining: 0 });

    const [job] = await listAllJobs(getDb(), user);
    expect(job).toMatchObject({ company: "Tessin", title: "IT-Operations Engineer", status: "rejected", emailCount: 2 });
    expect(job.history.map((h) => [h.from, h.to, h.source, h.at])).toEqual([
      [null, "applied", "email", daysAgo(10).toISOString()],
      ["applied", "rejected", "email", daysAgo(3).toISOString()],
    ]);
    expect(await emailById(user, confirmation)).toMatchObject({
      outcome: "created",
      jobId: job.id,
      detectedStatus: "applied",
      matchedKeywords: ["dank für deine bewerbung"],
      statusChange: { from: null, to: "applied" },
      reviewReason: null,
      language: "de",
    });
    expect(await emailById(user, rejection)).toMatchObject({
      outcome: "matched",
      jobId: job.id,
      detectedStatus: "rejected",
      statusChange: { from: "applied", to: "rejected" },
      reviewReason: null,
      suggestedStatus: null,
    });
    // Nothing left to check: the same again changes nothing.
    expect(await recheckReview(user, NOW)).toEqual({ checked: 0, linked: 0, created: 0, dismissed: 0, remaining: 0 });
    expect(await countRows("jobs")).toBe(1);
  });

  it("starts a job in the stage its first mail reports, with the history of an application", async () => {
    const user = await createUser({ rules: true });
    const rejection = await waiting(user, 5, {
      fromName: "Norvik",
      fromAddress: "karriere@norvik.example",
      subject: "Norvik | Deine Bewerbung",
      body: "Deine Bewerbung für die Stelle Frontend Developer (w/m/d): wir müssen Dir leider mitteilen, dass wir uns für andere Kandidaten entschieden haben.",
    });

    expect(await recheckReview(user, NOW)).toMatchObject({ created: 1, remaining: 0 });

    const [job] = await listAllJobs(getDb(), user);
    expect(job).toMatchObject({ company: "Norvik", title: "Frontend Developer", status: "rejected", captureMethod: "email" });
    expect(job.history.map((h) => [h.from, h.to, h.at])).toEqual([
      [null, "applied", daysAgo(5).toISOString()],
      ["applied", "rejected", daysAgo(5).toISOString()],
    ]);
    expect(await emailById(user, rejection)).toMatchObject({
      outcome: "created",
      jobId: job.id,
      statusChange: { from: "applied", to: "rejected" },
    });
  });

  it("dismisses what is no job mail, and keeps in review what still cannot name its job", async () => {
    const user = await createUser({ rules: true });
    const study = await waiting(user, 9, {
      fromName: "",
      fromAddress: "noreply@hs-nordhafen.example",
      subject: "Bewerbung an der Hochschule Nordhafen",
      body: "Eingangsbestätigung: vielen Dank für Ihre Bewerbung für einen Studienplatz.",
      detectedStatus: "applied",
    });
    const receipt = await waiting(user, 8, {
      fromName: "Indeed-Bewerben-Funktion",
      fromAddress: "indeedapply@indeed.example",
      subject: "Bewerbung über Indeed: Web Developer (m/w/d)",
      body: "Ihre Bewerbung wurde weitergeleitet. Viel Erfolg!",
    });

    expect(await recheckReview(user, NOW)).toEqual({ checked: 2, linked: 0, created: 0, dismissed: 1, remaining: 1 });

    expect(await emailById(user, study)).toMatchObject({ outcome: "dismissed", jobId: null });
    // Still in review, with what the rules of now read in it.
    expect(await emailById(user, receipt)).toMatchObject({
      outcome: "review",
      reviewReason: "unknown_job",
      detectedStatus: "applied",
      suggestedStatus: "applied",
      matchedKeywords: ["bewerbung wurde weitergeleitet"],
    });
    expect(await countRows("jobs")).toBe(0);
  });

  it("links to a job the owner added since, and uses a keyword they added", async () => {
    const user = await createUser({ rules: true });
    const job = await makeJob(user, { company: "Lumora", title: "Backend Engineer", status: "applied" });
    await testSql()`UPDATE jobs SET created_at = ${daysAgo(30)} WHERE id = ${job.id}`;
    const mail = await waiting(user, 2, {
      fromName: "Lumora",
      fromAddress: "jobs@lumora.example",
      subject: "Deine Bewerbung bei Lumora",
      body: "Wir haben uns gegen eine Zusammenarbeit entschieden.",
      reviewReason: "no_keyword",
    });

    // No keyword yet: it stays, now suggesting the job.
    expect(await recheckReview(user, NOW)).toMatchObject({ linked: 0, remaining: 1 });
    expect(await emailById(user, mail)).toMatchObject({ outcome: "review", reviewReason: "no_keyword", suggestedJobIds: [job.id] });

    await addRule(user, { status: "rejected", phrase: "gegen eine Zusammenarbeit", language: "de" });
    expect(await recheckReview(user, NOW)).toMatchObject({ linked: 1, remaining: 0 });
    expect(await emailById(user, mail)).toMatchObject({
      outcome: "matched",
      jobId: job.id,
      statusChange: { from: "applied", to: "rejected" },
    });
    expect((await listAllJobs(getDb(), user))[0]).toMatchObject({ status: "rejected", statusSource: "email" });
  });

  it("never lets bulk mail change a job: the reason, and the stored headers", async () => {
    const user = await createUser({ rules: true });
    const job = await makeJob(user, { company: "Zalando", title: "Data Engineer", status: "applied" });
    await testSql()`UPDATE jobs SET created_at = ${daysAgo(30)} WHERE id = ${job.id}`;
    const shop = { fromName: "Zalando", fromAddress: "info@service-mail.zalando.de", subject: "Deine Bestellung", body: "Wir können deine Bestellung nicht berücksichtigen." };
    // In review as a mass mailing before the headers were stored: left alone.
    const old = await waiting(user, 4, { ...shop, reviewReason: "bulk_mail", suggestedJobIds: [job.id], suggestedStatus: "rejected" });
    // Stored with its headers, in review for another reason: classified as bulk mail.
    const flagged = await waiting(user, 3, { ...shop, reviewReason: "no_keyword" });
    await testSql()`UPDATE emails SET bulk = true WHERE id = ${flagged}`;
    // The same text without bulk headers is the employer's mail about the application.
    const plain = await waiting(user, 2, { ...shop, reviewReason: "no_keyword" });
    await testSql()`UPDATE emails SET bulk = false WHERE id = ${plain}`;

    expect(await recheckReview(user, NOW)).toEqual({ checked: 3, linked: 1, created: 0, dismissed: 0, remaining: 2 });

    expect(await emailById(user, old)).toMatchObject({ outcome: "review", reviewReason: "bulk_mail", suggestedJobIds: [job.id] });
    expect(await emailById(user, flagged)).toMatchObject({ outcome: "review", reviewReason: "bulk_mail", suggestedStatus: "rejected" });
    expect(await emailById(user, plain)).toMatchObject({ outcome: "matched", jobId: job.id, statusChange: { from: "applied", to: "rejected" } });
  });

  it("touches only mail that waits for review, and only the user's", async () => {
    const user = await createUser({ rules: true });
    const other = await createUser({ rules: true });
    const mail = {
      ...TESSIN,
      subject: "Deine Bewerbung als IT-Operations Engineer (m/w/d)",
      body: "herzlichen Dank für deine Bewerbung. Tessin AG",
    };
    const dismissed = await waiting(user, 6, mail);
    await resolveReview(user, dismissed, { action: "dismiss" });
    const resolved = await waiting(user, 5, mail);
    await resolveReview(user, resolved, { action: "create", company: "Tessin Holding", title: "Operations", status: "applied" });
    const others = await waiting(other, 4, mail);

    expect(await recheckReview(user, NOW)).toEqual({ checked: 0, linked: 0, created: 0, dismissed: 0, remaining: 0 });

    expect(await emailById(user, dismissed)).toMatchObject({ outcome: "dismissed", jobId: null });
    expect(await emailById(user, resolved)).toMatchObject({ outcome: "resolved" });
    expect(await emailById(other, others)).toMatchObject({ outcome: "review", reviewReason: "unknown_job" });
    expect(await listAllJobs(getDb(), other)).toEqual([]);
    expect((await listAllJobs(getDb(), user)).map((j) => j.company)).toEqual(["Tessin Holding"]);
  });
});
