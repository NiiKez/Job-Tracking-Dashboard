import { afterEach, beforeEach, expect, it } from "vitest";
import { getDb } from "@/lib/server/db/client";
import { parseGmailMessage } from "@/lib/server/inbox/parse/gmail-message";
import { isSyncing, runInboxCheck } from "@/lib/server/inbox/sync/engine";
import { ingestParsed } from "@/lib/server/inbox/sync/ingest";
import { listEmails } from "@/lib/server/services/emails";
import { listAllJobs } from "@/lib/server/services/jobs";
import type { Email, Job } from "@/lib/types";
import { buildSeed } from "../../../db/seed/fixtures";
import { createUser, makeEmail, makeJob } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";
import {
  DAY,
  demoUser,
  fixtureFiles,
  folderSource,
  gmailMessage,
  ledger,
  messageSource,
  NOW,
  restoreInboxEnv,
  snapshot,
  stubInboxEnv,
  sync,
} from "./support";
import { ensureDemoConnection } from "@/lib/server/inbox/repo";

// Ingest on the database (step 2.3): the demo mail in fixtures/mail through the sync engine and
// the per-message transaction, against the demo jobs of db/seed, everything at a fixed NOW.

/**
 * What each demo mail does to the demo jobs. "change" is the email's statusChange as the job saw
 * it ("new" when the email created the job). A job not named here does not change.
 */
type Row = [
  file: string,
  ledger: "stored" | "ignored" | "skipped" | "not listed",
  outcome: Email["outcome"] | null,
  reviewReason: Email["reviewReason"],
  job: string | null,
  change: string | null,
];

// prettier-ignore
const DEMO_MAIL: Row[] = [
  // file                                   ledger        outcome    reason             job                  change
  ["brightline-rejection-de.json",          "stored",     "matched", null,              "Brightline Energy", "applied -> rejected"],
  ["driftwood-confirmation.json",           "stored",     "created", null,              "Driftwood Audio",   "new -> applied"],
  ["ember-interview-invite.json",           "stored",     "matched", null,              "Ember Finance",     "applied -> interview"],
  ["fernweh-appointment-latin1.json",       "stored",     "matched", null,              "Fernweh Mobility",  "interview -> interview"],
  ["jobradar-alert.json",                   "ignored",    null,      null,              null,                null],
  ["juniper-ats-invite.json",               "stored",     "matched", null,              "Juniper Learning",  "applied -> interview"],
  // An interview invitation for a job that is already rejected: review, the job suggested first.
  ["kelpie-interview-after-rejection.json", "stored",     "review",  "status_mismatch", null,                null],
  ["lumen-interview-alternative.json",      "stored",     "matched", null,              "Lumen Health",      "applied -> interview"],
  ["newsletter-interview-tips.json",        "ignored",    null,      null,              null,                null],
  ["nimbus-offer-attachment-ref.json",      "stored",     "matched", null,              "Nimbus Docs",       "interview -> offer"],
  ["northwind-reply-quoted.json",           "stored",     "matched", null,              "Northwind Labs",    "interview -> interview"],
  // Sent mail: the first scan's listing leaves it out; the incremental sync skips it by label.
  ["northwind-sent-reply.json",             "not listed", null,      null,              null,                null],
  ["orbit-rejection-html-only.json",        "stored",     "matched", null,              "Orbit Payments",    "applied -> rejected"],
  ["personal-dinner-outlook-quote.json",    "ignored",    null,      null,              null,                null],
  // An applicant-tracking system for a company with no demo job, no role named: review.
  ["quillmark-ats-call.json",               "stored",     "review",  "unknown_job",     null,                null],
];

/** The jobs the demo mail changes: status before -> after, each change one "email" event. */
// prettier-ignore
const JOB_CHANGES: Record<string, string> = {
  "Brightline Energy": "applied -> rejected",
  "Driftwood Audio":   "(new) -> applied",
  "Ember Finance":     "applied -> interview",
  "Juniper Learning":  "applied -> interview",
  "Lumen Health":      "applied -> interview",
  "Nimbus Docs":       "interview -> offer",
  "Orbit Payments":    "applied -> rejected",
};

