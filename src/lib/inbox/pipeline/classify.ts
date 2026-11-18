/*
 * The email pipeline: one pure function without I/O, shared by the inbox sync and the rule
 * tester (Settings -> Test an email, POST /api/classify). Client-safe.
 *
 *   classifyMail(mail, ctx): ClassifyResult
 *     keywords (here) -> related or not (relatedness.ts) -> match to a job (match.ts)
 *     -> decision and effect (decide.ts); the language comes from language.ts. Every job is a
 *     candidate, whatever its status. A locked job gets the email linked and keeps its status.
 *     A career portal's housekeeping (noise.ts: a verification code, "account created", a
 *     password link) is never news: when it points at exactly one job it is linked to it and
 *     the status stays, whatever its words say; otherwise it is ignored.
 *
 *   classifyEmail(input, jobs, rules, createFromConfirmation, { languages?, now? })
 *     The rule tester: received now, no thread, no sender history. languages defaults to a new
 *     user's (en, de).
 *
 *   findKeywords(text, rules): the keyword rules whose phrase occurs in the text, as a substring
 *     after normalize() (the highlighting and the rule tester show exactly that).
 *
 * The result maps onto area 1's write path (src/lib/server/services/jobs.ts, emails.ts), in the
 * message's transaction:
 *
 *   effect "ignore"  Nothing but the ledger row (result "ignored"). Nothing readable is kept.
 *
 *   any other effect First insertEmail(tx, userId, {
 *                      fromName, fromAddress, subject, body,      (the stored, cut body)
 *                      receivedAt: mail.receivedAt,
 *                      language: result.language ?? "",
 *                      outcome: result.outcome,                   ("matched" | "created" | "review")
 *                      detectedStatus: result.status,
 *                      matchedKeywords: result.matchedKeywords.map((k) => k.phrase),
 *                      reviewReason: result.reviewReason,          (null unless "review")
 *                      suggestedJobIds: effect.kind === "review" ? effect.suggestedJobIds : [],
 *                      suggestedStatus: effect.kind === "review" ? effect.suggestedStatus : null,
 *                      confidence: result.confidence })
 *                    then:
 *   effect "link"    linkEmail(tx, userId, { emailId, jobId: effect.jobId, to: effect.to,
 *                      source: "email", at: mail.receivedAt })
 *                    from === to means "link only, keep the status": no history event, and the
 *                    job's last activity moves (never backwards).
 *   effect "create"  createJobFromEmail(tx, userId, { company: effect.company, title: effect.title,
 *                      status: "applied", source: "email", emailId, at: mail.receivedAt,
 *                      note: "Created from a confirmation email" })
 *                    Company and title are non-empty and fit the columns (200 characters);
 *                    the company comes from the sender's domain, or, for mail through a
 *                    recruiting platform, from the display name when the text names it too.
 *                    effect.status is "applied" for a confirmation. For the first mail about
 *                    an application the tracker does not know (a rejection, an invitation) it
 *                    is that later stage: the job is created as "applied" at the mail's time
 *                    and moved there by linkEmail(..., to: effect.status) in the same
 *                    transaction, so its history reads applied -> rejected.
 *   effect "review"  Nothing more: the email waits in the review list. suggestedJobIds are best
 *                    first (at most 3); "status_mismatch" and "bulk_mail" put the matched job
 *                    first.
 *
 * confidence is derived from the outcome, as the mock did: matched 0.92, created 0.85,
 * review 0.5 (ignored 0.85, never stored).
 */
import { DEFAULT_USER_SETTINGS } from "@/lib/domain/defaults";
import { normalize } from "@/lib/domain/normalize";
import type { ClassifyInput, ClassifyResult, Job, KeywordHit, KeywordRule } from "@/lib/types";
import { decideEffect, decideStatus } from "./decide";
import { detectLanguage } from "./language";
import { pickJob, scoreJobs } from "./match";
import { relatedness } from "./relatedness";
import type { MailInput, PipelineContext } from "./types";

/** The longest body the rules read: the stored body is cut at the same length. */
export const CLASSIFY_BODY_CHARS = 20_000;
/** Generous caps for the other fields, so odd mail cannot make the rules slow. */
const SUBJECT_CHARS = 2_000;
const NAME_CHARS = 500;
const ADDRESS_CHARS = 500;

