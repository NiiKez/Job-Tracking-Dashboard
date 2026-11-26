import { daysSince, daysUntil, formatDate, formatWhen, plural } from "./format";
import type { Job, Priority, Status } from "./types";

/*
 * The pipeline as the dashboard shows it. Six statuses collapse into five
 * stages: Rejected and "No response" share one de-emphasised Closed stage,
 * so Applied only holds applications that are still waiting for a reply.
 */

export const STAGES = ["saved", "applied", "interview", "offer", "closed"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_META: Record<
  Stage,
  { label: string; description: string; /** Status a card gets when dropped here. */ dropStatus: Status }
> = {
  saved: { label: "Saved", description: "Not applied yet", dropStatus: "saved" },
  applied: { label: "Applied", description: "Waiting for a reply", dropStatus: "applied" },
  interview: { label: "Interview", description: "Invited to talk", dropStatus: "interview" },
  offer: { label: "Offer", description: "Offer received", dropStatus: "offer" },
  closed: { label: "Closed", description: "Rejected or no reply", dropStatus: "rejected" },
};

export function stageOf(status: Status): Stage {
  if (status === "rejected" || status === "no_response") return "closed";
  return status;
}

/** Days without news after which an application wants a follow-up. */
export const FOLLOW_UP_AFTER_DAYS = 14;

/**
 * How loud a line is. Colour only for "attention" (offer, overdue follow-up,
 * unmatched email); "strong" is weight, not colour.
 */
export type Tone = "muted" | "default" | "strong" | "attention";

export const TONE_CLASS: Record<Tone, string> = {
  muted: "text-muted-foreground",
  default: "text-foreground",
  strong: "font-medium text-foreground",
  attention: "font-medium text-attention",
};

/** When the job entered its current status (its last matching history event). */
export function statusSince(job: Pick<Job, "history" | "status" | "updatedAt">) {
  for (let i = job.history.length - 1; i >= 0; i--) {
    if (job.history[i].to === job.status) return job.history[i].at;
  }
  return job.updatedAt;
}

export function isFollowUpDue(job: Pick<Job, "status" | "lastActivityAt">) {
  return job.status === "applied" && daysSince(job.lastActivityAt) >= FOLLOW_UP_AFTER_DAYS;
}

/**
 * Days an application has gone without news. The same clock the inbox check
 * uses to move a job to "No response" (Settings: `noResponseDays`).
 */
export function daysWaiting(job: Pick<Job, "lastActivityAt">) {
  return Math.max(0, daysSince(job.lastActivityAt));
}

/** The interview date if it is today or later. */
export function upcomingInterview(job: Pick<Job, "status" | "nextInterview">) {
  const next = job.status === "interview" ? job.nextInterview : null;
  return next && daysUntil(next.at) >= 0 ? next : null;
}

export interface StageSignal {
  text: string;
  tone: Tone;
  /** Exact moment behind the text, for a tooltip / <time>. */
  iso?: string;
}

/** The one meta line a card shows: what matters about the job in its stage. */
export function stageSignal(job: Job): StageSignal {
  switch (job.status) {
    case "saved":
      return { text: `Saved ${formatDate(job.createdAt)}`, tone: "muted", iso: job.createdAt };

    case "applied": {
      const days = daysSince(job.lastActivityAt);
      if (days >= FOLLOW_UP_AFTER_DAYS) {
        return {
          text: `Follow up · no reply for ${plural(days, "day")}`,
          tone: "attention",
          iso: job.lastActivityAt,
        };
      }
      return {
        text: days <= 0 ? "Waiting since today" : `Waiting ${plural(days, "day")}`,
        tone: "muted",
        iso: job.lastActivityAt,
      };
    }

    case "no_response":
      return {
        text: `No reply for ${plural(daysSince(job.lastActivityAt), "day")}`,
        tone: "muted",
        iso: job.lastActivityAt,
      };

    case "interview": {
      const next = job.nextInterview;
      if (next && daysUntil(next.at) >= 0) {
        return {
          text: [formatWhen(next.at), next.round].filter(Boolean).join(" · "),
          tone: "strong",
          iso: next.at,
        };
      }
      if (next) return { text: `Interviewed ${formatDate(next.at)} · next date not set`, tone: "muted", iso: next.at };
      return { text: "Interview date not set", tone: "muted" };
    }

    case "offer": {
      if (!job.offerDeadline) {
        return { text: `Offer since ${formatDate(statusSince(job))} · no deadline set`, tone: "attention" };
      }
      const left = daysUntil(job.offerDeadline);
      const date = formatDate(job.offerDeadline);
      const text =
        left > 1
          ? `Respond by ${date} · ${left} days left`
          : left === 1
            ? `Respond by tomorrow, ${date}`
            : left === 0
              ? "Respond today"
              : `Response was due ${date}`;
      return { text, tone: "attention", iso: job.offerDeadline };
    }

    case "rejected":
      return { text: `Rejected ${formatDate(statusSince(job))}`, tone: "muted" };
  }
}

/** Code-point order: ISO dates sort correctly, "~" sorts after them. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Order inside a stage: whatever needs the user first. Interviews and offers
 * by date, Applied longest-waiting first, Saved and Closed newest first.
 */
export function compareInStage(a: Job, b: Job): number {
  const stage = stageOf(a.status);
  if (stage === "interview") {
    const ka = upcomingInterview(a)?.at ?? (a.nextInterview ? "~" + a.nextInterview.at : "~~");
    const kb = upcomingInterview(b)?.at ?? (b.nextInterview ? "~" + b.nextInterview.at : "~~");
    return cmp(ka, kb);
  }
  if (stage === "offer") {
    return cmp(a.offerDeadline ?? "~", b.offerDeadline ?? "~");
  }
  if (stage === "applied") return cmp(a.lastActivityAt, b.lastActivityAt);
  if (stage === "saved") return cmp(b.createdAt, a.createdAt);
  return cmp(b.lastActivityAt, a.lastActivityAt);
}

/** Sort rank of a priority: High first. */
export const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

/** Higher priority first; equal priorities are a tie (0). */
export function comparePriority(a: Pick<Job, "priority">, b: Pick<Job, "priority">) {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
}

/**
 * Jobs bucketed by stage. Inside each bucket higher priority always comes first, and `compare`
 * (default `compareInStage`, or the list's chosen sort) orders jobs of the same priority.
 */
export function groupByStage(jobs: Job[], compare: (a: Job, b: Job) => number = compareInStage) {
  const out = Object.fromEntries(STAGES.map((s) => [s, [] as Job[]])) as Record<Stage, Job[]>;
  for (const job of jobs) out[stageOf(job.status)].push(job);
  for (const s of STAGES) out[s].sort((a, b) => comparePriority(a, b) || compare(a, b));
  return out;
}
