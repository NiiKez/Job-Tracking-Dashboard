import { describe, expect, it } from "vitest";
import { EXAMPLES } from "@/components/settings/sandbox-examples";
import { DEFAULT_RULES } from "@/lib/domain/defaults";
import { jobKeys } from "@/lib/domain/normalize";
import { classifyEmail } from "@/lib/inbox/pipeline/classify";
import { getDb, withTx, type Sql } from "@/lib/server/db/client";
import { classify } from "@/lib/server/services/classify";
import { listEmails } from "@/lib/server/services/emails";
import { listAllJobs } from "@/lib/server/services/jobs";
import { listRules } from "@/lib/server/services/rules";
import { getSettings, updateSettings } from "@/lib/server/services/settings";
import type { ClassifyResult, Email, Job } from "@/lib/types";
import { buildSeed, EMAILS } from "../../db/seed/fixtures";
import { loadIncoming } from "../helpers/demo-mail";
import { findSeedUser, isSeedableDatabase, runSeed, SeedError, seedUser } from "../../db/seed/seed";
import { createUser, makeJob } from "../helpers/factories";
import { describeDb, testSql } from "../helpers/test-db";

// npm run db:seed (scripts/seed-dev.ts) is runSeed() on a client for DATABASE_URL. These tests run
// it, and seedUser(), in the harness's throwaway schema.

const NOW = Date.UTC(2026, 0, 15, 12);
const JOB_COUNT = buildSeed(NOW).jobs.length;
const EMAIL_COUNT = buildSeed(NOW).emails.length;

describe("which databases the seed accepts", () => {
  it.each([
    ["job_tracker_dev", true],
    ["job_tracker_test", true],
    ["job_tracker", false],
    ["job_tracker_dev_old", false],
    ["job_tracker_development", false],
    ["job_tracker-dev", false],
    ["JOB_TRACKER_DEV", false],
  ])("%s: %s", (name, ok) => {
    expect(isSeedableDatabase(name)).toBe(ok);
  });

  it("refuses any other database before it reads or writes anything", async () => {
    const queries: string[] = [];
    // Answers only the name question; any further query would be recorded.
    const sql = ((strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      return Promise.resolve([{ database: "job_tracker" }]);
    }) as unknown as Sql;
    await expect(runSeed(sql)).rejects.toThrow(SeedError);
    await expect(runSeed(sql)).rejects.toThrow(/refusing to seed the database "job_tracker"/);
    expect(queries).toEqual([
      "SELECT current_database() AS database",
      "SELECT current_database() AS database",
    ]);
  });
});

/** A seeded job as the fixture describes it, the way the write path records it. */
function expectedJob(job: Job, jobIds: Map<string, string>, emailIds: Map<string, string>) {
  // The write path records no event for a change to the same status (the confirmation of a job
  // already "applied"): that email is linked, and the history skips it.
  const history = job.history.filter((e, i) => i === 0 || e.to !== job.history[i - 1].to);
  return {
    ...job,
    id: jobIds.get(job.id),
    statusSource: history.at(-1)!.source,
    history: history.map((e) => ({
      ...e,
      id: expect.any(String),
      ...(e.emailId ? { emailId: emailIds.get(e.emailId) } : {}),
    })),
  };
}

function expectedEmail(email: Email, jobIds: Map<string, string>, emailIds: Map<string, string>) {
  return {
    ...email,
    id: emailIds.get(email.id),
    jobId: email.jobId ? jobIds.get(email.jobId) : null,
    suggestedJobIds: email.suggestedJobIds.map((id) => jobIds.get(id)),
  };
}

/** Fixture id → database id, matched on what is unique in the fixtures. */
async function idMaps(userId: string) {
  const seed = buildSeed(NOW);
  const jobs = await listAllJobs(getDb(), userId);
  const emails = await listEmails(getDb(), userId);
  const jobIds = new Map(seed.jobs.map((j) => [j.id, jobs.find((d) => d.url === j.url && d.title === j.title)!.id]));
  const emailIds = new Map(
    seed.emails.map((e) => [e.id, emails.find((d) => d.subject === e.subject && d.receivedAt === e.receivedAt)!.id]),
  );
  return { seed, jobs, emails, jobIds, emailIds };
}

