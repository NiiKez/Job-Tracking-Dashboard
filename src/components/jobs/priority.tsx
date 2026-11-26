"use client";

import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUpdateJob } from "@/lib/api/hooks";
import { isMarkedPriority, PRIORITY_META } from "@/lib/priority";
import { PRIORITIES, type Job, type Priority } from "@/lib/types";
import { cn } from "@/lib/utils";

/*
 * A priority's glyph: three bars of rising height, filled up to its level
 * (Low ▂, Medium ▂▄, High ▂▄▆). Shape carries the level, not colour: the
 * accent stays reserved for what needs the user (DESIGN.md). Decorative for
 * assistive tech; the label always goes with it.
 */
const BARS = [
  { x: 2, y: 9.5, h: 4.5 },
  { x: 6.5, y: 6, h: 8 },
  { x: 11, y: 2.5, h: 11.5 },
];

export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const filled = PRIORITY_META[priority].bars;
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn(
        "size-3.5 shrink-0",
        priority === "low" ? "text-muted-foreground" : "text-foreground",
        className,
      )}
    >
      {BARS.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={b.y}
          width="3"
          height={b.h}
          rx="1"
          fill="currentColor"
          opacity={i < filled ? 1 : 0.22}
        />
      ))}
    </svg>
  );
}

/**
 * The marker on a board card or table row. Medium is the default, so it shows
 * nothing; High and Low get the glyph, a tooltip and a screen-reader label.
 * The glyph sits inline after the company name, so the card keeps its height.
 */
export function PriorityMark({
  priority,
  tooltip = true,
  onClick,
  className,
}: {
  priority: Priority;
  /** Off where nothing can hover it (the drag preview); the native title stands in. */
  tooltip?: boolean;
  /** On a card the mark sits above the open-button: a click on it should still open the job. */
  onClick?: () => void;
  className?: string;
}) {
  if (!isMarkedPriority(priority)) return null;
  const meta = PRIORITY_META[priority];
  const mark = (
    <span
      data-priority={priority}
      className={cn("inline-flex shrink-0 items-center", className)}
      title={tooltip ? undefined : meta.long}
      onClick={onClick}
    >
      <PriorityIcon priority={priority} />
      <span className="sr-only">{meta.long}</span>
    </span>
  );
  if (!tooltip) return mark;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{mark}</TooltipTrigger>
      <TooltipContent>{meta.long}</TooltipContent>
    </Tooltip>
  );
}

/** What a priority change needs of the job. */
export type PriorityChangeJob = Pick<Job, "id" | "company" | "title" | "priority">;

/**
 * Change a job's priority. Applied optimistically (useUpdateJob), so the card
 * moves within its column at once; the toast offers Undo, like a status change.
 */
export function useChangePriority() {
  const update = useUpdateJob();
  return (job: PriorityChangeJob, to: Priority) => {
    const from = job.priority;
    if (from === to) return;
    update.mutateAsync({ id: job.id, patch: { priority: to } }).then(
      () =>
        toast.success(`Priority set to ${PRIORITY_META[to].label}`, {
          description: `${job.company} · ${job.title}`,
          action: {
            label: "Undo",
            onClick: () => {
              update
                .mutateAsync({ id: job.id, patch: { priority: from } })
                .catch((err: Error) => toast.error("Couldn't undo", { description: err.message }));
            },
          },
        }),
      (err: Error) => toast.error("Couldn't change the priority", { description: err.message }),
    );
  };
}

/** Glyph + label, as one line in pickers. */
export function PriorityLabel({ priority }: { priority: Priority }) {
  return (
    <span className="inline-flex items-center gap-2">
      <PriorityIcon priority={priority} />
      {PRIORITY_META[priority].label}
    </span>
  );
}

/** Compact picker for the job detail (page and side sheet). Saves on change. */
export function PrioritySelect({ job, className }: { job: PriorityChangeJob; className?: string }) {
  const change = useChangePriority();
  return (
    <Select value={job.priority} onValueChange={(v) => change(job, v as Priority)}>
      <SelectTrigger
        aria-label={`Priority: ${PRIORITY_META[job.priority].label}. Change priority`}
        className={cn("gap-1.5 bg-background max-sm:data-[size=default]:h-10", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {PRIORITIES.map((p) => (
          <SelectItem key={p} value={p}>
            <PriorityLabel priority={p} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
