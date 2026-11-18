import {
  differenceInCalendarDays,
  format,
  formatDistanceToNowStrict,
  isThisYear,
  isToday,
  isTomorrow,
} from "date-fns";

/*
 * Dates are day-first everywhere ("14 Nov", "14 Nov, 09:12") and rendered
 * with tabular numerals by the caller (`tabular` utility).
 */

/** "12 Nov" this year, "12 Nov 2025" otherwise. */
export function formatDate(iso: string) {
  const d = new Date(iso);
  return isThisYear(d) ? format(d, "d MMM") : format(d, "d MMM yyyy");
}

/** "12 Nov, 14:05" */
export function formatDateTime(iso: string) {
  const d = new Date(iso);
  return format(d, isThisYear(d) ? "d MMM, HH:mm" : "d MMM yyyy, HH:mm");
}

/** "Today, 14:00", "Tomorrow, 11:00", "Thu 19 Nov, 14:00" — for appointments. */
export function formatWhen(iso: string) {
  const d = new Date(iso);
  if (isToday(d)) return `Today, ${format(d, "HH:mm")}`;
  if (isTomorrow(d)) return `Tomorrow, ${format(d, "HH:mm")}`;
  return format(d, isThisYear(d) ? "EEE d MMM, HH:mm" : "EEE d MMM yyyy, HH:mm");
}

/** "Today", "Yesterday", "5d ago", "3w ago", then a date. */
export function formatRelative(iso: string) {
  const d = new Date(iso);
  const days = differenceInCalendarDays(new Date(), d);
  if (days <= 0) {
    const mins = Math.round((Date.now() - d.getTime()) / 60_000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    return `${Math.round(mins / 60)}h ago`;
  }
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 35) return `${Math.round(days / 7)}w ago`;
  return formatDate(iso);
}

export function formatAgo(iso: string) {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
}

/** Calendar days since a date (0 = today). */
export function daysSince(iso: string) {
  return differenceInCalendarDays(new Date(), new Date(iso));
}

/** Calendar days until a date (0 = today, negative = past). */
export function daysUntil(iso: string) {
  return differenceInCalendarDays(new Date(iso), new Date());
}

/** "1 day", "3 days" */
export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function initials(name: string) {
  const words = name.replace(/[&+]/g, " ").split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** Host only, for showing links compactly: "boards.greenhouse.io" */
export function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
