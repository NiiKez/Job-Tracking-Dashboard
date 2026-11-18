/*
 * From keyword hits and the matched job to a decision: the status the keywords point to, then
 * what to do with the email (the effect; see the contract at the top of classify.ts).
 */
import { normalize, slug } from "@/lib/domain/normalize";
import type { ClassifyResult, Job, KeywordHit, KeywordRule, ReviewReason, Status } from "@/lib/types";
import {
  companyFromDomain,
  companyFromPlatformName,
  companyWords,
  fitField,
  guessTitle,
  guessTitleDetail,
  hasWords,
  platformOf,
  roleLike,
  wordsOf,
  wordText,
} from "./extract";
import type { JobMatch, JobScore } from "./match";
import { JOB_HINTS } from "./relatedness";
import type { ClassifyEffect, MailInput, PipelineContext } from "./types";

/* ------------------------------------------------------------------- status */

/** When stages conflict with as many phrases each, the earliest one is suggested. */
const STAGE_RANK: Record<Exclude<KeywordHit["status"], "applied">, number> = {
  interview: 1,
  rejected: 2,
  offer: 3,
};

export interface StatusDecision {
  /** The status the keywords point to; null when there is none. */
  status: KeywordHit["status"] | null;
  /** Why the keywords alone cannot decide; null when they can. */
  reason: Extract<ReviewReason, "no_keyword" | "conflicting_keywords"> | null;
}

/**
 * The status the keyword hits point to. A later stage (interview, offer, rejected) wins over an
 * "applied" phrase, and stages that disagree go to review, suggesting the one with the most
 * distinct phrases, and the earliest of those on a tie: a rejection that says "leider … absage"
 * and, politely, "kennenlernen" suggests "rejected". One exception: an "applied" phrase in the
 * subject with "interview" only in the body is a confirmation that mentions the next steps, so
 * it goes to review suggesting "applied".
 */
export function decideStatus(hits: readonly KeywordHit[], subjectHits: readonly KeywordHit[]): StatusDecision {
  const statuses = [...new Set(hits.map((h) => h.status))];
  const stages = statuses.filter((s): s is keyof typeof STAGE_RANK => s !== "applied");
  if (stages.length > 1) {
    const phrases = (stage: keyof typeof STAGE_RANK) =>
      new Set(hits.filter((h) => h.status === stage).map((h) => normalize(h.phrase))).size;
    const count = new Map(stages.map((s) => [s, phrases(s)]));
    const ranked = stages.sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0) || STAGE_RANK[a] - STAGE_RANK[b]);
    return { status: ranked[0], reason: "conflicting_keywords" };
  }
  if (stages.length === 1) {
    const subject = new Set(subjectHits.map((h) => h.status));
    if (stages[0] === "interview" && subject.has("applied") && !subject.has("interview")) {
      return { status: "applied", reason: "conflicting_keywords" };
    }
    return { status: stages[0], reason: null };
  }
  if (statuses.includes("applied")) return { status: "applied", reason: null };
  return { status: null, reason: "no_keyword" };
}

/* ------------------------------------------------------------------- effect */

const CLOSED: readonly Status[] = ["offer", "rejected"];

/** Time the job was last rejected, by its history; NaN when it never was. */
function rejectedAt(job: Job): number {
  const times = job.history
    .filter((event) => event.to === "rejected")
    .map((event) => Date.parse(event.at))
    .filter((at) => !Number.isNaN(at));
  return times.length ? Math.max(...times) : NaN;
}

/** Time of the job's latest change caused by an email (source "email"); NaN when none. */
function latestEmailChange(job: Job): number {
  const times = job.history
    .filter((event) => event.source === "email")
    .map((event) => Date.parse(event.at))
    .filter((at) => !Number.isNaN(at));
  return times.length ? Math.max(...times) : NaN;
}

export interface Decision {
  outcome: ClassifyResult["outcome"];
  effect: ClassifyEffect;
}

const review = (
  reason: ReviewReason,
  candidates: readonly JobScore[],
  suggestedStatus: Status | null,
): Decision => ({
  outcome: "review",
  effect: { kind: "review", reason, suggestedJobIds: candidates.slice(0, 3).map((c) => c.job.id), suggestedStatus },
});

const link = (job: Job, to: Status): Decision => ({
  outcome: "matched",
  effect: { kind: "link", jobId: job.id, from: job.status, to },
});

/** Words of a subject tail that make it a greeting or a status line, not a role ("Thank you"). */
const NOT_ROLE_WORDS = new Set([
  "thank",
  "thanks",
  "you",
  "danke",
  "dank",
  "vielen",
  "merci",
  "gracias",
  "bedankt",
  "next",
  "steps",
  "update",
  "status",
  "received",
  "confirmation",
  "your",
  "ihre",
  "deine",
  "dein",
]);

