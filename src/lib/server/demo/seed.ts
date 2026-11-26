import "server-only";
import { jobKeys } from "@/lib/domain/normalize";
import type { Tx } from "@/lib/server/db/client";
import { insertEvent } from "@/lib/server/repo/events";
import { fieldsOfRow, getJobRow, insertJobRow, updateJobFields } from "@/lib/server/repo/jobs";
import { insertEmail } from "@/lib/server/services/emails";
import { applyStatusChange, createJobFromEmail, linkEmail } from "@/lib/server/services/jobs";
import type { Email, Job, Status, StatusEvent } from "@/lib/types";
import { buildSeed } from "./fixtures";

/**
 * Writes the demo jobs and emails (fixtures.ts) into the database for one user. The public
 * demo's workspaces are filled with it, and `npm run db:seed` (db/seed/seed.ts, the development
 * command) runs it too. It lives in the app's source tree so the Next build compiles it: the
 * release has no tsx.
 *
 *   seedUser(tx, userId, now?)  replaces the user's jobs and emails with the fixtures, inside the
 *                               caller's transaction
 *
 * Everything is written through the write path the app uses (repo/jobs, repo/events and
 * services/jobs, services/emails), so the derived key columns, the status history and the email
 * links come out exactly as the app would make them. Only created_at and updated_at, which that
 * path stamps with now(), are set directly, so the demo jobs keep their dates in the past.
 *
 * What it writes: jobs (with their status events and priority) and emails (linked, in review, or ignored).
 * Not the users row, the settings row, keyword rules, an inbox connection or a session: the
 * caller makes those (repo/users insertDefaults, inbox/repo ensureDemoConnection,
 * auth/session createSession), in the same transaction if it wants all or nothing.
 */

/**
 * Replaces the user's jobs and emails with the fixtures, dated relative to `now`. Runs in the
 * caller's transaction (withTx or sql.begin) and never commits or rolls back itself, so it is
 * kept or undone together with whatever else that transaction writes. The user must exist; it
 * needs no settings row or rules. Keyword rules and settings stay as they are. For a new user
 * the two DELETEs find nothing.
 */
export async function seedUser(tx: Tx, userId: string, now = Date.now()): Promise<{ jobs: number; emails: number }> {
  const seed = buildSeed(now);
  await tx`DELETE FROM emails WHERE user_id = ${userId}`;
  // Their history goes with them (ON DELETE CASCADE).
  await tx`DELETE FROM jobs WHERE user_id = ${userId}`;

  const ids: Ids = { jobs: new Map(), emails: new Map() };
  // An email that suggests jobs is stored once those jobs exist. Every other email first, so the
  // jobs' history and links can point at it.
  const suggesting = seed.emails.filter((e) => e.suggestedJobIds.length > 0);
  for (const email of seed.emails) {
    if (!suggesting.includes(email)) await storeEmail(tx, userId, email, ids);
  }
  for (const job of seed.jobs) await storeJob(tx, userId, job, seed.emails, ids);
  for (const email of suggesting) await storeEmail(tx, userId, email, ids);
  return { jobs: seed.jobs.length, emails: seed.emails.length };
}

/** Fixture id → database id. */
interface Ids {
  jobs: Map<string, string>;
  emails: Map<string, string>;
}

function idOf(map: Map<string, string>, fixtureId: string): string {
  const id = map.get(fixtureId);
  if (!id) throw new Error(`seed: ${fixtureId} is not stored yet; check the order in fixtures.ts`);
  return id;
}

/** Stores the email unlinked, with what the pipeline decided; storeJob links it. */
async function storeEmail(tx: Tx, userId: string, email: Email, ids: Ids): Promise<void> {
  if (email.jobId && email.suggestedJobIds.length) {
    throw new Error(`seed: ${email.id} is linked and suggests jobs; the seed cannot order that`);
  }
  const stored = await insertEmail(tx, userId, {
    fromName: email.fromName,
    fromAddress: email.fromAddress,
    subject: email.subject,
    body: email.body,
    receivedAt: new Date(email.receivedAt),
    language: email.language,
    outcome: email.outcome,
    detectedStatus: email.detectedStatus,
    matchedKeywords: email.matchedKeywords,
    reviewReason: email.reviewReason,
    suggestedJobIds: email.suggestedJobIds.map((id) => idOf(ids.jobs, id)),
    suggestedStatus: email.suggestedStatus,
    confidence: email.confidence,
  });
  ids.emails.set(email.id, stored.id);
}

