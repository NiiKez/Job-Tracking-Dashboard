import "server-only";
import { withTx } from "@/lib/server/db/client";
import { toEmail } from "@/lib/server/db/rows";
import { ConflictError, NotFoundError } from "@/lib/server/errors";
import { getEmailRow, setEmailOutcome } from "@/lib/server/repo/emails";
import { findJobRow, getJobRow } from "@/lib/server/repo/jobs";
import { createJobFromEmail, linkEmail, loadJob } from "@/lib/server/services/jobs";
import type { Email, Job, ReviewAction, Status } from "@/lib/types";

/**
 * Resolves an email from the Needs-review list, in one transaction that holds the email's row,
 * so two clicks cannot resolve it twice. The email must still be in review (else 409).
 *
 *   dismiss  outcome "dismissed"; no job
 *   confirm  the first suggested job that still exists, with the suggested status (or the job's)
 *   assign   the given job (must be the user's) and status
 *   create   a new job (or the one it duplicates) from company and title, as the mock did:
 *            created as "applied" with source "review", then moved to the chosen status
 *
 * Except for dismiss, the email ends "resolved" with detectedStatus = the status, linked to the
 * job with source "review", which applies the status even to a locked job.
 */
export async function resolveReview(
  userId: string,
  emailId: string,
  action: ReviewAction,
): Promise<{ email: Email; job: Job | null }> {
  return withTx(async (tx) => {
    const email = await getEmailRow(tx, userId, emailId, { forUpdate: true });
    if (email.outcome !== "review") throw new ConflictError("This email is no longer waiting for review");

    if (action.action === "dismiss") {
      const row = await setEmailOutcome(tx, userId, email.id, { outcome: "dismissed" });
      return { email: toEmail(row), job: null };
    }

    let jobId: string;
    let status: Status;
    if (action.action === "confirm") {
      // Ids of deleted jobs are already dropped from suggested_job_ids. Locked (email, then job,
      // as in linkEmail), so the job's own status below is not one a concurrent change replaces.
      const job = email.suggested_job_ids[0]
        ? await findJobRow(tx, userId, email.suggested_job_ids[0], { forUpdate: true })
        : null;
      if (!job) throw new NotFoundError("Nothing to confirm: no suggested job");
      jobId = job.id;
      status = email.suggested_status ?? job.status;
    } else if (action.action === "assign") {
      jobId = (await getJobRow(tx, userId, action.jobId)).id;
      status = action.status;
    } else {
      const { job } = await createJobFromEmail(tx, userId, {
        company: action.company,
        title: action.title,
        status: "applied",
        source: "review",
        description: `Created from an email: "${email.subject}"`,
      });
      jobId = job.id;
      status = action.status;
    }

    await setEmailOutcome(tx, userId, email.id, { outcome: "resolved", detectedStatus: status });
    const linked = await linkEmail(tx, userId, { emailId: email.id, jobId, to: status, source: "review" });
    return { email: linked.email, job: await loadJob(tx, userId, jobId) };
  });
}
