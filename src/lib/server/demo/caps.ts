import "server-only";
import type { Db } from "@/lib/server/db/client";
import { getEnv } from "@/lib/server/env";
import { ConflictError } from "@/lib/server/errors";

/**
 * The public demo's per-workspace caps (docs/plan/5-public-demo.md, "Limits"): a visitor is
 * anonymous, so what one workspace may hold is bounded, which bounds the demo's database. Only
 * in demo mode (getEnv().demoMode): outside it every check returns before any query, so the real
 * app runs exactly as before.
 *
 *   DEMO_CAPS                                    the numbers, in one place
 *   checkDemoDescription(description)            ConflictError when a job description is longer
 *                                                than the cap (characters as the column counts them)
 *   checkDemoCap(db, userId, kind, adding = 1)   ConflictError when the user's rows of `kind`
 *                                                ("jobs", "statusEvents", "keywordRules") plus
 *                                                `adding` would be more than the cap
 *
 * Where the services call them, so that every write path passes one:
 *
 *   jobs           services/jobs.ts createJob, which every new job goes through: added by hand,
 *                  from pasted text or a link, from the extension, found in mail by the sync or
 *                  by "Check again", or created from the review list
 *   description    createJob (a new job), upsertJob (a duplicate keeps the longer description, so
 *                  the input is checked) and updateJob (an edited description)
 *   status events  createJob (the event that creates the job) and applyStatusChange (every later
 *                  change: manual, email, review and the no-response sweep). A change to the
 *                  status the job already has records no event and is not checked.
 *   keyword rules  services/rules.ts addRule and updateDefaultRules, counted after the insert
 *                  (`adding` 0): a rule the user already has is no new rule, and "Update
 *                  defaults" adds an unknown number of them. The error rolls the insert back.
 *
 * Not checked: seedUser's direct repository writes and insertDefaults, a new workspace's fixed
 * data (23 jobs, 39 events, the default rules), far below the caps.
 *
 * The answer is a 409 whose message the app shows as it is. On the inbox sync's paths the error
 * fails that message's transaction instead: the sync records a failed attempt (retried, then
 * given up) and goes on with the next message, so mail that would add a job at the cap is not
 * stored. With 23 jobs seeded and 15 messages in fixtures/mail, "Sync now" on a new workspace
 * is far from every cap.
 *
 * Counted, not locked. The job count is exact: createJob always runs under the per-user jobs lock
 * (lockUserJobs). Status events and rules are counted without one, so concurrent requests of one
 * workspace can each pass at cap - 1 and end a few rows over: at most the pool's connections
 * (5) at once. That bounds the overshoot, which is all a cap against filling the disk needs.
 */

export const DEMO_CAPS = Object.freeze({
  /** Jobs per workspace. */
  jobs: 60,
  /** Characters (code points) per job description. */
  descriptionChars: 20_000,
  /** job_status_events rows per workspace. */
  statusEvents: 500,
  /** Keyword rules per workspace. */
  keywordRules: 200,
});

/** What checkDemoCap counts. */
export type DemoCountedKind = "jobs" | "statusEvents" | "keywordRules";

/** "20,000": the caps as people read them. */
function amount(n: number): string {
  return n.toLocaleString("en-US");
}

const CAP_MESSAGES: Record<DemoCountedKind, string> = {
  jobs: `The demo allows at most ${amount(DEMO_CAPS.jobs)} jobs. Delete one or start over.`,
  statusEvents: `The demo allows at most ${amount(DEMO_CAPS.statusEvents)} status changes. Delete a job or start over.`,
  keywordRules: `The demo allows at most ${amount(DEMO_CAPS.keywordRules)} keyword rules. Delete one or start over.`,
};

const DESCRIPTION_MESSAGE = `The demo allows at most ${amount(DEMO_CAPS.descriptionChars)} characters in a job description. Shorten it and try again.`;

/** The user's rows of one kind. Fixed SQL per kind: every table's indexes start with user_id. */
async function countRows(db: Db, userId: string, kind: DemoCountedKind): Promise<number> {
  const query =
    kind === "jobs"
      ? db<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE user_id = ${userId}`
      : kind === "statusEvents"
        ? db<{ n: number }[]>`SELECT count(*)::int AS n FROM job_status_events WHERE user_id = ${userId}`
        : db<{ n: number }[]>`SELECT count(*)::int AS n FROM keyword_rules WHERE user_id = ${userId}`;
  const [row] = await query;
  return row.n;
}

/**
 * In demo mode: ConflictError when the user's rows of `kind` plus `adding` are more than the cap.
 * `adding` 1 (the default) before inserting one row; 0 after inserting, in the same transaction,
 * which the error then rolls back. Outside demo mode: nothing, no query.
 */
export async function checkDemoCap(db: Db, userId: string, kind: DemoCountedKind, adding = 1): Promise<void> {
  if (!getEnv().demoMode) return;
  if ((await countRows(db, userId, kind)) + adding > DEMO_CAPS[kind]) throw new ConflictError(CAP_MESSAGES[kind]);
}

/**
 * In demo mode: ConflictError when the description has more than DEMO_CAPS.descriptionChars
 * characters, counted as code points like the column's check (char_length). Outside demo mode:
 * nothing.
 */
export function checkDemoDescription(description: string): void {
  if (!getEnv().demoMode) return;
  // UTF-16 units are never fewer than code points: only a long string needs counting.
  if (description.length <= DEMO_CAPS.descriptionChars) return;
  if (Array.from(description).length > DEMO_CAPS.descriptionChars) throw new ConflictError(DESCRIPTION_MESSAGE);
}