const STORED = DEMO_MAIL.filter((r) => r[1] === "stored").length;
/** Messages the first scan lists: all but the sent reply. */
const LISTED = DEMO_MAIL.filter((r) => r[1] !== "not listed").length;
const SEEDED_JOBS = buildSeed(NOW.getTime()).jobs.length;

/** The table as the database has it after the demo mail went through. */
async function outcomes(userId: string, sentMail: Row[1]): Promise<Row[]> {
  const files = await fixtureFiles();
  const seen = await ledger(userId);
  const emails = await testSql()<
    Array<{ gmail_message_id: string; outcome: Email["outcome"]; review_reason: Email["reviewReason"]; company: string | null; change_from: string | null; change_to: string | null }>
  >`
    SELECT e.gmail_message_id, e.outcome, e.review_reason, j.company, e.change_from, e.change_to
    FROM emails e LEFT JOIN jobs j ON j.id = e.job_id
    WHERE e.user_id = ${userId} AND e.gmail_message_id IS NOT NULL`;
  return files.map(({ file, id }) => {
    const email = emails.find((e) => e.gmail_message_id === id);
    const result = seen.get(id)?.result ?? "not listed";
    return [
      file,
      (file === "northwind-sent-reply.json" && result === sentMail ? "not listed" : result) as Row[1],
      email?.outcome ?? null,
      email?.review_reason ?? null,
      email?.company ?? null,
      email?.change_to ? `${email.change_from ?? "new"} -> ${email.change_to}` : null,
    ];
  });
}

/** Every job the run changed, as "from -> to", checking that each change is one email event. */
function jobChanges(before: Job[], after: Job[], emails: Email[]): Record<string, string> {
  const changes: Record<string, string> = {};
  for (const job of after) {
    const old = before.find((j) => j.id === job.id);
    if (old && old.status === job.status && old.history.length === job.history.length) {
      expect(job, job.company).toEqual(old.emailCount === job.emailCount ? old : { ...old, emailCount: job.emailCount, lastActivityAt: job.lastActivityAt });
      continue;
    }
    const added = job.history.slice(old?.history.length ?? 0);
    expect(added, job.company).toHaveLength(1);
    const [event] = added;
    const email = emails.find((e) => e.id === event.emailId);
    expect(event, job.company).toMatchObject({ source: "email", to: job.status, at: email?.receivedAt });
    changes[job.company] = `${old?.status ?? "(new)"} -> ${job.status}`;
  }
  return changes;
}

/** An applied job at Acme Robotics, created a month before NOW (makeJob stamps the real clock). */
async function acmeJob(userId: string): Promise<Job> {
  const job = await makeJob(userId, { company: "Acme Robotics", title: "Platform Engineer", status: "applied" });
  const at = new Date(NOW.getTime() - 30 * DAY);
  await testSql()`
    UPDATE jobs SET created_at = ${at}, applied_at = ${at}, updated_at = ${at}, last_activity_at = ${at} WHERE id = ${job.id}`;
  await testSql()`UPDATE job_status_events SET at = ${at} WHERE job_id = ${job.id}`;
  return job;
}

