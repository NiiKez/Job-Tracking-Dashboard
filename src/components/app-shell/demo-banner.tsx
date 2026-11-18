"use client";

import { differenceInCalendarDays, format } from "date-fns";
import { FlaskConical } from "lucide-react";
import { useDemo } from "@/hooks/use-demo";
import { formatDateTime } from "@/lib/format";

/**
 * When the workspace is deleted, inside a sentence and in the browser's time zone: "today at
 * 14:32", "tomorrow at 09:05", else "Thu 19 Nov at 14:32" (the year only when it isn't this
 * year's). A workspace lives 24 hours, so it is nearly always today or tomorrow.
 */
export function deletionTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = format(at, "HH:mm");
  const days = differenceInCalendarDays(at, now);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `${format(at, at.getFullYear() === now.getFullYear() ? "EEE d MMM" : "EEE d MMM yyyy")} at ${time}`;
}

/**
 * The public demo's notice, at the top of every signed-in page: the data is invented, the
 * workspace is private to this browser and deleted at a given time, and real personal data does
 * not belong in it (docs/plan/5-public-demo.md, "Step 7").
 *
 * Nothing outside the demo, and nothing until /api/me has answered: the time is the browser's
 * local time, so it is never rendered on the server (no hydration mismatch). Not dismissible: it
 * holds the deletion time and the warning, which apply all the time, and it scrolls away with the
 * page (it isn't sticky), so it takes no room while working.
 */
export function DemoBanner() {
  const { demo } = useDemo();
  if (!demo) return null;
  const { expiresAt } = demo;

  return (
    // The panel's top corners are rounded from md (the inset sidebar): the tint follows them.
    <aside
      aria-label="About this demo"
      className="flex items-start gap-2 bg-surface-sunken px-4 py-2 text-xs text-muted-foreground sm:px-6 md:rounded-t-xl"
    >
      <FlaskConical aria-hidden className="mt-px size-3.5 shrink-0" />
      <p className="min-w-0 text-pretty">
        <span className="font-medium text-foreground">Demo with invented data</span>, private to this browser and
        deleted{" "}
        <time dateTime={expiresAt} title={formatDateTime(expiresAt)} className="tabular">
          {deletionTime(expiresAt)}
        </time>
        . Don&apos;t enter real personal data.
      </p>
    </aside>
  );
}
