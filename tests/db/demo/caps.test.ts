import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RULES } from "@/lib/domain/defaults";
import { getDb, withTx } from "@/lib/server/db/client";
import { DEMO_CAPS } from "@/lib/server/demo/caps";
import { createWorkspace } from "@/lib/server/demo/workspaces";
import { resetEnvForTests } from "@/lib/server/env";
import { ConflictError } from "@/lib/server/errors";
import { sweepNoResponse } from "@/lib/server/inbox/sweep";
import { createJobFromEmail, updateJob, upsertJob } from "@/lib/server/services/jobs";
import { resolveReview } from "@/lib/server/services/review";
import { addRule, deleteRule, listRules, updateDefaultRules } from "@/lib/server/services/rules";
import type { JobInput } from "@/lib/types";
import { createUser, makeEmail, makeJob } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";
import { folderSource, NOW, sync } from "../inbox/support";
import { restoreDemoEnv, stubDemoMode } from "./support";

// The demo's per-workspace caps (src/lib/server/demo/caps.ts): each one answers ConflictError
// (route() makes it a 409) in demo mode on every write path, and changes nothing outside it.

const JOB: JobInput = {
  title: "Platform Engineer",
  company: "Quillbyte",
  location: "",
  url: null,
  description: "",
  status: "saved",
  captureMethod: "paste",
};

/** Jobs written directly, `count` of them, all "applied". */
async function fillJobs(userId: string, count: number): Promise<string[]> {
  const rows = await testSql()<{ id: string }[]>`
    INSERT INTO jobs (user_id, title, company, company_slug, title_norm, search_text, status, status_source, capture_method)
    SELECT ${userId}, 'Filler role ' || i, 'Filler Co ' || i, 'filler-co-' || i, 'filler role ' || i,
           'filler co filler role', 'applied', 'manual', 'paste'
    FROM generate_series(1, ${count}::int) AS i
    RETURNING id`;
  return rows.map((r) => r.id);
}

/** Status events on one job written directly, up to `total` for the user. */
async function fillEvents(userId: string, jobId: string, total: number): Promise<void> {
  const [{ n }] = await testSql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM job_status_events WHERE user_id = ${userId}`;
  await testSql()`
    INSERT INTO job_status_events (user_id, job_id, from_status, to_status, source)
    SELECT ${userId}, ${jobId}, 'saved', 'applied', 'manual' FROM generate_series(1, ${total - n}::int)`;
}

let fill = 0;

/** Keyword rules written directly, up to `total` for the user. */
async function fillRules(userId: string, total: number): Promise<void> {
  const [{ n }] = await testSql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM keyword_rules WHERE user_id = ${userId}`;
  // A new phrase on every call: a phrase the user has would collide.
  const phrase = `filler phrase ${++fill} `;
  await testSql()`
    INSERT INTO keyword_rules (user_id, status, phrase, phrase_norm, language)
    SELECT ${userId}, 'applied', ${phrase} || i, ${phrase} || i, 'en'
    FROM generate_series(1, ${total - n}::int) AS i`;
}

/** An http link of `chars` characters (code points); `fill` is the repeated tail. */
function link(chars: number, fill = "a"): string {
  const base = "https://example.com/";
  return base + fill.repeat(chars - base.length);
}