describeDb("ingest on the database", () => {
  beforeEach(stubInboxEnv);
  afterEach(restoreInboxEnv);

  it("first scan: every demo mail does exactly what the table says, and nothing else changes", async () => {
    const { userId } = await demoUser();
    const before = await listAllJobs(getDb(), userId);

    const result = await sync(userId, folderSource());

    expect(result).toMatchObject({ mode: "full_scan", scanned: LISTED, ignored: 3, skipped: 0, retry: 0, failed: 0, complete: true });
    expect(result.stored).toHaveLength(STORED);
    expect(await outcomes(userId, "not listed")).toEqual(DEMO_MAIL);
    const emails = await listEmails(getDb(), userId);
    expect(jobChanges(before, await listAllJobs(getDb(), userId), emails)).toEqual(JOB_CHANGES);
    // What the run answered is what was stored.
    for (const email of result.stored) expect(emails.find((e) => e.id === email.id)).toEqual(email);
    // The review list: what each waiting email suggests.
    const kelpie = before.find((j) => j.company === "Kelpie Analytics")!;
    const review = result.stored.filter((e) => e.outcome === "review");
    expect(review.map((e) => [e.fromAddress, e.reviewReason, e.suggestedJobIds[0] ?? null, e.suggestedStatus]).sort()).toEqual([
      ["ines.moreau@kelpie-analytics.example", "status_mismatch", kelpie.id, "interview"],
      ["no-reply@quillmark.teamtailor-mail.example", "unknown_job", null, "interview"],
    ]);
  });

  it("incremental sync: the same, and the sent reply is skipped by its label", async () => {
    const { userId } = await demoUser();
    const before = await listAllJobs(getDb(), userId);
    // An empty mailbox first: the position is the source's base, so everything after is "added".
    expect(await sync(userId, messageSource([]))).toMatchObject({ mode: "full_scan", scanned: 0, complete: true });

    const result = await sync(userId, folderSource());

    expect(result).toMatchObject({ mode: "incremental", scanned: LISTED + 1, ignored: 3, skipped: 1, complete: true });
    expect(await outcomes(userId, "skipped")).toEqual(DEMO_MAIL);
    expect((await ledger(userId)).get("19a6d2c4e8f1a008")?.result).toBe("skipped");
    expect(jobChanges(before, await listAllJobs(getDb(), userId), await listEmails(getDb(), userId))).toEqual(JOB_CHANGES);
  });

  it("stores what the pipeline needs later, and nothing of ignored mail", async () => {
    const { userId } = await demoUser();
    await sync(userId, folderSource());
    const files = await fixtureFiles();
    const rows = await testSql()<
      Array<{ gmail_message_id: string; gmail_thread_id: string; body_truncated: boolean; from_address: string; received_at: Date; body: string }>
    >`SELECT gmail_message_id, gmail_thread_id, body_truncated, from_address, received_at, body FROM emails
      WHERE user_id = ${userId} AND gmail_message_id IS NOT NULL`;
    expect(rows).toHaveLength(STORED);
    const seen = await ledger(userId);
    for (const row of rows) {
      const { message } = files.find((f) => f.id === row.gmail_message_id)!;
      expect(row.gmail_thread_id).toBe(message.threadId);
      expect(row.body_truncated).toBe(false);
      expect(row.body.length).toBeGreaterThan(0);
      // Gmail's received time (moved by the fixture source), as on the ledger row.
      expect(row.received_at).toEqual(seen.get(row.gmail_message_id)!.internal_date);
      expect(NOW.getTime() - row.received_at.getTime()).toBeLessThan(5 * DAY);
    }
    // Ignored mail: the ledger row and nothing else, anywhere.
    const ignored = files.filter((f) => seen.get(f.id)?.result === "ignored");
    expect(ignored.map((f) => f.file)).toEqual([
      "jobradar-alert.json",
      "newsletter-interview-tips.json",
      "personal-dinner-outlook-quote.json",
    ]);
    const subjects = ignored.map((f) => f.message.payload!.headers!.find((h) => h.name === "Subject")!.value);
    const [{ count }] = await testSql()<{ count: number }[]>`
      SELECT count(*)::int AS count FROM emails
      WHERE gmail_message_id = ANY(${ignored.map((f) => f.id)}::text[]) OR subject = ANY(${subjects}::text[])`;
    expect(count).toBe(0);
    const columns = await testSql()<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'inbox_seen_messages' ORDER BY column_name`;
    expect(columns.map((c) => c.column_name)).toEqual([
      "attempts",
      "created_at",
      "gmail_message_id",
      "internal_date",
      "result",
      "seen_at",
      "user_id",
    ]);
  });

  it("stores a long body cut at 20,000 characters and says so", async () => {
    const userId = await createUser({ rules: true });
    await ensureDemoConnection(getDb(), userId);
    await acmeJob(userId);
    const long = gmailMessage({
      from: "Jane Hart <jane@acmerobotics.example>",
      subject: "Interview for Platform Engineer",
      body: `We would like to invite you to an interview.\n\n${"About the team. ".repeat(2_000)}`,
      at: new Date(NOW.getTime() - DAY),
    });
    const short = gmailMessage({
      from: "Jane Hart <jane@acmerobotics.example>",
      subject: "Directions",
      body: "We would like to invite you to an interview. The office is on the second floor.",
      at: new Date(NOW.getTime() - DAY / 2),
    });
    await sync(userId, messageSource([long, short]));
    const rows = await testSql()<Array<{ gmail_message_id: string; body_truncated: boolean; length: number }>>`
      SELECT gmail_message_id, body_truncated, char_length(body) AS length FROM emails WHERE user_id = ${userId}`;
    const byId = new Map(rows.map((r) => [r.gmail_message_id, r]));
    expect(byId.get(long.id)).toMatchObject({ body_truncated: true, length: 20_000 });
    expect(byId.get(short.id)).toMatchObject({ body_truncated: false });
  });

  it("a second run stores nothing new and changes no job", async () => {
    const { userId } = await demoUser();
    await sync(userId, folderSource());
    const after = await snapshot(userId);

    const second = await sync(userId, folderSource());
    expect(second).toMatchObject({ mode: "incremental", scanned: 0, stored: [], complete: true });
    expect(await snapshot(userId)).toEqual(after);

    // Listing everything again (a resumed or repeated scan) finds it all in the ledger.
    await testSql()`UPDATE inbox_connections SET backfill_state = 'running' WHERE user_id = ${userId}`;
    const rescan = await sync(userId, folderSource());
    expect(rescan).toMatchObject({ mode: "full_scan", scanned: 0, stored: [], complete: true });
    expect(await snapshot(userId)).toEqual(after);
  });

  it("two runs started at the same time do not double-insert: the lease lets one run", async () => {
    const { userId } = await demoUser();
    const [a, b] = await Promise.all([sync(userId, folderSource()), sync(userId, folderSource())]);

    // The other found the lease held (as a second process would): it did nothing.
    expect([a, b].map((r) => r.busy).sort()).toEqual([false, true]);
    expect([a, b].find((r) => r.busy)).toMatchObject({ scanned: 0, stored: [], complete: false });
    expect(a.stored.length + b.stored.length).toBe(STORED);
    const emails = await testSql()<{ gmail_message_id: string }[]>`
      SELECT gmail_message_id FROM emails WHERE user_id = ${userId} AND gmail_message_id IS NOT NULL`;
    expect(new Set(emails.map((e) => e.gmail_message_id)).size).toBe(STORED);
    expect(emails).toHaveLength(STORED);
    expect(await listAllJobs(getDb(), userId)).toHaveLength(SEEDED_JOBS + 1);
    expect((await ledger(userId)).size).toBe(LISTED);
    expect(await outcomes(userId, "not listed")).toEqual(DEMO_MAIL);
  });

  it("a second Check inbox joins the run in progress", async () => {
    const { userId } = await demoUser();
    const first = runInboxCheck(userId, { source: folderSource(), now: () => NOW });
    const second = runInboxCheck(userId, { source: folderSource(), now: () => NOW });
    expect(second).toBe(first);
    expect(isSyncing(userId)).toBe(true);
    expect((await first).stored).toHaveLength(STORED);
    expect(isSyncing(userId)).toBe(false);
    // A later check is a new run.
    expect(await runInboxCheck(userId, { source: folderSource(), now: () => NOW })).toMatchObject({ scanned: 0 });
  });

  it("the first mail about an unknown application is a rejection: the job starts as Rejected", async () => {
    const userId = await createUser({ rules: true });
    await ensureDemoConnection(getDb(), userId);
    const at = new Date(NOW.getTime() - 2 * DAY);
    const rejection = gmailMessage({
      from: "Norvik <karriere@norvik.example>",
      subject: "Norvik | Deine Bewerbung",
      body: "Deine Bewerbung für die Stelle Frontend Developer (w/m/d): wir müssen Dir leider mitteilen, dass wir uns für andere Kandidaten entschieden haben.",
      at,
    });

    await sync(userId, messageSource([rejection]));

    const [job] = await listAllJobs(getDb(), userId);
    expect(job).toMatchObject({ company: "Norvik", title: "Frontend Developer", status: "rejected", statusSource: "email", emailCount: 1 });
    // The history of an application: applied, then rejected, both at the mail's time.
    expect(job.history.map((h) => [h.from, h.to, h.source, h.at])).toEqual([
      [null, "applied", "email", at.toISOString()],
      ["applied", "rejected", "email", at.toISOString()],
    ]);
    const [email] = await listEmails(getDb(), userId);
    expect(email).toMatchObject({ outcome: "created", jobId: job.id, detectedStatus: "rejected", statusChange: { from: "applied", to: "rejected" } });
    // Whether the mail had bulk-mail headers is stored with it, for the review re-check.
    expect([...(await testSql()`SELECT bulk FROM emails WHERE user_id = ${userId}`)]).toEqual([{ bulk: false }]);
    // The same message again changes nothing.
    await sync(userId, messageSource([rejection]));
    expect((await listAllJobs(getDb(), userId))[0].history).toHaveLength(2);
  });

  it("a reply in a thread linked to a job goes to that job, and only then", async () => {
    const userId = await createUser({ rules: true });
    await ensureDemoConnection(getDb(), userId);
    const job = await acmeJob(userId);
    const linked = await makeEmail(userId, { jobId: job.id, outcome: "matched", reviewReason: null, receivedAt: new Date(NOW.getTime() - 3 * DAY) });
    await testSql()`UPDATE emails SET gmail_thread_id = 'thread-acme' WHERE id = ${linked}`;
    // A coordinator at another domain, no company, no keyword: unrelated on its own. Two
    // senders, so the first reply's link does not count as sender history for the second.
    const reply = (threadId: string, from: string) =>
      gmailMessage({
        threadId,
        from,
        subject: "Re: next steps",
        body: "Does Tuesday at 10:00 work for you?",
        at: new Date(NOW.getTime() - DAY),
      });
    const inThread = reply("thread-acme", "Robin Coordinator <robin@calendar-desk.example>");
    const elsewhere = reply("thread-other", "Kim Coordinator <kim@calendar-desk.example>");

    await sync(userId, messageSource([inThread, elsewhere]));

    const seen = await ledger(userId);
    expect(seen.get(elsewhere.id)?.result).toBe("ignored");
    expect(seen.get(inThread.id)?.result).toBe("stored");
    const [email] = await listEmails(getDb(), userId, { jobId: job.id }).then((list) => list.filter((e) => e.id !== linked));
    expect(email).toMatchObject({ outcome: "matched", jobId: job.id, statusChange: { from: "applied", to: "applied" } });
  });

  it("mail from an address linked to a job before goes to that job; another address queues for review", async () => {
    const userId = await createUser({ rules: true });
    await ensureDemoConnection(getDb(), userId);
    const job = await acmeJob(userId);
    // An agency recruiter: their domain is not the company's.
    await makeEmail(userId, {
      jobId: job.id,
      outcome: "matched",
      reviewReason: null,
      fromAddress: "mia@talentbridge.example",
      receivedAt: new Date(NOW.getTime() - 5 * DAY),
    });
    const invite = (from: string) =>
      gmailMessage({
        from,
        subject: "Next round",
        body: "We would like to invite you to an interview for the role.",
        at: new Date(NOW.getTime() - DAY),
      });
    const known = invite("Mia Berg <mia@talentbridge.example>");
    const unknown = invite("Noah Stone <noah@talentbridge.example>");

    await sync(userId, messageSource([known, unknown]));

    const emails = await listEmails(getDb(), userId);
    const byAddress = (a: string) => emails.find((e) => e.fromAddress === a && e.subject === "Next round");
    expect(byAddress("mia@talentbridge.example")).toMatchObject({
      outcome: "matched",
      jobId: job.id,
      statusChange: { from: "applied", to: "interview" },
    });
    expect(byAddress("noah@talentbridge.example")).toMatchObject({
      outcome: "review",
      reviewReason: "unknown_job",
      jobId: null,
      suggestedStatus: "interview",
    });
    expect((await listAllJobs(getDb(), userId)).map((j) => j.status)).toEqual(["interview"]);
  });

  it("a job whose status was set by hand gets the mail linked and keeps its status", async () => {
    const userId = await createUser({ rules: true });
    await ensureDemoConnection(getDb(), userId);
    const job = await acmeJob(userId);
    await testSql()`UPDATE jobs SET status_locked = true WHERE id = ${job.id}`;
    const message = gmailMessage({
      from: "Jane Hart <jane@acmerobotics.example>",
      subject: "Interview for Platform Engineer",
      body: "We would like to invite you to an interview.",
      at: new Date(NOW.getTime() - DAY),
    });
    await sync(userId, messageSource([message]));
    const [email] = await listEmails(getDb(), userId);
    expect(email).toMatchObject({ outcome: "matched", jobId: job.id, statusChange: { from: "applied", to: "applied" } });
    const [after] = await listAllJobs(getDb(), userId);
    // Linked, so its last activity is the mail's; no history event.
    expect(after).toMatchObject({ status: "applied", statusLocked: true, emailCount: 1, lastActivityAt: email.receivedAt });
    expect(after.history.map((e) => [e.from, e.to])).toEqual([[null, "applied"]]);
  });

  it("mail that does not fit a closed job's status queues for review with that job first", async () => {
    const userId = await createUser({ rules: true });
    await ensureDemoConnection(getDb(), userId);
    const job = await acmeJob(userId);
    await testSql()`UPDATE jobs SET status = 'rejected' WHERE id = ${job.id}`;
    const message = gmailMessage({
      from: "Jane Hart <jane@acmerobotics.example>",
      subject: "Interview for Platform Engineer",
      body: "We would like to invite you to an interview.",
      at: new Date(NOW.getTime() - DAY),
    });
    await sync(userId, messageSource([message]));
    const [email] = await listEmails(getDb(), userId);
    expect(email).toMatchObject({
      outcome: "review",
      reviewReason: "status_mismatch",
      jobId: null,
      suggestedJobIds: [job.id],
      suggestedStatus: "interview",
    });
    expect((await listAllJobs(getDb(), userId))[0].status).toBe("rejected");
  });

  it("two ingests of the same message at once (two runs, no lease between them) store it once", async () => {
    const userId = await createUser({ rules: true });
    await ensureDemoConnection(getDb(), userId);
    const job = await acmeJob(userId);
    const invite = gmailMessage({
      from: "Jane Hart <jane@acmerobotics.example>",
      subject: "Interview for Platform Engineer",
      body: "We would like to invite you to an interview.",
      at: new Date(NOW.getTime() - DAY),
    });
    const parsed = await parseGmailMessage(invite);
    const ctx = { ownAddress: "owner@example.com", now: NOW };
    // Storing takes a while, so the second claim arrives while the first transaction is open.
    await testSql().unsafe(`
      CREATE OR REPLACE FUNCTION slow_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$;
      CREATE TRIGGER slow_insert BEFORE INSERT ON emails FOR EACH ROW EXECUTE FUNCTION slow_insert();`);
    try {
      const outcomes = await Promise.all([
        ingestParsed(userId, invite.id, parsed, ctx),
        ingestParsed(userId, invite.id, parsed, ctx),
      ]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(["already_done", "stored"]);
    } finally {
      await testSql().unsafe(`DROP TRIGGER IF EXISTS slow_insert ON emails`);
    }
    expect((await ledger(userId)).get(invite.id)).toMatchObject({ result: "stored", attempts: 0 });
    const [stored] = await listAllJobs(getDb(), userId);
    expect(stored).toMatchObject({ id: job.id, status: "interview", emailCount: 1 });
    expect(stored.history.map((e) => e.to)).toEqual(["applied", "interview"]);
  });

  it("skips mail labelled sent, draft, spam, trash or chat, mail from the own address, and mail that is gone", async () => {
    const { userId, address } = await demoUser();
    const at = new Date(NOW.getTime() - DAY);
    const job = (labels: string[], from = "Jane Hart <jane@emberfinance.co.example>") =>
      gmailMessage({ from, subject: "Interview invitation", body: "We would like to invite you to an interview.", at, labels });
    const messages = [
      ...["SENT", "DRAFT", "SPAM", "TRASH", "CHAT"].map((l) => job([l])),
      job(["INBOX"], `Me <${address.toUpperCase()}>`),
    ];
    const source = messageSource(messages);
    // Listed by the incremental sync (which reports everything), plus one id that is gone.
    expect(await sync(userId, messageSource([]))).toMatchObject({ complete: true });
    const before = await snapshot(userId);
    const withGone = { ...source, listAddedSince: async (start: string) => {
      const added = await source.listAddedSince(start);
      return { ...added, messageIds: [...added.messageIds, "1a0000000000dead"] };
    } };

    const result = await sync(userId, withGone);

    expect(result).toMatchObject({ scanned: 7, skipped: 7, stored: [], complete: true });
    const seen = await ledger(userId);
    for (const id of [...messages.map((m) => m.id), "1a0000000000dead"]) expect(seen.get(id)?.result).toBe("skipped");
    const after = await snapshot(userId);
    expect({ ...after, ledger: [] }).toEqual({ ...before, ledger: [] });
  });
});