/** One step of a job's life, replayed in time order. */
type Step = { at: string; event: StatusEvent } | { at: string; email: Email };

/**
 * Creates the job with its first event, then replays the rest of its history and the emails
 * linked to it in time order, the way they would have arrived. A same-status event of the
 * fixture (a confirmation for a job already "applied") becomes what the app records for it: the
 * email linked, no history row.
 */
async function storeJob(tx: Tx, userId: string, job: Job, emails: Email[], ids: Ids): Promise<void> {
  const [first, ...rest] = job.history;
  const at = new Date(first.at);
  let jobId: string;
  if (first.emailId) {
    // Found in mail (e.g. a confirmation for a job not in the list yet).
    const result = await createJobFromEmail(tx, userId, {
      company: job.company,
      title: job.title,
      status: first.to,
      source: first.source,
      emailId: idOf(ids.emails, first.emailId),
      note: first.note,
      description: job.description,
      at,
    });
    if (!result.created) throw new Error(`seed: ${job.id} duplicates another fixture job`);
    jobId = result.job.id;
  } else {
    // What createJob in services/jobs.ts does: the row and the event that created it.
    const row = await insertJobRow(tx, userId, {
      title: job.title,
      company: job.company,
      location: job.location,
      url: job.url,
      description: job.description,
      keys: jobKeys(job),
      status: first.to,
      priority: job.priority,
      statusSource: first.source,
      captureMethod: job.captureMethod,
      at,
    });
    await insertEvent(tx, userId, {
      jobId: row.id,
      from: null,
      to: first.to,
      at,
      source: first.source,
      emailId: null,
      note: first.note ?? null,
    });
    jobId = row.id;
  }
  ids.jobs.set(job.id, jobId);

  const byEvent = new Set(job.history.map((e) => e.emailId).filter(Boolean));
  const steps: Step[] = [
    ...rest.map((event) => ({ at: event.at, event })),
    ...emails.filter((e) => e.jobId === job.id && !byEvent.has(e.id)).map((email) => ({ at: email.receivedAt, email })),
  ];
  // Stable: at the same time, the event comes first.
  steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const step of steps) {
    if ("event" in step) {
      const { event } = step;
      if (event.emailId) {
        await linkEmail(tx, userId, {
          emailId: idOf(ids.emails, event.emailId),
          jobId,
          to: event.to,
          source: event.source,
          at: new Date(event.at),
          note: event.note,
        });
      } else {
        await applyStatusChange(tx, userId, jobId, {
          to: event.to,
          source: event.source,
          at: new Date(event.at),
          note: event.note,
        });
      }
    } else {
      const { email } = step;
      const to: Status | undefined = email.statusChange?.to;
      if (!to) throw new Error(`seed: ${email.id} is linked without a status change`);
      await linkEmail(tx, userId, {
        emailId: idOf(ids.emails, email.id),
        jobId,
        to,
        source: email.outcome === "resolved" ? "review" : "email",
        at: new Date(email.receivedAt),
      });
    }
  }

  // The fields the history does not set. The lock comes last: set earlier, it would keep later
  // email events from applying.
  const row = await getJobRow(tx, userId, jobId, { forUpdate: true });
  const fields = {
    ...fieldsOfRow(row),
    location: job.location,
    url: job.url,
    description: job.description,
    // A job found in mail starts at the default; this sets the fixture's priority for it too.
    priority: job.priority,
    statusLocked: job.statusLocked,
    nextInterviewAt: job.nextInterview ? new Date(job.nextInterview.at) : null,
    nextInterviewRound: job.nextInterview ? job.nextInterview.round : null,
    offerDeadline: job.offerDeadline ? new Date(job.offerDeadline) : null,
  };
  await updateJobFields(tx, userId, jobId, { ...fields, keys: jobKeys(fields) });
  await tx`
    UPDATE jobs SET created_at = ${new Date(job.createdAt)}, updated_at = ${new Date(job.updatedAt)}
    WHERE user_id = ${userId} AND id = ${jobId}`;
}