const CONFIDENCE: Record<ClassifyResult["outcome"], number> = {
  matched: 0.92,
  created: 0.85,
  review: 0.5,
  ignored: 0.85,
};

/** See the contract at the top of this file. */
export function findKeywords(text: string, rules: readonly KeywordRule[]): KeywordHit[] {
  const haystack = normalize(text);
  const hits: KeywordHit[] = [];
  for (const rule of rules) {
    const needle = normalize(rule.phrase);
    if (needle && haystack.includes(needle)) {
      hits.push({ phrase: rule.phrase, status: rule.status, language: rule.language });
    }
  }
  return hits;
}

/** See the contract at the top of this file. */
export function classifyMail(input: MailInput, ctx: PipelineContext): ClassifyResult {
  const mail = {
    fromName: (input.fromName ?? "").slice(0, NAME_CHARS),
    fromAddress: (input.fromAddress ?? "").slice(0, ADDRESS_CHARS),
    replyToAddress: (input.replyToAddress ?? "").slice(0, ADDRESS_CHARS),
    subject: (input.subject ?? "").slice(0, SUBJECT_CHARS),
    body: (input.body ?? "").slice(0, CLASSIFY_BODY_CHARS),
    bulk: input.bulk,
  };
  // A received time Google cannot have meant (invalid, or after now) counts as now.
  const now = ctx.now.getTime();
  const received = input.receivedAt.getTime();
  const receivedAt = Number.isNaN(received) ? now : Math.min(received, now);

  const text = `${mail.subject}\n${mail.body}`;
  const hits = findKeywords(text, ctx.rules);
  const language = detectLanguage({
    hits,
    contentLanguage: input.contentLanguage,
    text,
    languages: ctx.languages,
  });
  const scores = scoreJobs(mail, ctx);
  const { related, evidence, bulkSender, noise } = relatedness(mail, hits, scores);

  // A portal's housekeeping: linked to the one job it points at, status kept; else ignored.
  const portalJob = related && noise === "portal" ? pickJob(scores) : null;
  if (portalJob?.kind === "one") {
    const { job } = portalJob;
    return {
      related,
      status: null,
      matchedKeywords: hits,
      language,
      outcome: "matched",
      reviewReason: null,
      candidates: scores.map((s) => s.job),
      evidence,
      confidence: CONFIDENCE.matched,
      effect: { kind: "link", jobId: job.id, from: job.status, to: job.status },
    };
  }

  if (!related || noise === "portal") {
    return {
      related: false,
      status: null,
      matchedKeywords: hits,
      language,
      outcome: "ignored",
      reviewReason: null,
      candidates: [],
      evidence,
      confidence: CONFIDENCE.ignored,
      effect: { kind: "ignore" },
    };
  }

  const keywords = decideStatus(hits, findKeywords(mail.subject, ctx.rules));
  const { outcome, effect } = decideEffect(mail, receivedAt, keywords, pickJob(scores), scores, ctx, bulkSender);
  return {
    related,
    status: keywords.status,
    matchedKeywords: hits,
    language,
    outcome,
    reviewReason: effect.kind === "review" ? effect.reason : null,
    candidates: scores.map((s) => s.job),
    evidence,
    confidence: CONFIDENCE[outcome],
    effect,
  };
}

/** The rule tester: see the contract at the top of this file. */
export function classifyEmail(
  input: ClassifyInput,
  jobs: readonly Job[],
  rules: readonly KeywordRule[],
  createFromConfirmation: boolean,
  options: { languages?: readonly string[]; now?: Date } = {},
): ClassifyResult {
  const now = options.now ?? new Date();
  return classifyMail(
    {
      fromName: input.fromName ?? "",
      fromAddress: input.fromAddress,
      subject: input.subject,
      body: input.body,
      receivedAt: now,
    },
    {
      jobs,
      rules,
      createFromConfirmation,
      languages: options.languages ?? DEFAULT_USER_SETTINGS.languages,
      threadJobId: null,
      senderJobIds: [],
      now,
    },
  );
}
