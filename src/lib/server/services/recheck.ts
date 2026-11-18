import "server-only";
import { DEFAULT_USER_SETTINGS } from "@/lib/domain/defaults";
import { classifyMail } from "@/lib/inbox/pipeline/classify";
import { withTx } from "@/lib/server/db/client";
import { findSenderJobIds, findThreadJobId } from "@/lib/server/inbox/repo";
import { listReviewRowsForUpdate, setEmailClassification, setEmailOutcome } from "@/lib/server/repo/emails";
import { lockUserJobs } from "@/lib/server/repo/jobs";
import { findSettingsRow } from "@/lib/server/repo/settings";
import { createJobFromEmail, linkEmail, listAllJobs } from "@/lib/server/services/jobs";
import { listRules } from "@/lib/server/services/rules";
import type { ReviewRecheckResult } from "@/lib/types";

/**
 * Classifies the mail that waits for review again ("Check again" on the review list): after the
 * keyword rules changed, after a job was added by hand, or after a release that reads mail
 * better. One transaction; nothing is fetched from Gmail.
 *
 * The emails are taken oldest first, each against the jobs the ones before it left behind, as
 * the sync takes new mail: a confirmation creates its job, and the rejection that follows finds
 * it. Each one gets the pipeline's answer of now (src/lib/inbox/pipeline/classify.ts), written
 * as the sync writes it (sync/ingest.ts), at the email's own received time:
 *
 *   link     the email becomes "matched" and is linked; the job's status changes as the effect says
 *   create   the email becomes "created" and starts the job
 *   review   it stays in review, with the reason and suggestions of now
 *   ignore   it becomes "dismissed", as "Not job related" does: the text stays, under Activity
 *
 * What the pipeline is not asked about: mail in review as "Sent as a mass mailing". That reason
 * means bulk mail whose only tie to a job is its sender, which never changes a job by itself, and
 * for mail stored before emails.bulk existed nothing else records that it was bulk mail. Mail
 * with bulk = true is classified with the headers set; with NULL (unknown), as not bulk.
 *
 * Mail the owner resolved or dismissed, and mail the sync linked, is not touched.
 */
export async function recheckReview(userId: string, now: Date = new Date()): Promise<ReviewRecheckResult> {
  return withTx(async (tx) => {
    // The emails first, then the per-user jobs lock: the order resolveReview takes them in.
    const rows = await listReviewRowsForUpdate(tx, userId);
    await lockUserJobs(tx, userId);
    const [rules, settings] = await Promise.all([listRules(tx, userId), findSettingsRow(tx, userId)]);
    const result: ReviewRecheckResult = { checked: rows.length, linked: 0, created: 0, dismissed: 0, remaining: 0 };

    for (const row of rows) {
      if (row.review_reason === "bulk_mail") {
        result.remaining++;
        continue;
      }
      // Read for every email: the one before may have added a job or linked its thread.
      const [jobs, threadJobId, senderJobIds] = await Promise.all([
        listAllJobs(tx, userId),
        findThreadJobId(tx, userId, row.gmail_thread_id),
        findSenderJobIds(tx, userId, row.from_address),
      ]);
      const classified = classifyMail(
        {
          fromName: row.from_name,
          fromAddress: row.from_address,
          subject: row.subject,
          body: row.body,
          receivedAt: row.received_at,
          threadId: row.gmail_thread_id,
          bulk: row.bulk ? { listUnsubscribe: true, listId: null, precedence: null } : undefined,
        },
        {
          jobs,
          rules,
          createFromConfirmation: settings?.create_from_confirmation ?? DEFAULT_USER_SETTINGS.createFromConfirmation,
          languages: settings?.languages ?? DEFAULT_USER_SETTINGS.languages,
          threadJobId,
          senderJobIds,
          now,
        },
      );
      const { effect } = classified;

      if (effect.kind === "ignore") {
        await setEmailOutcome(tx, userId, row.id, { outcome: "dismissed" });
        result.dismissed++;
        continue;
      }
      await setEmailClassification(tx, userId, row.id, {
        language: classified.language ?? "",
        outcome: classified.outcome,
        detectedStatus: classified.status,
        matchedKeywords: classified.matchedKeywords.map((k) => k.phrase),
        reviewReason: classified.reviewReason,
        suggestedJobIds: effect.kind === "review" ? effect.suggestedJobIds : [],
        suggestedStatus: effect.kind === "review" ? effect.suggestedStatus : null,
        confidence: classified.confidence,
      });
      if (effect.kind === "review") {
        result.remaining++;
      } else if (effect.kind === "link") {
        await linkEmail(tx, userId, {
          emailId: row.id,
          jobId: effect.jobId,
          to: effect.to,
          source: "email",
          at: row.received_at,
        });
        result.linked++;
      } else {
        const created = await createJobFromEmail(tx, userId, {
          company: effect.company,
          title: effect.title,
          status: "applied",
          source: "email",
          emailId: row.id,
          at: row.received_at,
          note: effect.status === "applied" ? "Created from a confirmation email" : "Created from the first email about this application",
        });
        if (effect.status !== "applied") {
          await linkEmail(tx, userId, {
            emailId: row.id,
            jobId: created.job.id,
            to: effect.status,
            source: "email",
            at: row.received_at,
          });
        }
        result.created++;
      }
    }
    return result;
  });
}
