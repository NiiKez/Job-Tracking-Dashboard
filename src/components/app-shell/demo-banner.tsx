"use client";

import { differenceInCalendarDays, format } from "date-fns";
import { FlaskConical } from "lucide-react";
import { useEffect, useState } from "react";
import { useDemo, useReloadFromHistoryInDemo } from "@/hooks/use-demo";
import { formatDateTime } from "@/lib/format";

/** How often the deletion time is worked out again, so "tomorrow" turns into "today" at midnight. */
const CLOCK_MS = 60_000;

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
 * The deletion time, worked out again every minute: the banner stays mounted across pages (the
 * (app) layout) and /api/me is asked once, so without it "tomorrow" would still say so after
 * midnight. Mounted only in the demo and after hydration (DemoBanner), so the clock never runs on
 * the server or in the real app.
 */
function DeletionTime({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => window.clearInterval(id);
  }, []);
  return (
    <time dateTime={expiresAt} title={formatDateTime(expiresAt)} className="tabular">
      {deletionTime(expiresAt, now)}
    </time>
  );
}

/**
 * The public demo's notice, at the top of every signed-in page: the data is invented, the
 * workspace is private to this browser and deleted at a given time at the latest (sooner when
 * the demo is full: src/lib/server/demo/workspaces.ts, EVICT_AFTER_SECONDS), and real personal
 * data does not belong in it (docs/plan/5-public-demo.md, "Step 7").
 *
 * Nothing outside the demo, and nothing until /api/me has answered: the time is the browser's
 * local time, so it is never rendered on the server (no hydration mismatch). Not dismissible: it
 * holds the deletion time and the warning, which apply all the time, and it scrolls away with the
 * page (it isn't sticky), so it takes no room while working.
 *
 * Every signed-in page has it, so it also reloads a demo page the browser brings back from its
 * history (useReloadFromHistoryInDemo).
 */
export function DemoBanner() {
  const { demo } = useDemo();
  useReloadFromHistoryInDemo();
  if (!demo) return null;

  return (
    // The panel's top corners are rounded from md (the inset sidebar): the tint follows them.
    <aside
      aria-label="About this demo"
      className="flex items-start gap-2 bg-surface-sunken px-4 py-2 text-xs text-muted-foreground sm:px-6 md:rounded-t-xl"
    >
      <FlaskConical aria-hidden className="mt-px size-3.5 shrink-0" />
      <p className="min-w-0 text-pretty">
        <span className="font-medium text-foreground">Demo with invented data</span>, private to this browser and
        deleted no later than <DeletionTime expiresAt={demo.expiresAt} /> (sooner if the demo gets very busy).
        Don&apos;t enter real personal data.
      </p>
    </aside>
  );
}