async function count(table: "jobs" | "job_status_events" | "keyword_rules", userId: string): Promise<number> {
  const [{ n }] = await testSql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${testSql()(table)} WHERE user_id = ${userId}`;
  return n;
}

const JOBS_MESSAGE = "The demo allows at most 60 jobs. Delete one or start over.";
const EVENTS_MESSAGE = "The demo allows at most 500 status changes. Delete a job or start over.";
const RULES_MESSAGE = "The demo allows at most 200 keyword rules. Delete one or start over.";
const DESCRIPTION_MESSAGE =
  "The demo allows at most 20,000 characters in a job description. Shorten it and try again.";
const URL_MESSAGE = "The demo allows links of at most 2,048 characters. Shorten it and try again.";

describeDb("the demo's per-workspace caps", () => {
  afterEach(() => restoreDemoEnv());

  it("are the plan's numbers", () => {
    expect(DEMO_CAPS).toEqual({
      jobs: 60,
      descriptionChars: 20_000,
      urlChars: 2_048,
      statusEvents: 500,
      keywordRules: 200,
    });
  });

  describe("in demo mode", () => {
    beforeEach(() => stubDemoMode(true));

    /* ------------------------------------------------------------- jobs */

    it("allows the 60th job, refuses the 61st from the add dialog and the extension", async () => {
      const user = await createUser();
      await fillJobs(user, DEMO_CAPS.jobs - 1);
      await upsertJob(user, JOB);
      expect(await count("jobs", user)).toBe(DEMO_CAPS.jobs);

      await expect(upsertJob(user, { ...JOB, title: "Another" })).rejects.toBeInstanceOf(ConflictError);
      await expect(upsertJob(user, { ...JOB, title: "Another" })).rejects.toThrow(JOBS_MESSAGE);
      await expect(upsertJob(user, { ...JOB, title: "Via extension", captureMethod: "extension" })).rejects.toThrow(
        JOBS_MESSAGE,
      );
      expect(await count("jobs", user)).toBe(DEMO_CAPS.jobs);
    });

    it("still merges a duplicate at the cap: no new job", async () => {
      const user = await createUser();
      await fillJobs(user, DEMO_CAPS.jobs - 1);
      await upsertJob(user, JOB);
      const { duplicate, job } = await upsertJob(user, { ...JOB, status: "applied", description: "Longer text" });
      expect(duplicate).toBe(true);
      expect(job).toMatchObject({ status: "applied", description: "Longer text" });
    });

    it("refuses a job found in mail or made from the review list at the cap", async () => {
      const user = await createUser();
      await fillJobs(user, DEMO_CAPS.jobs);
      await expect(
        withTx((tx) =>
          createJobFromEmail(tx, user, { company: "Mailfound", title: "Analyst", status: "applied", source: "email" }),
        ),
      ).rejects.toThrow(JOBS_MESSAGE);

      const emailId = await makeEmail(user, { reviewReason: "unknown_job" });
      await expect(
        resolveReview(user, emailId, { action: "create", status: "applied", company: "Reviewco", title: "Analyst" }),
      ).rejects.toThrow(JOBS_MESSAGE);
      // Rolled back: the email still waits for review.
      const [row] = await testSql()<{ outcome: string }[]>`SELECT outcome FROM emails WHERE id = ${emailId}`;
      expect(row.outcome).toBe("review");
      expect(await count("jobs", user)).toBe(DEMO_CAPS.jobs);
    });

    /* ------------------------------------------------------ description */

    it("takes a description of 20,000 characters, counted as the column counts them", async () => {
      const user = await createUser();
      await upsertJob(user, { ...JOB, description: "x".repeat(DEMO_CAPS.descriptionChars) });
      // 20,000 characters outside the BMP: 40,000 UTF-16 units, still 20,000 characters.
      await upsertJob(user, { ...JOB, title: "Emoji", description: "\u{1F680}".repeat(DEMO_CAPS.descriptionChars) });
    });

    it("refuses a longer description when adding, merging or editing a job", async () => {
      const user = await createUser();
      const long = "x".repeat(DEMO_CAPS.descriptionChars + 1);
      await expect(upsertJob(user, { ...JOB, description: long })).rejects.toThrow(DESCRIPTION_MESSAGE);
      expect(await count("jobs", user)).toBe(0);

      const job = await makeJob(user, { ...JOB, description: "short" });
      // A duplicate would keep the longer description.
      await expect(upsertJob(user, { ...JOB, description: long })).rejects.toThrow(DESCRIPTION_MESSAGE);
      await expect(updateJob(user, job.id, { description: long })).rejects.toThrow(DESCRIPTION_MESSAGE);
      const [row] = await testSql()<{ description: string }[]>`SELECT description FROM jobs WHERE id = ${job.id}`;
      expect(row.description).toBe("short");
      // Edits that leave the description alone are not checked.
      await updateJob(user, job.id, { title: "Renamed" });
    });

    /* ------------------------------------------------------------- link */

    it("takes a link of 2,048 characters, counted as code points, and no link at all", async () => {
      const user = await createUser();
      expect((await upsertJob(user, { ...JOB, url: link(DEMO_CAPS.urlChars) })).job.url).toHaveLength(
        DEMO_CAPS.urlChars,
      );
      // 2,048 characters, some outside the BMP: more UTF-16 units, still 2,048 characters.
      await upsertJob(user, { ...JOB, title: "Emoji", url: link(DEMO_CAPS.urlChars, "\u{1F680}") });
      const job = await makeJob(user, { ...JOB, title: "No link" });
      await updateJob(user, job.id, { url: "" });
      await updateJob(user, job.id, { url: null });
    });

    it("refuses a longer link when adding, merging or editing a job", async () => {
      const user = await createUser();
      const long = link(DEMO_CAPS.urlChars + 1);
      await expect(upsertJob(user, { ...JOB, url: long })).rejects.toBeInstanceOf(ConflictError);
      await expect(upsertJob(user, { ...JOB, url: long })).rejects.toThrow(URL_MESSAGE);
      await expect(upsertJob(user, { ...JOB, url: long, captureMethod: "extension" })).rejects.toThrow(URL_MESSAGE);
      expect(await count("jobs", user)).toBe(0);

      const job = await makeJob(user, { ...JOB, url: "https://example.com/short" });
      // A duplicate (same company and title) would take the new link.
      await expect(upsertJob(user, { ...JOB, url: long })).rejects.toThrow(URL_MESSAGE);
      await expect(updateJob(user, job.id, { url: long })).rejects.toThrow(URL_MESSAGE);
      const [row] = await testSql()<{ url: string }[]>`SELECT url FROM jobs WHERE id = ${job.id}`;
      expect(row.url).toBe("https://example.com/short");
      // Edits that leave the link alone are not checked.
      await updateJob(user, job.id, { title: "Renamed" });
    });

    /* --------------------------------------------------- status events */

    it("refuses a status change at 500 events, but not a change to the same status", async () => {
      const user = await createUser();
      const job = await makeJob(user, JOB);
      await fillEvents(user, job.id, DEMO_CAPS.statusEvents - 1);
      await updateJob(user, job.id, { status: "applied" });
      expect(await count("job_status_events", user)).toBe(DEMO_CAPS.statusEvents);

      await expect(updateJob(user, job.id, { status: "interview" })).rejects.toThrow(EVENTS_MESSAGE);
      expect((await updateJob(user, job.id, { status: "applied", title: "Same status" })).title).toBe("Same status");
      expect(await count("job_status_events", user)).toBe(DEMO_CAPS.statusEvents);
    });

    it("refuses a new job at 500 events: its first event is a status change too", async () => {
      const user = await createUser();
      const job = await makeJob(user, JOB);
      await fillEvents(user, job.id, DEMO_CAPS.statusEvents);
      await expect(upsertJob(user, { ...JOB, title: "Second" })).rejects.toThrow(EVENTS_MESSAGE);
    });

    it("refuses an email's or the review list's change at 500 events, and the sweep's", async () => {
      const user = await createUser();
      const job = await makeJob(user, { ...JOB, status: "applied" });
      await fillEvents(user, job.id, DEMO_CAPS.statusEvents);

      const emailId = await makeEmail(user, { suggestedJobIds: [job.id], suggestedStatus: "interview" });
      await expect(resolveReview(user, emailId, { action: "confirm" })).rejects.toThrow(EVENTS_MESSAGE);
      await expect(
        resolveReview(user, emailId, { action: "assign", jobId: job.id, status: "rejected" }),
      ).rejects.toThrow(EVENTS_MESSAGE);

      await testSql()`UPDATE jobs SET last_activity_at = now() - interval '90 days' WHERE id = ${job.id}`;
      await expect(sweepNoResponse(user)).rejects.toThrow(EVENTS_MESSAGE);
      expect(await count("job_status_events", user)).toBe(DEMO_CAPS.statusEvents);
    });

    /* --------------------------------------------------- keyword rules */

    it("allows the 200th rule, refuses the 201st, and still answers a rule that exists", async () => {
      const user = await createUser();
      await fillRules(user, DEMO_CAPS.keywordRules - 1);
      const last = await addRule(user, { status: "offer", phrase: "Welcome aboard", language: "en" });
      expect(await count("keyword_rules", user)).toBe(DEMO_CAPS.keywordRules);

      await expect(addRule(user, { status: "offer", phrase: "Glad to offer", language: "en" })).rejects.toThrow(
        RULES_MESSAGE,
      );
      // Rolled back, the language with it.
      await expect(addRule(user, { status: "offer", phrase: "Bem-vindo", language: "pt" })).rejects.toThrow(RULES_MESSAGE);
      const [settings] = await testSql()<{ languages: string[] }[]>`
        SELECT languages FROM user_settings WHERE user_id = ${user}`;
      expect(settings.languages).not.toContain("pt");
      expect(await count("keyword_rules", user)).toBe(DEMO_CAPS.keywordRules);

      expect(await addRule(user, { status: "offer", phrase: "welcome ABOARD", language: "en" })).toEqual(last);
      await deleteRule(user, last.id);
      await addRule(user, { status: "offer", phrase: "Glad to offer", language: "en" });
    });

    it("refuses Update defaults when it would end over 200 rules, and allows it when it adds nothing", async () => {
      const user = await createUser({ rules: true });
      await fillRules(user, DEMO_CAPS.keywordRules);
      // Nothing to add: allowed at the cap.
      expect(await updateDefaultRules(user)).toMatchObject({ added: 0, removed: 0 });

      const defaults = (await listRules(getDb(), user)).filter((r) => !r.phrase.startsWith("filler phrase"));
      await deleteRule(user, defaults[0].id);
      await deleteRule(user, defaults[1].id);
      await fillRules(user, DEMO_CAPS.keywordRules - 1);
      await expect(updateDefaultRules(user)).rejects.toThrow(RULES_MESSAGE);
      expect(await count("keyword_rules", user)).toBe(DEMO_CAPS.keywordRules - 1);
      expect(DEFAULT_RULES.length).toBeLessThan(DEMO_CAPS.keywordRules);
    });

    /* ------------------------------------------------ a whole workspace */

    it("leaves a new workspace's Sync now and sweep working, far below every cap", async () => {
      vi.stubEnv("INBOX_BACKFILL_DAYS", "30");
      resetEnvForTests();
      const workspace = await createWorkspace(getDb(), { now: NOW });
      if (!workspace.ok) throw new Error("expected a workspace");
      const user = workspace.userId;

      const result = await sync(user, folderSource());
      expect(result).toMatchObject({ complete: true, retry: 0, failed: 0 });
      expect(result.stored.length).toBeGreaterThan(0);
      await sweepNoResponse(user, { now: NOW });

      expect(await count("jobs", user)).toBeLessThan(DEMO_CAPS.jobs / 2);
      expect(await count("job_status_events", user)).toBeLessThan(DEMO_CAPS.statusEvents / 5);
      expect(await count("keyword_rules", user)).toBeLessThan(DEMO_CAPS.keywordRules / 2);
    });

    it("at the job cap, the sync leaves mail that would add a job to retry and stores the rest", async () => {
      vi.stubEnv("INBOX_BACKFILL_DAYS", "30");
      resetEnvForTests();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const workspace = await createWorkspace(getDb(), { now: NOW });
        if (!workspace.ok) throw new Error("expected a workspace");
        const user = workspace.userId;
        await fillJobs(user, DEMO_CAPS.jobs - (await count("jobs", user)));

        const result = await sync(user, folderSource());
        expect(result.retry).toBeGreaterThan(0);
        expect(result.stored.length).toBeGreaterThan(0);
        expect(await count("jobs", user)).toBe(DEMO_CAPS.jobs);
        expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("(ConflictError)");
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("outside demo mode", () => {
    beforeEach(() => stubDemoMode(false));

    it("let jobs, descriptions, links, status changes and rules past every cap", async () => {
      const user = await createUser({ rules: true });
      await fillJobs(user, DEMO_CAPS.jobs);
      const job = await makeJob(user, {
        ...JOB,
        url: link(DEMO_CAPS.urlChars + 1),
        description: "y".repeat(DEMO_CAPS.descriptionChars + 1),
      });
      await updateJob(user, job.id, {
        url: link(DEMO_CAPS.urlChars + 1, "b"),
        description: "z".repeat(DEMO_CAPS.descriptionChars + 1),
      });
      await withTx((tx) =>
        createJobFromEmail(tx, user, { company: "Mailfound", title: "Analyst", status: "applied", source: "email" }),
      );
      expect(await count("jobs", user)).toBe(DEMO_CAPS.jobs + 2);

      await fillEvents(user, job.id, DEMO_CAPS.statusEvents);
      await updateJob(user, job.id, { status: "interview" });
      expect(await count("job_status_events", user)).toBe(DEMO_CAPS.statusEvents + 1);

      await fillRules(user, DEMO_CAPS.keywordRules);
      await addRule(user, { status: "offer", phrase: "Welcome aboard", language: "en" });
      await deleteRule(user, (await listRules(getDb(), user))[0].id);
      expect((await updateDefaultRules(user)).added).toBe(1);
      expect(await count("keyword_rules", user)).toBe(DEMO_CAPS.keywordRules + 1);
    });
  });
});