describeDb("db:seed", () => {
  it("writes the fixtures' jobs and emails, as the API returns them", async () => {
    const user = await createUser({ rules: true });
    expect(await withTx((tx) => seedUser(tx, user, NOW))).toEqual({ jobs: JOB_COUNT, emails: EMAIL_COUNT });

    const { seed, jobs, emails, jobIds, emailIds } = await idMaps(user);
    expect(new Set(jobIds.values()).size).toBe(seed.jobs.length);
    expect(new Set(emailIds.values()).size).toBe(seed.emails.length);

    const byId = new Map(jobs.map((j) => [j.id, j]));
    for (const job of seed.jobs) {
      expect(byId.get(jobIds.get(job.id)!), job.company).toEqual(expectedJob(job, jobIds, emailIds));
    }
    const emailById = new Map(emails.map((e) => [e.id, e]));
    for (const email of seed.emails) {
      expect(emailById.get(emailIds.get(email.id)!), email.subject).toEqual(expectedEmail(email, jobIds, emailIds));
    }
  });

  it("keeps the one same-status event of the fixtures as a linked email only", async () => {
    const user = await createUser();
    await withTx((tx) => seedUser(tx, user, NOW));
    const brightline = (await listAllJobs(getDb(), user)).find((j) => j.company === "Brightline Energy")!;
    expect(brightline.history.map((e) => [e.from, e.to, e.source])).toEqual([[null, "applied", "paste"]]);
    expect(brightline.statusSource).toBe("paste");
    expect(brightline.emailCount).toBe(1);
    const [mail] = await listEmails(getDb(), user, { jobId: brightline.id });
    expect(mail.statusChange).toEqual({ from: "applied", to: "applied" });
  });

  it("writes the derived key columns as the app does", async () => {
    const user = await createUser();
    await withTx((tx) => seedUser(tx, user, NOW));
    const rows = await testSql()<
      { url: string | null; company: string; title: string; url_norm: string | null; company_slug: string; title_norm: string; search_text: string }[]
    >`SELECT url, company, title, url_norm, company_slug, title_norm, search_text FROM jobs WHERE user_id = ${user}`;
    expect(rows).toHaveLength(JOB_COUNT);
    for (const row of rows) {
      expect({
        urlNorm: row.url_norm,
        companySlug: row.company_slug,
        titleNorm: row.title_norm,
        searchText: row.search_text,
      }).toEqual(jobKeys(row));
    }
  });

  it("dates everything relative to now", async () => {
    const user = await createUser();
    const now = Date.now();
    await withTx((tx) => seedUser(tx, user, now));
    const jobs = await listAllJobs(getDb(), user);
    const halcyon = jobs.find((j) => j.company === "Halcyon Robotics")!;
    // Applied 45 days ago (at 10:00 local time that day), an offer 3 days ago.
    const days = (iso: string) => (now - Date.parse(iso)) / 86_400_000;
    expect(days(halcyon.appliedAt!)).toBeGreaterThan(44);
    expect(days(halcyon.appliedAt!)).toBeLessThan(46);
    expect(days(halcyon.lastActivityAt)).toBeGreaterThan(2);
    expect(days(halcyon.lastActivityAt)).toBeLessThan(4);
    expect(halcyon.status).toBe("offer");
    expect(Date.parse(halcyon.offerDeadline!)).toBeGreaterThan(now);
  });

  it("replaces the user's jobs and emails, and leaves rules, settings and other users alone", async () => {
    const user = await createUser({ rules: true });
    const other = await createUser();
    const before = await makeJob(user, { title: "Old job", company: "Gone GmbH" });
    const othersJob = await makeJob(other, { title: "Kept", company: "Elsewhere" });
    await updateSettings(user, { noResponseDays: 45 });

    await withTx((tx) => seedUser(tx, user, NOW));
    await withTx((tx) => seedUser(tx, user, NOW));

    const jobs = await listAllJobs(getDb(), user);
    expect(jobs).toHaveLength(JOB_COUNT);
    expect(jobs.map((j) => j.id)).not.toContain(before.id);
    expect(await listEmails(getDb(), user)).toHaveLength(EMAIL_COUNT);
    const [{ events }] = await testSql()<{ events: number }[]>`
      SELECT count(*)::int AS events FROM job_status_events WHERE user_id = ${user}`;
    expect(events).toBe(jobs.reduce((n, j) => n + j.history.length, 0));

    expect((await listRules(getDb(), user)).map(({ status, phrase, language }) => ({ status, phrase, language }))).toEqual(
      DEFAULT_RULES,
    );
    expect((await getSettings(getDb(), user)).noResponseDays).toBe(45);
    expect((await listAllJobs(getDb(), other)).map((j) => j.id)).toEqual([othersJob.id]);
  });

  it("gives the rule tester the same jobs as the fixtures, in the order they were created", async () => {
    // tests/unit/classify.test.ts runs the classifier on buildSeed()'s jobs in fixture order. The
    // database hands them over oldest first (listAllJobs), which only changes how ties rank: the
    // ambiguous review email lists Juniper before Bramble here.
    const user = await createUser({ rules: true });
    await withTx((tx) => seedUser(tx, user, NOW));
    const jobs = [...buildSeed(NOW).jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const rules = DEFAULT_RULES.map((r, i) => ({ ...r, id: `rule_${i}` }));
    const name = (r: ClassifyResult, id: string) => {
      const job = r.candidates.find((j) => j.id === id);
      return job ? `${job.company} / ${job.title}` : id;
    };
    const summary = (r: ClassifyResult) => ({
      ...r,
      matchedKeywords: r.matchedKeywords.map((k) => k.phrase),
      candidates: r.candidates.map((j) => `${j.company} / ${j.title}`),
      // The effect names jobs by id, and the ids differ: compare them by name.
      effect:
        r.effect.kind === "link"
          ? { ...r.effect, jobId: name(r, r.effect.jobId) }
          : r.effect.kind === "review"
            ? { ...r.effect, suggestedJobIds: r.effect.suggestedJobIds.map((id) => name(r, id)) }
            : r.effect,
    });
    for (const input of [...EMAILS, ...(await loadIncoming()), ...EXAMPLES.map((e) => e.input)]) {
      expect(summary(await classify(getDb(), user, input)), input.subject).toEqual(
        summary(classifyEmail(input, jobs, rules, true)),
      );
    }
  });

  it("finds the named user in any case, or else the oldest one", async () => {
    expect(await findSeedUser(getDb())).toBeNull();
    const first = await createUser();
    const second = await createUser();
    const [{ email }] = await testSql()<{ email: string }[]>`SELECT email FROM users WHERE id = ${second}`;
    expect(await findSeedUser(getDb())).toEqual({ id: first, email: expect.any(String) });
    expect(await findSeedUser(getDb(), ` ${email.toUpperCase()} `)).toEqual({ id: second, email });
    expect(await findSeedUser(getDb(), "nobody@example.com")).toBeNull();
  });

  it("runSeed: seeds the first user of a _test database, or names what is missing", async () => {
    await expect(runSeed(testSql(), { now: NOW })).rejects.toThrow(/there is no user yet\. Sign in to the app once first/);

    const first = await createUser();
    const second = await createUser();
    const [{ email }] = await testSql()<{ email: string }[]>`SELECT email FROM users WHERE id = ${second}`;
    await expect(runSeed(testSql(), { email: "nobody@example.com" })).rejects.toThrow(
      /no user with the email nobody@example\.com\. Sign in once with that account first/,
    );

    const result = await runSeed(testSql(), { now: NOW });
    expect(result).toEqual({
      database: expect.stringMatching(/_test$/),
      user: { id: first, email: expect.any(String) },
      jobs: JOB_COUNT,
      emails: EMAIL_COUNT,
    });
    expect(await listAllJobs(getDb(), first)).toHaveLength(JOB_COUNT);
    expect(await listAllJobs(getDb(), second)).toHaveLength(0);

    expect((await runSeed(testSql(), { email })).user.id).toBe(second);
    expect(await listAllJobs(getDb(), second)).toHaveLength(JOB_COUNT);
  });
});
