import { addWeeks, format, isThisYear, startOfWeek } from "date-fns";
import { compareInStage, upcomingInterview } from "./stages";
import type { Job, Status } from "./types";

/*
 * The numbers behind the KPI row on the Applications page: how many
 * applications went out, how many were answered, and how far they got.
 *
 * Everything is derived from each job's status history, so a job that went
 * Applied → Interview → Rejected still counts as answered and as having
 * reached an interview.
 */

/** A reply from the company: anything but silence. */
const REPLY: ReadonlySet<Status> = new Set(["interview", "offer", "rejected"]);
const REACHED_INTERVIEW: ReadonlySet<Status> = new Set(["interview", "offer"]);
const OFFER: ReadonlySet<Status> = new Set(["offer"]);

/** When the application was sent, or null if it is still only saved. */
export function sentAt(job: Job): string | null {
  if (job.appliedAt) return job.appliedAt;
  return job.history.find((e) => e.to !== "saved")?.at ?? null;
}

const reached = (job: Job, statuses: ReadonlySet<Status>) =>
  statuses.has(job.status) || job.history.some((e) => statuses.has(e.to));

export interface Rate {
  part: number;
  whole: number;
  /** Whole percent, or null when nothing has been sent yet. */
  percent: number | null;
}

function rate(part: number, whole: number): Rate {
  return { part, whole, percent: whole === 0 ? null : Math.round((part / whole) * 100) };
}

export interface WeekBucket {
  /** Monday of the week (ISO). */
  weekStart: string;
  /** "9 Nov" */
  label: string;
  sent: number;
}

export interface Overview {
  /** Applications sent, all time. */
  sent: number;
  /** Sent in the current calendar week (the chart's last column). */
  sentThisWeek: number;
  /** Sent in the calendar week before. */
  sentLastWeek: number;
  /** Calendar weeks (Monday first), oldest first, the current week last. */
  weeks: WeekBucket[];
  /** Sent applications that got an interview, an offer or a rejection. */
  answered: Rate;
  /** Sent applications that ever reached Interview or Offer. */
  interviewed: Rate;
  /** Sent applications that ended in an offer. */
  offers: Rate;
  /** Applications in the Interview stage right now. */
  interviewsInProgress: number;
  /** The soonest upcoming interview among them, if any has a date. */
  nextInterviewAt: string | null;
}

/** The chart shows at least 8 weeks and grows with the search, up to 12. */
export const MIN_WEEKS = 8;
export const MAX_WEEKS = 12;
const WEEK_MS = 7 * 86_400_000;

export function buildOverview(jobs: Job[], now = new Date()): Overview {
  const thisWeek = startOfWeek(now, { weekStartsOn: 1 });
  const buckets: WeekBucket[] = Array.from({ length: MAX_WEEKS }, (_, i) => {
    const start = addWeeks(thisWeek, i - (MAX_WEEKS - 1));
    return {
      weekStart: start.toISOString(),
      label: format(start, isThisYear(start) ? "d MMM" : "d MMM yyyy"),
      sent: 0,
    };
  });
  const firstWeek = new Date(buckets[0].weekStart).getTime();

  let sent = 0;
  let answered = 0;
  let interviewed = 0;
  let offers = 0;

  for (const job of jobs) {
    const sentIso = sentAt(job);
    if (!sentIso) continue;
    sent++;
    const t = new Date(sentIso).getTime();
    if (t >= firstWeek) buckets[Math.min(MAX_WEEKS - 1, Math.floor((t - firstWeek) / WEEK_MS))].sent++;
    if (reached(job, REPLY)) answered++;
    if (reached(job, REACHED_INTERVIEW)) interviewed++;
    if (reached(job, OFFER)) offers++;
  }

  // Drop empty weeks from before the first application, down to MIN_WEEKS.
  const firstActive = buckets.findIndex((w) => w.sent > 0);
  const start = Math.min(firstActive === -1 ? MAX_WEEKS : firstActive, MAX_WEEKS - MIN_WEEKS);
  const weeks = buckets.slice(start);

  const interviews = jobs.filter((j) => j.status === "interview");
  const next = interviews.filter((j) => upcomingInterview(j)).sort(compareInStage)[0];

  return {
    sent,
    sentThisWeek: weeks[weeks.length - 1].sent,
    sentLastWeek: weeks[weeks.length - 2].sent,
    weeks,
    answered: rate(answered, sent),
    interviewed: rate(interviewed, sent),
    offers: rate(offers, sent),
    interviewsInProgress: interviews.length,
    nextInterviewAt: next?.nextInterview?.at ?? null,
  };
}
