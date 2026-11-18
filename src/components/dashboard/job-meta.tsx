"use client";

import { Check, ExternalLink, MoreHorizontal, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDateTime } from "@/lib/format";
import { stageSignal, TONE_CLASS } from "@/lib/stages";
import { STATUS_META } from "@/lib/status";
import { STATUSES, type Job } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useDashboardChangeStatus } from "./change-status-context";

/** Keeps a click on a nested control from opening the job or starting a drag. */
export const stopBubbling = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
  onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
};

/** Grows the hit area to ≥ 40px on touch screens without changing the look. */
export const TOUCH_TARGET =
  "relative pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']";

/** Reveal on hover / keyboard focus; always visible on touch screens. */
export const REVEAL_ON_HOVER =
  "opacity-0 transition-opacity duration-150 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100";

/**
 * The one meta line under a job: what matters in its stage (days waiting,
 * next interview, respond-by date…). Coloured only when it needs the user.
 */
export function StageMeta({ job, className }: { job: Job; className?: string }) {
  const { text, tone, iso } = stageSignal(job);
  return (
    <p
      title={iso ? formatDateTime(iso) : undefined}
      className={cn("truncate text-xs leading-4 tabular", TONE_CLASS[tone], className)}
    >
      {text}
    </p>
  );
}

/**
 * "⋯" menu on a card or row — the hover alternative to drag & drop:
 * mark applied, move to any status, open the posting.
 */
export function JobActionsMenu({ job, className }: { job: Job; className?: string }) {
  const change = useDashboardChangeStatus();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-no-drag
          aria-label={`Actions for ${job.company}, ${job.title}`}
          className={cn(
            "z-10 bg-background text-muted-foreground hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground",
            TOUCH_TARGET,
            className,
          )}
          {...stopBubbling}
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
        {job.status === "saved" && (
          <>
            <DropdownMenuItem onSelect={() => change(job, "applied")}>
              <Send aria-hidden />
              Mark applied
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Move to
        </DropdownMenuLabel>
        {STATUSES.map((s) => (
          <DropdownMenuItem key={s} disabled={s === job.status} onSelect={() => change(job, s)}>
            <span className="flex-1">{STATUS_META[s].label}</span>
            {s === job.status && <Check aria-hidden className="text-muted-foreground" />}
          </DropdownMenuItem>
        ))}
        {job.url && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={job.url} target="_blank" rel="noreferrer noopener">
                <ExternalLink aria-hidden />
                Open posting
              </a>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