/**
 * The mail seems to name another role than the job's, so it may be about another application
 * at the same company. The job's title is not named in the mail, and guessTitle finds one that is
 * not the job's: neither a part of the job's title nor the other way round, compared without
 * spaces, punctuation and single letters ("Front-End Developer" is "Frontend Developer
 * (m/w/d)") and as sets of words ("Engineer, Frontend" is "Frontend Engineer"); not the
 * company's name; and no keyword, hint word or greeting (subject tails such as
 * "Eingangsbestätigung" or "Thank you" are not roles). A job whose own title is no role (the
 * company's name, or a status line an older version took from a subject:
 * "Eingangsbestätigung") cannot be compared. In doubt it is the same role.
 */
function namesOtherRole(
  mail: Pick<MailInput, "subject" | "body">,
  job: Job,
  score: JobScore | undefined,
  rules: readonly KeywordRule[],
): boolean {
  if (score?.titleNamed) return false;
  const guess = guessTitle(mail);
  const words = (s: string) => wordsOf(s).filter((w) => w.length > 1);
  const role = words(guess);
  if (role.length === 0 || role.every((w) => NOT_ROLE_WORDS.has(w))) return false;
  const title = words(job.title);
  if (!roleLike(job.title) || hasWords(wordText(job.title), companyWords(job.company))) return false;
  const roleKey = role.join("");
  const titleKey = title.join("");
  if (titleKey.includes(roleKey) || roleKey.includes(titleKey)) return false;
  if (role.every((w) => title.includes(w)) || title.every((w) => role.includes(w))) return false;
  // The company's name alone is no role; "ML Developer im Pallas Lab" is one.
  const company = companyWords(job.company);
  if (role.every((w) => company.includes(w))) return false;
  if (JOB_HINTS.some((hint) => role.includes(hint))) return false;
  const text = normalize(guess);
  return !rules.some((rule) => {
    const phrase = normalize(rule.phrase);
    return !!phrase && text.includes(phrase);
  });
}

/**
 * Words that say the mail is about an application that was made ("Ihre Bewerbung", "your
 * application", "beworben"), not about a job someone would like to talk about.
 */
const APPLICATION_WORDS = ["bewerbung", "bewerbungen", "bewerbungsunterlagen", "beworben", "application", "applied", "applying"];

/**
 * A job from an email, in `status`, or null: the company from the sender's domain
 * (companyFromDomain) or, for mail through a recruiting platform, from the sender's name when
 * the text names it too (companyFromPlatformName; any other name-based guess only prefills the
 * review form), and a guessed title, both non-empty. With `anchored`, only a title that stood
 * where roles stand (guessTitleDetail), not one read off the end of a subject. A later stage
 * than "applied" starts a job only when the mail speaks of an application (APPLICATION_WORDS)
 * or comes through a recruiting platform, which writes about applications made on it ("X hat
 * Sie zu einem Videovorstellungsgespräch eingeladen"): a recruiter's first message from their
 * own address ("Would you have time for an interview about a Web Developer role?") is no
 * application yet, and stays in review.
 */
function createFrom(
  mail: Pick<MailInput, "fromName" | "fromAddress" | "subject" | "body">,
  status: KeywordHit["status"],
  anchored: boolean,
): Decision | null {
  if (status !== "applied" && !platformOf(mail.fromAddress)) {
    const text = wordText(`${mail.subject}\n${mail.body}`);
    if (!APPLICATION_WORDS.some((word) => hasWords(text, [word]))) return null;
  }
  const company = fitField(companyFromDomain(mail) || companyFromPlatformName(mail));
  const guess = guessTitleDetail(mail);
  const title = fitField(anchored && !guess.anchored ? "" : guess.title);
  if (!company || !title) return null;
  return { outcome: "created", effect: { kind: "create", company, title, status } };
}

