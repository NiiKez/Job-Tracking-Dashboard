/*
 * Matching an email to a job. Every job is a candidate, whatever its status: mail about a job in
 * Offer or Rejected must find that job (decide.ts then links it or sends it to review), not
 * become "unknown job" or a duplicate.
 *
 * A job scores points for what points at it:
 *   the sender's domain (or Reply-To's) is the job's company                            60
 *   mail from this exact address was linked to the job before                          35
 *   the company is named in the sender name, subject or body (whole words)             35
 *   the title is named there (whole words)                                             25
 * A title counts as named also without its single letters, when two words or more are left:
 * "Data Engineer (m/w/d)" is named by "Data Engineer", as mail rarely repeats the gender marker.
 * Domains are compared as registrable labels ("jobs.acme.example" -> "acme"), and personal
 * mail hosts and recruiting platforms never match (extract.ts). A label stands for itself and
 * for each leading run of its hyphenated parts ("halcyon-robotics": Halcyon, Halcyon Robotics),
 * and keys are compared for equality, never as substrings ("metabase" is not Meta). A job's
 * posting host counts as its company's domain only when the company's name starts with it
 * (jobs.fjordvik-energy.example for "Fjordvik Energy Group"): a job found through a site that is
 * not a known platform (Google's job search, an aggregator) would otherwise make all of that
 * site's mail point at the job. A thread already linked to a job decides alone. Candidates
 * within 15 points of the best are a tie.
 *
 * The sender's history does not count for a recruiting platform's address: every employer on
 * Lever writes from the same no-reply@hire.lever.co, so its history says nothing about which.
 *
 * The mock capped the score at 100 (1.0), so for two jobs at one company a named title or the
 * sender's history could not break the tie whenever the company was named too; there is no cap.
 * The sender's history weighs as much as a named company: a recruiter who writes about another
 * job at the same company ties instead of being linked to the old one. A title alone (25) does
 * not match a job, because generic titles are everywhere: such candidates only tie ("weak"),
 * and decide.ts may still create a job from a confirmation.
 */
import type { Job } from "@/lib/types";
import {
  companyKeys,
  companyPrefixes,
  companyWords,
  domainCore,
  domainKey,
  domainKeys,
  hasWords,
  platformOf,
  urlCore,
  wordsOf,
  wordText,
} from "./extract";
import type { MailInput, PipelineContext } from "./types";

const DOMAIN = 60;
const SENDER_HISTORY = 35;
const COMPANY_NAMED = 35;
const TITLE_NAMED = 25;
/** Candidates closer than this to the best are a tie. */
export const TIE_POINTS = 15;
/** Fewest points for a match: more than a title alone. */
export const MATCH_POINTS = COMPANY_NAMED;

export interface JobScore {
  job: Job;
  points: number;
  thread: boolean;
  senderHistory: boolean;
  domain: boolean;
  companyNamed: boolean;
  titleNamed: boolean;
}

export type JobMatch =
  | { kind: "none" }
  | { kind: "one"; job: Job; via: "thread" | "score" }
  /** `weak`: even the best has fewer than MATCH_POINTS (titles only). */
  | { kind: "tied"; jobs: Job[]; weak: boolean };

/** The sender's domain (any of `senderKeys`, from domainKeys) is the job's company. */
function domainMatches(senderKeys: ReadonlySet<string>, job: Job): boolean {
  if (senderKeys.size === 0) return false;
  if (companyKeys(job.company).some((k) => senderKeys.has(k))) return true;
  const posting = job.url ? urlCore(job.url) : null;
  const postingKey = posting ? domainKey(posting) : "";
  return !!postingKey && senderKeys.has(postingKey) && companyPrefixes(job.company).includes(postingKey);
}

/** The job's title stands in `text` (from wordText): see the top of this file. */
function titleNamed(text: string, title: string): boolean {
  const words = wordsOf(title);
  const core = words.filter((w) => w.length > 1);
  return hasWords(text, words) || (core.length >= 2 && core.length < words.length && hasWords(text, core));
}

/**
 * Every job something points at, best first: the thread's job, then by points (stable, so ties
 * keep the order of ctx.jobs).
 */
export function scoreJobs(
  mail: Pick<MailInput, "fromName" | "fromAddress" | "replyToAddress" | "subject" | "body">,
  ctx: Pick<PipelineContext, "jobs" | "threadJobId" | "senderJobIds">,
): JobScore[] {
  const senderKeys = new Set(
    [mail.fromAddress, mail.replyToAddress ?? ""]
      .map((a) => domainCore(a))
      .filter((c): c is string => !!c)
      .flatMap(domainKeys),
  );
  // A platform's address is shared by every employer on it: its history names none of them.
  const history = platformOf(mail.fromAddress) ? [] : ctx.senderJobIds;
  const text = wordText(`${mail.fromName}\n${mail.subject}\n${mail.body}`);

  const scores: JobScore[] = [];
  for (const job of ctx.jobs) {
    const company = companyWords(job.company);
    const s: JobScore = {
      job,
      points: 0,
      thread: !!ctx.threadJobId && job.id === ctx.threadJobId,
      senderHistory: history.includes(job.id),
      domain: domainMatches(senderKeys, job),
      companyNamed: company.join("").length >= 3 && hasWords(text, company),
      titleNamed: titleNamed(text, job.title),
    };
    s.points =
      (s.domain ? DOMAIN : 0) +
      (s.senderHistory ? SENDER_HISTORY : 0) +
      (s.companyNamed ? COMPANY_NAMED : 0) +
      (s.titleNamed ? TITLE_NAMED : 0);
    if (s.thread || s.points > 0) scores.push(s);
  }
  return scores.sort((a, b) => Number(b.thread) - Number(a.thread) || b.points - a.points);
}

/** The job the email is about: the thread's, else the best candidate unless it ties or is too weak. */
export function pickJob(scores: readonly JobScore[]): JobMatch {
  const [top] = scores;
  if (!top) return { kind: "none" };
  if (top.thread) return { kind: "one", job: top.job, via: "thread" };
  const weak = top.points < MATCH_POINTS;
  const tied = scores.filter((s) => top.points - s.points < TIE_POINTS);
  if (tied.length > 1) return { kind: "tied", jobs: tied.map((s) => s.job), weak };
  return weak ? { kind: "none" } : { kind: "one", job: top.job, via: "score" };
}
