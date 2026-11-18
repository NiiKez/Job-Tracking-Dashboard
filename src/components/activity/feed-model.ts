import { format, isThisYear, isToday, isYesterday } from "date-fns";
import type { Email, EmailOutcome, Job, StatusEvent } from "@/lib/types";

export const FILTERS = [
  { value: "all", label: "All", outcomes: null },
  { value: "changes", label: "Status changes", outcomes: ["matched", "resolved"] },
  { value: "created", label: "New applications", outcomes: ["created"] },
  { value: "review", label: "Needs review", outcomes: ["review"] },
  { value: "ignored", label: "Ignored", outcomes: ["ignored", "dismissed"] },
] as const satisfies ReadonlyArray<{
  value: string;
  label: string;
  outcomes: readonly EmailOutcome[] | null;
}>;

export type FilterValue = (typeof FILTERS)[number]["value"];

export function isFilter(v: string | null): v is FilterValue {
  return FILTERS.some((f) => f.value === v);
}

export type FeedItem =
  | { kind: "email"; id: string; at: string; email: Email }
  /** Not an email: a status change caused by time passing (no reply in N days). */
  | { kind: "system"; id: string; at: string; job: Job; event: StatusEvent };

/** Emails + "no reply" system events, newest first. */
export function buildFeed(emails: Email[], jobs: Job[]): FeedItem[] {
  const items: FeedItem[] = emails.map((email) => ({
    kind: "email",
    id: email.id,
    at: email.receivedAt,
    email,
  }));
  for (const job of jobs) {
    for (const event of job.history) {
      if (event.source === "time") items.push({ kind: "system", id: event.id, at: event.at, job, event });
    }
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

export function matchesFilter(item: FeedItem, filter: FilterValue) {
  if (filter === "all") return true;
  // Time-based changes are status changes too.
  if (item.kind === "system") return filter === "changes";
  const outcomes: readonly EmailOutcome[] = FILTERS.find((f) => f.value === filter)?.outcomes ?? [];
  return outcomes.includes(item.email.outcome);
}

export function countByFilter(items: FeedItem[]) {
  const counts = Object.fromEntries(FILTERS.map((f) => [f.value, 0])) as Record<FilterValue, number>;
  for (const item of items) {
    for (const f of FILTERS) if (matchesFilter(item, f.value)) counts[f.value]++;
  }
  return counts;
}

/** "Today", "Yesterday", "Mon, Nov 10" (year added when not this year). */
export function dayLabel(iso: string) {
  const d = new Date(iso);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, isThisYear(d) ? "EEE, MMM d" : "EEE, MMM d, yyyy");
}

export function groupByDay(items: FeedItem[]) {
  const groups: Array<{ key: string; label: string; items: FeedItem[] }> = [];
  for (const item of items) {
    const key = format(new Date(item.at), "yyyy-MM-dd");
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(item.at), items: [item] });
  }
  return groups;
}