/**
 * What to do with a job-related email. In this order:
 *   no job matches (titles alone do not) -> create a job (setting on, the keywords point to
 *                       one status, a company from the sender's domain or a platform sender's
 *                       name, and a title guessed): as "applied" from a confirmation; in the
 *                       later stage from a rejection, an invitation or an offer, the first mail
 *                       about an application the tracker never saw, and then only with an
 *                       anchored title (guessTitleDetail). Else review "ambiguous_job" when
 *                       several titles tie, "unknown_job" otherwise
 *   several jobs tie -> review "ambiguous_job"; except jobs at one company when the mail
 *                       names, anchored, a role none of them has: another application there,
 *                       created as above
 *   mail that seems to name another role than the one job's, outside a thread linked to that
 *                       job: a second application at the same company is a new job, whatever
 *                       the first one's status. With an anchored title and a company, the job
 *                       is created as above. Without, the role is only a guess, and a wrong one
 *                       ("PDF" from "als PDF", "Ref 4711" from a subject) would add a job by
 *                       that name and leave the real one unmoved: a confirmation goes to review
 *                       "unknown_job" (the form is prefilled and can link instead), and other
 *                       mail is taken to be about the one job.
 *   a confirmation received after the one job was rejected, outside its thread -> review
 *                       "status_mismatch" suggesting "applied": nobody confirms an application
 *                       they have turned down, so this is most likely a new application at the
 *                       same company that does not name its role ("Norvik | Eingangsbestätigung").
 *                       Linking it would hide that; the review form can add the job or link.
 *   keywords cannot decide -> review with their reason; except a reply in a linked thread
 *                       without keywords, which is linked and keeps the status
 * Then, for the one job ("applied" never moves a job backwards: it only moves a saved one):
 *   locked                          -> link, keep the status (a manual choice wins over mail)
 *   status would not change         -> link
 *   mail older than the job         -> review "status_mismatch"
 *   mail older than the job's latest email-driven change -> link, keep the status
 *   job closed (offer, rejected)    -> review "status_mismatch"
 *   otherwise                       -> link and change the status
 * Bulk mail that only the sender's domain or history ties to a job (`bulkSender`,
 * relatedness.ts) never changes a job by itself: a decision to link or create becomes review
 * "bulk_mail" with the same jobs and status; a decision that is already a review keeps its reason.
 */
export function decideEffect(
  mail: Pick<MailInput, "fromName" | "fromAddress" | "subject" | "body">,
  receivedAt: number,
  keywords: StatusDecision,
  match: JobMatch,
  candidates: readonly JobScore[],
  ctx: Pick<PipelineContext, "createFromConfirmation" | "rules">,
  bulkSender = false,
): Decision {
  const decision = decide(mail, receivedAt, keywords, match, candidates, ctx);
  if (!bulkSender || decision.effect.kind === "review") return decision;
  const suggested = decision.effect.kind === "link" ? decision.effect.to : keywords.status;
  return review("bulk_mail", candidates, suggested);
}

function decide(
  mail: Pick<MailInput, "fromName" | "fromAddress" | "subject" | "body">,
  receivedAt: number,
  keywords: StatusDecision,
  match: JobMatch,
  candidates: readonly JobScore[],
  ctx: Pick<PipelineContext, "createFromConfirmation" | "rules">,
): Decision {
  const { status, reason } = keywords;
  const confirmation = status === "applied" && !reason;
  // The keywords point to one status, so the mail can start a job in it.
  const creates = !!status && !reason && ctx.createFromConfirmation ? status : null;
  // "No matching job" suggests none: the review form offers to create one, prefilled.
  const noMatch = (tied: boolean): Decision =>
    (creates ? createFrom(mail, creates, creates !== "applied") : null) ??
    (tied ? review("ambiguous_job", candidates, status) : review("unknown_job", [], status));

  if (match.kind === "none" || (match.kind === "tied" && match.weak)) return noMatch(match.kind === "tied");
  const scoreOf = (job: Job) => candidates.find((c) => c.job.id === job.id);
  if (match.kind === "tied") {
    const oneCompany = new Set(match.jobs.map((j) => slug(j.company))).size === 1;
    if (creates && oneCompany && match.jobs.every((j) => namesOtherRole(mail, j, scoreOf(j), ctx.rules))) {
      const another = createFrom(mail, creates, true);
      if (another) return another;
    }
    return review("ambiguous_job", candidates, status);
  }

  const { job } = match;
  const score = scoreOf(job);
  if (status && !reason && match.via === "score" && namesOtherRole(mail, job, score, ctx.rules)) {
    const second = creates ? createFrom(mail, creates, true) : null;
    if (second) return second;
    if (confirmation) return review("unknown_job", [], status);
  }
  if (confirmation && match.via === "score" && job.status === "rejected" && receivedAt > rejectedAt(job)) {
    return review("status_mismatch", candidates, "applied");
  }
  if (reason === "no_keyword" && match.via === "thread") return link(job, job.status);
  if (reason || !status) return review(reason ?? "no_keyword", candidates, status);

  // "applied" never moves a job backwards: only a saved job becomes applied.
  const to: Status = status === "applied" && job.status !== "saved" ? job.status : status;
  if (job.statusLocked || to === job.status) return link(job, job.status);
  if (receivedAt < Date.parse(job.createdAt)) return review("status_mismatch", candidates, to);
  if (receivedAt < latestEmailChange(job)) return link(job, job.status);
  if (CLOSED.includes(job.status)) return review("status_mismatch", candidates, to);
  return link(job, to);
}
