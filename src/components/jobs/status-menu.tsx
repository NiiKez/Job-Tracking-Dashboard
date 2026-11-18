"use client";

import { Check, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUpdateJob } from "@/lib/api/hooks";
import { manualStatusChange } from "@/lib/domain/status-change";
import { STATUS_META } from "@/lib/status";
import { STATUSES, type Job, type Status } from "@/lib/types";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./status-badge";

/** What a status change needs of the job: Undo restores its status and its lock. */
export type StatusChangeJob = Pick<Job, "id" | "company" | "title" | "status" | "statusLocked">;

/**
 * Change a job's status by hand. Shows an undo toast. A manual change locks
 * the status so emails won't override it (see Job.statusLocked); Undo puts
 * back the lock the job had before, not just the status (manualStatusChange).
 */
export function useChangeStatus() {
  const update = useUpdateJob();
  return (job: StatusChangeJob, to: Status) => {
    const change = manualStatusChange(job, to);
    if (!change) return;
    // mutateAsync (not per-call mutate callbacks): the card that triggered the
    // change unmounts as soon as the optimistic update moves it to another
    // column, and TanStack Query skips per-call callbacks after unmount.
    update.mutateAsync({ id: job.id, patch: change.patch }).then(
      () =>
        toast.success(`Moved to ${STATUS_META[to].label}`, {
          description: `${job.company} · ${job.title}`,
          action: {
            label: "Undo",
            onClick: () => {
              update.mutateAsync({ id: job.id, patch: change.undo }).catch((err: Error) =>
                toast.error("Couldn't undo", { description: err.message }),
              );
            },
          },
        }),
      (err: Error) => toast.error("Couldn't change the status", { description: err.message }),
    );
  };
}

export function StatusMenu({
  job,
  variant = "badge",
  align = "start",
  className,
}: {
  job: StatusChangeJob;
  /** "badge": the status pill is the trigger. "button": an outline button. */
  variant?: "badge" | "button";
  align?: "start" | "end";
  className?: string;
}) {
  const change = useChangeStatus();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "badge" ? (
          <button
            type="button"
            aria-label={`Status: ${STATUS_META[job.status].label}. Change status`}
            className={cn(
              "group/status inline-flex items-center gap-0.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              className,
            )}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <StatusBadge status={job.status} />
            <ChevronDown
              aria-hidden
              className="size-3 text-muted-foreground opacity-60 transition-opacity group-hover/status:opacity-100"
            />
          </button>
        ) : (
          <Button variant="outline" size="sm" className={cn("gap-1.5", className)}>
            <StatusBadge status={job.status} className="-ml-1" />
            <span className="sr-only">Change status</span>
            <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-52" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel className="text-xs text-muted-foreground">Move to</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {STATUSES.map((s) => {
          const meta = STATUS_META[s];
          const Icon = meta.icon;
          return (
            <DropdownMenuItem key={s} onSelect={() => change(job, s)} className="gap-2">
              <Icon aria-hidden className={cn("size-4", meta.textClass)} />
              <span className="flex-1">{meta.label}</span>
              {s === job.status && <Check aria-hidden className="size-4 text-muted-foreground" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
