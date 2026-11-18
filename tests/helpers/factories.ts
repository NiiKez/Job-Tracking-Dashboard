// Test data for the database tests (inside a describeDb block only). Invented people and
// companies; addresses at example.com.
//
// Users are made with plain SQL, as the first sign-in would make them (a users row and its
// user_settings row), so these tests do not depend on the sign-in code.
import { DEFAULT_RULES } from "@/lib/domain/defaults";
import { normalize } from "@/lib/domain/normalize";
import { upsertJob } from "@/lib/server/services/jobs";
import type { EmailOutcome, Job, JobInput, ReviewReason, Status } from "@/lib/types";
import { testSql } from "./test-db";

let seq = 0;

/** A user with a settings row (defaults); `rules: true` also gives them the default keyword rules. */
export async function createUser(opts: { rules?: boolean } = {}): Promise<string> {
  const n = ++seq;
  const sql = testSql();
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (google_sub, email, name)
    VALUES (${`test-sub-${n}`}, ${`person${n}@example.com`}, ${`Test Person ${n}`})
    RETURNING id`;
  await sql`INSERT INTO user_settings (user_id) VALUES (${user.id})`;
  if (opts.rules) {
    for (const rule of DEFAULT_RULES) {
      await sql`
        INSERT INTO keyword_rules (user_id, status, phrase, phrase_norm, language)
        VALUES (${user.id}, ${rule.status}, ${rule.phrase}, ${normalize(rule.phrase)}, ${rule.language})`;
    }
  }
  return user.id;
}

/** A job added through upsertJob, like the paste dialog does. */
export async function makeJob(userId: string, input: Partial<JobInput> = {}): Promise<Job> {
  const { job } = await upsertJob(userId, {
    title: "Frontend Engineer",
    company: "Parcelwerk",
    location: "",
    url: null,
    description: "",
    status: "saved",
    captureMethod: "paste",
    ...input,
  });
  return job;
}

export interface EmailFields {
  jobId?: string | null;
  subject?: string;
  fromName?: string;
  fromAddress?: string;
  body?: string;
  receivedAt?: Date;
  outcome?: EmailOutcome;
  detectedStatus?: Status | null;
  reviewReason?: ReviewReason | null;
  suggestedJobIds?: string[];
  suggestedStatus?: Status | null;
}

/** An email row written directly (default: waiting in review). Returns its id. */
export async function makeEmail(userId: string, e: EmailFields = {}): Promise<string> {
  const [row] = await testSql()<{ id: string }[]>`
    INSERT INTO emails (user_id, job_id, from_name, from_address, subject, body, received_at, language,
                        outcome, detected_status, review_reason, suggested_job_ids, suggested_status, confidence)
    VALUES (${userId}, ${e.jobId ?? null}, ${e.fromName ?? "Talent Team"},
            ${e.fromAddress ?? "jobs@example.com"}, ${e.subject ?? "Your application"},
            ${e.body ?? "Thank you for applying."}, ${e.receivedAt ?? new Date()}, 'en',
            ${e.outcome ?? "review"}, ${e.detectedStatus ?? null},
            ${e.reviewReason === undefined ? "ambiguous_job" : e.reviewReason},
            ${e.suggestedJobIds ?? []}::uuid[], ${e.suggestedStatus ?? null}, 0.5)
    RETURNING id`;
  return row.id;
}

/** Moves a job's last activity into the past, so a later change is visible in the timestamps. */
export async function ageJob(jobId: string, days = 1): Promise<void> {
  await testSql()`
    UPDATE jobs SET last_activity_at = last_activity_at - make_interval(days => ${days}::int),
                    updated_at = updated_at - make_interval(days => ${days}::int)
    WHERE id = ${jobId}`;
}

export async function countRows(table: "jobs" | "emails" | "job_status_events" | "keyword_rules"): Promise<number> {
  const [row] = await testSql().unsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM ${table}`);
  return row.count;
}
