"use client";

import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { CalendarDays, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDate, formatDateTime, formatWhen } from "@/lib/format";
import { sentAt } from "@/lib/overview";
import {
  daysWaiting,
  isFollowUpDue,
  stageSignal,
  statusSince,
  TONE_CLASS,
  upcomingInterview,
} from "@/lib/stages";
import type { Job } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useDashboardChangeStatus } from "./change-status-context";
import { JobActionsMenu, REVEAL_ON_HOVER, stopBubbling } from "./job-meta";
import { Meter } from "./kpi-row";

/** Wiring from useDraggable, when the card lives on the board. */
export interface JobCardDnd {
  setNodeRef: (el: HTMLElement | null) => void;
  setActivatorNodeRef: (el: HTMLElement | null) => void;
  listeners: DraggableSyntheticListeners;
  attributes: DraggableAttributes;
  isDragging: boolean;
}

/** The invisible button stretched over a card or row: click / Enter opens the job. */
export function OpenOverlay({
  job,
  label,
  dnd,
  onOpen,
  className,
}: {
  job: Job;
  label: string;
  dnd?: JobCardDnd;
  onOpen?: (id: string) => void;
  className?: string;
}) {
  const open = () => onOpen?.(job.id);
  return (
    <div
      ref={dnd?.setActivatorNodeRef}
      role="button"
      tabIndex={0}
      {...dnd?.attributes}
      data-card-open
      aria-label={label}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !dnd?.isDragging) {
          e.preventDefault();
          open();
        }
      }}
      className={cn("absolute inset-0 cursor-pointer outline-none active:cursor-grabbing", className)}
    />
  );
}

/**
 * A job on the board: company, role, then location and the date it was saved
 * or sent, and a footer with the one thing that matters in its stage — a
 * "Mark as applied" button, the days without a reply, the next interview, the
 * offer's deadline. No status pill: the column is the status.
 *
 * The whole card opens the job (an invisible button is stretched over it);
 * the status changes by drag or the "⋯" menu that appears on hover.
 */
export function JobCard({
  job,
  onOpen,
  dnd,
  overlay = false,
  noResponseDays,
  className,
}: {
  job: Job;
  onOpen?: (id: string) => void;
  dnd?: JobCardDnd;
  /** Rendered inside the DragOverlay: a static copy that follows the pointer. */
  overlay?: boolean;
  noResponseDays: number;
  className?: string;
}) {
  const isDragging = dnd?.isDragging ?? false;
  const isOffer = job.status === "offer";
  const sent = sentAt(job);
  const dated =
    job.status === "saved" || !sent
      ? { text: `Saved ${formatDate(job.createdAt)}`, iso: job.createdAt }
      : { text: `Applied ${formatDate(sent)}`, iso: sent };

  return (
    <article
      ref={dnd?.setNodeRef}
      {...dnd?.listeners}
      aria-hidden={overlay || undefined}
      data-dragging={isDragging || undefined}
      className={cn(
        "group/card relative flex flex-col rounded-lg border bg-card p-3 select-none",
        "transition-[border-color,opacity] duration-150",
        isOffer && "border-attention/60",
        !overlay && !isDragging && (isOffer ? "hover:border-attention" : "hover:border-foreground/25"),
        // Focus ring for the whole card when its open-button is focused.
        "has-[[data-card-open]:focus-visible]:ring-3 has-[[data-card-open]:focus-visible]:ring-ring/25",
        dnd && "touch-manipulation [-webkit-touch-callout:none]",
        isDragging && "opacity-40",
        overlay && "rotate-[1.5deg] cursor-grabbing border-foreground/25 shadow-md",
        className,
      )}
    >
      {!overlay && (
        <OpenOverlay
          job={job}
          dnd={dnd}
          onOpen={onOpen}
          label={`${job.company}, ${job.title}. ${stageSignal(job).text}`}
          className="rounded-lg"
        />
      )}

      <h4 className="truncate pr-6 text-sm leading-5 font-semibold" title={job.company}>
        {job.company}
      </h4>
      <p className="mt-0.5 truncate text-meta" title={job.title}>
        {job.title}
      </p>
      <p className="mt-1 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{job.location}</span>
        <time dateTime={dated.iso} title={formatDateTime(dated.iso)} className="shrink-0 tabular">
          {dated.text}
        </time>
      </p>

      <CardFooter job={job} noResponseDays={noResponseDays} interactive={!overlay} />

      {!overlay && (
        <JobActionsMenu
          job={job}
          className={cn(
            "absolute top-2 right-2",
            REVEAL_ON_HOVER,
            "group-hover/card:opacity-100 group-has-[[data-card-open]:focus-visible]/card:opacity-100",
          )}
        />
      )}
    </article>
  );
}

