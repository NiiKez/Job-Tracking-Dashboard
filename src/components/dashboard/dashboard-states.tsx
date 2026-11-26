"use client";

import { Briefcase, Plus, RefreshCw, SearchX, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useAddJob } from "@/components/jobs/add-job-provider";
import { PRIORITY_META } from "@/lib/priority";
import { STATUS_META } from "@/lib/status";
import type { Priority, Status } from "@/lib/types";

const FRAME = "min-h-80 rounded-lg border border-dashed bg-card";

/** Zero jobs at all: point at the way in. */
export function EmptyDashboard() {
  const { openAddJob } = useAddJob();
  return (
    <Empty className={FRAME}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Briefcase aria-hidden />
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold">Add your first job</EmptyTitle>
        <EmptyDescription>
          Paste a job link or the full posting text. Emails keep the status up to date from
          there.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center">
        <Button onClick={() => openAddJob()} className="h-9 gap-1.5">
          <Plus aria-hidden />
          Add job
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** "Applied", "Applied or Interview", "Saved, Applied or Offer". */
function either(names: string[]) {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

function describeFilters(q: string, statuses: Status[], priorities: Priority[]) {
  const statusText = either(statuses.map((s) => STATUS_META[s].label));
  // "high-priority", "high- or low-priority"
  const levels = priorities.map((p) => PRIORITY_META[p].label.toLowerCase());
  const priorityText = levels.length
    ? `${either(levels.map((l, i) => (i < levels.length - 1 ? `${l}-` : l)))}-priority`
    : "";
  const what = [priorityText, statusText].filter(Boolean).join(" ");
  if (q) {
    return {
      title: what ? `No ${what} jobs match “${q}”` : `No jobs match “${q}”`,
      hint: what
        ? "Try a shorter search or another filter."
        : "Search looks at company names and job titles.",
    };
  }
  if (statusText && priorityText) {
    return { title: `No ${what} jobs`, hint: "Nothing has this status and priority right now." };
  }
  if (priorityText) return { title: `No ${what} jobs`, hint: "Nothing has this priority right now." };
  return { title: `No ${what} jobs`, hint: "Nothing has this status right now." };
}

/** Filters are active but nothing matches. */
export function NoResults({
  q,
  statuses,
  priorities,
  onClear,
}: {
  q: string;
  statuses: Status[];
  priorities: Priority[];
  onClear: () => void;
}) {
  const { title, hint } = describeFilters(q, statuses, priorities);
  return (
    <Empty className={FRAME}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX aria-hidden />
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold break-words">{title}</EmptyTitle>
        <EmptyDescription>{hint}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={onClear} className="h-9">
          Clear filters
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function LoadError({
  message,
  onRetry,
  retrying,
}: {
  message?: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <Empty className={FRAME} role="alert">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
          <TriangleAlert aria-hidden />
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold">Couldn&apos;t load your jobs</EmptyTitle>
        <EmptyDescription>
          {message ? `${message.replace(/[.\s]+$/, "")}. ` : ""}Your data is safe — check the
          connection and try again.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={onRetry} disabled={retrying} className="h-9 gap-1.5">
          <RefreshCw aria-hidden className={retrying ? "animate-spin" : undefined} />
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