/** The stage's one fact, under the card's header lines. */
function CardFooter({
  job,
  noResponseDays,
  interactive,
}: {
  job: Job;
  noResponseDays: number;
  interactive: boolean;
}) {
  const change = useDashboardChangeStatus();

  switch (job.status) {
    case "saved":
      return (
        <Button
          type="button"
          variant="secondary"
          data-no-drag
          tabIndex={interactive ? undefined : -1}
          className="relative z-10 mt-3 h-8 w-full pointer-coarse:h-10"
          aria-label={`Mark ${job.company}, ${job.title} as applied`}
          {...stopBubbling}
          onClick={(e) => {
            e.stopPropagation();
            change(job, "applied");
          }}
        >
          Mark as applied
        </Button>
      );

    case "applied": {
      const days = daysWaiting(job);
      const due = isFollowUpDue(job);
      return (
        <p className="mt-3 flex items-center gap-3" title={`No reply since ${formatDateTime(job.lastActivityAt)}`}>
          <Meter
            value={days}
            max={noResponseDays}
            fillClass={due ? "bg-attention" : undefined}
            className="min-w-0 flex-1"
          />
          <span className={cn("shrink-0 text-xs tabular", due ? "font-semibold" : "text-muted-foreground")}>
            {days > noResponseDays ? `Over ${noResponseDays} days` : `${days} of ${noResponseDays} days`}
          </span>
        </p>
      );
    }

    case "interview": {
      const next = job.nextInterview;
      const upcoming = upcomingInterview(job);
      const text = upcoming
        ? [upcoming.round, formatWhen(upcoming.at)].filter(Boolean).join(", ")
        : next
          ? `Interviewed ${formatDate(next.at)}, next date not set`
          : `Invited ${formatDate(statusSince(job))}, no time set yet`;
      return (
        <FooterLine icon={CalendarDays} className={upcoming ? "text-foreground" : "text-muted-foreground"}>
          {text}
        </FooterLine>
      );
    }

    case "offer": {
      const { text, tone } = stageSignal(job);
      return (
        <FooterLine icon={Clock} className={TONE_CLASS[tone]}>
          {text}
        </FooterLine>
      );
    }

    default:
      // Closed jobs are listed as compact rows (board-view), not as cards;
      // this only shows while one is being dragged.
      return <p className="mt-2 text-xs text-muted-foreground tabular">{stageSignal(job).text}</p>;
  }
}

function FooterLine({
  icon: Icon,
  className,
  children,
}: {
  icon: typeof CalendarDays;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p className={cn("mt-2.5 flex items-start gap-2 text-xs leading-4 tabular", className)}>
      <Icon aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Same footprint as a card, for loading states. */
export function JobCardSkeleton() {
  return (
    <div aria-hidden className="rounded-lg border p-3">
      <span className="block h-3.5 w-3/5 animate-pulse rounded bg-muted" />
      <span className="mt-2 block h-3 w-4/5 animate-pulse rounded bg-muted" />
      <span className="mt-2 block h-3 w-full animate-pulse rounded bg-muted" />
      <span className="mt-3 block h-3 w-2/3 animate-pulse rounded bg-muted" />
    </div>
  );
}
