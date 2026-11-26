"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { useMemo, useState, type PointerEvent, type TouchEvent } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAddJob } from "@/components/jobs/add-job-provider";
import { PriorityMark } from "@/components/jobs/priority";
import { formatDate } from "@/lib/format";
import { priorityNote } from "@/lib/priority";
import { groupByStage, STAGE_META, STAGES, stageOf, statusSince, type Stage } from "@/lib/stages";
import { STATUS_META } from "@/lib/status";
import type { Job, Status } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useDashboardChangeStatus } from "./change-status-context";
import { JobCard, JobCardSkeleton, OpenOverlay, type JobCardDnd } from "./job-card";
import { JobActionsMenu, REVEAL_ON_HOVER } from "./job-meta";
import { StageIcon } from "./stage-icon";

/* -------------------------------------------------------------- sensors */

/** Don't start a drag from buttons, links or menus inside a card. */
function startsOnControl(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest("button, a, input, textarea, select, [role=menuitem], [data-no-drag]")
  );
}

/** Mouse / pen only — touch goes through the long-press TouchSensor so swiping still scrolls. */
class BoardPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent: e }: PointerEvent) =>
        e.isPrimary && e.button === 0 && e.pointerType !== "touch" && !startsOnControl(e.target),
    },
  ];
}

class BoardTouchSensor extends TouchSensor {
  static activators = [
    {
      eventName: "onTouchStart" as const,
      handler: ({ nativeEvent: e }: TouchEvent) => e.touches.length <= 1 && !startsOnControl(e.target),
    },
  ];
}

/** Enter opens the card, so only Space picks it up. */
const KEYBOARD_CODES = { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] };

/** Left / right arrows jump a whole column instead of nudging 25px. */
const columnCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const { active, collisionRect, droppableRects, over } = context;
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code)) return undefined;
  event.preventDefault();
  if (event.code === "ArrowUp" || event.code === "ArrowDown") return undefined;
  if (!active || !collisionRect) return undefined;

  const columns = STAGES.filter((s) => droppableRects.has(s));
  const job = active.data.current?.job as Job | undefined;
  const current = (over?.id as Stage | undefined) ?? (job ? stageOf(job.status) : undefined);
  const index = current ? columns.indexOf(current) : -1;
  const target = columns[index + (event.code === "ArrowRight" ? 1 : -1)];
  const rect = target ? droppableRects.get(target) : undefined;
  if (!rect) return undefined;

  return {
    x: rect.left + Math.max(0, (rect.width - collisionRect.width) / 2),
    y: Math.min(
      Math.max(collisionRect.top, rect.top + 40),
      rect.top + rect.height - collisionRect.height,
    ),
  };
};

/** Pointer position wins; keyboard drags fall back to rectangle overlap. */
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : rectIntersection(args);
};

const columnLabel = (id: UniqueIdentifier | undefined) =>
  id && id in STAGE_META ? STAGE_META[id as Stage].label : "a column";

/* --------------------------------------------------------------- layout */

/*
 * Five columns of cards. Columns have no box of their own: a rule under the
 * header and the cards' borders do the separating. A background appears only
 * on the column you drag over. Wide containers fit all five side by side;
 * narrower ones scroll sideways, one column snapping at a time.
 */
const COLUMN_CLASS =
  "relative flex min-w-0 flex-[1_0_min(13rem,calc(100vw-4.5rem))] snap-start flex-col rounded-lg @4xl:flex-[1_1_0]";

/** Cards a column shows before "Show N more". */
const COLUMN_LIMIT = 4;
/** Rows each Closed group (Rejected, No response) shows before "Show all". */
const CLOSED_LIMIT = 2;

const LINK_BUTTON =
  "cursor-pointer rounded-sm text-meta font-medium underline underline-offset-4 outline-none hover:text-foreground/70 focus-visible:ring-3 focus-visible:ring-ring/25";

function BoardScroller({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div
      role="region"
      aria-label={label}
      className="relative -mx-4 flex min-h-64 snap-x snap-mandatory scroll-px-4 items-stretch gap-4 overflow-x-auto overscroll-x-contain px-4 pb-3 [scrollbar-width:thin] sm:-mx-6 sm:scroll-px-6 sm:px-6 md:snap-none"
    >
      {children}
    </div>
  );
}

/* --------------------------------------------------------------- board */

interface PendingMove {
  id: string;
  to: Status;
  at: string;
  /** The list the move was made against; once the cache changes it's stale. */
  base: Job[];
}

export function BoardView({
  jobs,
  onOpen,
  filtered,
  noResponseDays,
}: {
  jobs: Job[];
  onOpen: (id: string) => void;
  /** A search is active: columns show every match and empty ones say "no matches". */
  filtered: boolean;
  /** Days without a reply before a job moves to No response (Settings). */
  noResponseDays: number;
}) {
  const change = useDashboardChangeStatus();
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);

  const sensors = useSensors(
    useSensor(BoardPointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(BoardTouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { keyboardCodes: KEYBOARD_CODES, coordinateGetter: columnCoordinates }),
  );

  // Bridge the gap between drop and the optimistic cache update so the card
  // never flashes back into its old column.
  const grouped = useMemo(() => {
    const move = pending && pending.base === jobs ? pending : null;
    const list = move
      ? jobs.map((j) => (j.id === move.id ? { ...j, status: move.to, lastActivityAt: move.at } : j))
      : jobs;
    return groupByStage(list);
  }, [jobs, pending]);

  const jobOf = (id: UniqueIdentifier) => jobs.find((j) => j.id === id);
  const stageLabelOf = (job: Job | undefined) => columnLabel(job ? stageOf(job.status) : undefined);

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${jobOf(active.id)?.company ?? "job"}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `Moved over ${columnLabel(over.id)}.`
        : `${jobOf(active.id)?.company ?? "The job"} is no longer over a column.`,
    onDragEnd: ({ active, over }) => {
      const job = jobOf(active.id);
      if (!over) return `Dropped. ${job?.company ?? "The job"} stays in ${stageLabelOf(job)}.`;
      return job && over.id === stageOf(job.status)
        ? `Dropped in ${columnLabel(over.id)}. Status unchanged.`
        : `Dropped in ${columnLabel(over.id)}.`;
    },
    onDragCancel: ({ active }) => {
      const job = jobOf(active.id);
      return `Cancelled. ${job?.company ?? "The job"} stays in ${stageLabelOf(job)}.`;
    },
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    setActiveJob((active.data.current?.job as Job | undefined) ?? null);
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveJob(null);
    const job = active.data.current?.job as Job | undefined;
    const stage = over?.id as Stage | undefined;
    // Same column = no change (a "no response" job stays as it is inside Closed).
    if (!job || !stage || stage === stageOf(job.status)) return;
    const to = STAGE_META[stage].dropStatus;
    setPending({ id: job.id, to, at: new Date().toISOString(), base: jobs });
    change(job, to);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveJob(null)}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            "Press Enter to open the job. To change its status, press Space to pick it up, use the left and right arrow keys to move between columns, and press Space again to drop it. Press Escape to cancel.",
        },
      }}
    >
      <BoardScroller label="Applications board">
        {STAGES.map((stage) => (
          <BoardColumn
            key={stage}
            stage={stage}
            jobs={grouped[stage]}
            onOpen={onOpen}
            filtered={filtered}
            noResponseDays={noResponseDays}
            dragFrom={activeJob ? stageOf(activeJob.status) : null}
          />
        ))}
      </BoardScroller>
      <DragOverlay dropAnimation={null}>
        {activeJob ? (
          <JobCard job={activeJob} overlay noResponseDays={noResponseDays} className="w-60" />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/* -------------------------------------------------------------- column */

function ColumnHeader({
  stage,
  count,
  action,
}: {
  stage: Stage;
  count: number;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-3 flex h-10 shrink-0 items-center gap-2 border-b-2 px-1">
      <StageIcon stage={stage} />
      <h3 id={`board-col-${stage}`} className="text-[15px] leading-5 font-semibold">
        {STAGE_META[stage].label}
      </h3>
      <span className="text-meta text-muted-foreground tabular">
        {count}
        <span className="sr-only"> {count === 1 ? "job" : "jobs"}</span>
      </span>
      {action && <div className="ml-auto flex items-center">{action}</div>}
    </header>
  );
}

function AddButton({ status }: { status: "saved" | "applied" }) {
  const { openAddJob } = useAddJob();
  const label = status === "saved" ? "Add a saved job" : "Add an applied job";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground pointer-coarse:size-9"
          aria-label={label}
          onClick={() => openAddJob({ status })}
        >
          <Plus aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function EmptySlot({ children, active }: { children: React.ReactNode; active?: boolean }) {
  return (
    <p
      className={cn(
        "flex min-h-16 items-center justify-center rounded-lg border border-dashed px-3 text-center text-xs text-muted-foreground transition-colors duration-150",
        active && "border-foreground/30 text-foreground",
      )}
    >
      {children}
    </p>
  );
}

function BoardColumn({
  stage,
  jobs,
  onOpen,
  filtered,
  noResponseDays,
  dragFrom,
}: {
  stage: Stage;
  jobs: Job[];
  onOpen: (id: string) => void;
  filtered: boolean;
  noResponseDays: number;
  dragFrom: Stage | null;
}) {
  const meta = STAGE_META[stage];
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const isTarget = isOver && dragFrom !== stage;
  const [expanded, setExpanded] = useState(false);

  // A search shows every match: nothing it found hides behind "Show more".
  const folds = stage !== "closed" && !filtered && jobs.length > COLUMN_LIMIT;
  const visible = folds && !expanded ? jobs.slice(0, COLUMN_LIMIT) : jobs;
  const hidden = jobs.length - visible.length;

  return (
    <section
      ref={setNodeRef}
      aria-labelledby={`board-col-${stage}`}
      className={cn(COLUMN_CLASS, "transition-colors duration-150", isTarget && "bg-muted/70")}
    >
      <ColumnHeader
        stage={stage}
        count={jobs.length}
        action={stage === "saved" || stage === "applied" ? <AddButton status={stage} /> : undefined}
      />
      <div className="flex flex-1 flex-col gap-3 pb-2">
        {stage === "closed" ? (
          <>
            <ClosedGroup status="rejected" jobs={jobs} onOpen={onOpen} filtered={filtered} />
            <ClosedGroup status="no_response" jobs={jobs} onOpen={onOpen} filtered={filtered} />
          </>
        ) : (
          visible.map((job) => (
            <DraggableCard key={job.id} job={job} onOpen={onOpen} noResponseDays={noResponseDays} />
          ))
        )}
        {jobs.length === 0 && (
          <EmptySlot active={isTarget}>
            {isTarget
              ? stage === "closed"
                ? "Drop to mark as rejected"
                : `Drop to move to ${meta.label}`
              : filtered
                ? "No matches"
                : `Nothing here yet · ${meta.description.toLowerCase()}`}
          </EmptySlot>
        )}
        {folds && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className={cn(LINK_BUTTON, "self-start px-1")}
          >
            {hidden > 0 ? `Show ${hidden} more` : "Show fewer"}
          </button>
        )}
      </div>
    </section>
  );
}

function DraggableCard({
  job,
  onOpen,
  noResponseDays,
}: {
  job: Job;
  onOpen: (id: string) => void;
  noResponseDays: number;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: job.id,
    data: { job },
  });
  return (
    <JobCard
      job={job}
      onOpen={onOpen}
      noResponseDays={noResponseDays}
      dnd={{ setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging }}
    />
  );
}

/* -------------------------------------------------------------- closed */

/**
 * Closed applications are the quietest thing on the board: one card per
 * outcome (Rejected, No response) holding compact rows, newest first.
 */
function ClosedGroup({
  status,
  jobs,
  onOpen,
  filtered,
}: {
  status: "rejected" | "no_response";
  /** Every job in the Closed column; the group picks its own. */
  jobs: Job[];
  onOpen: (id: string) => void;
  filtered: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = jobs.filter((j) => j.status === status);
  if (rows.length === 0) return null;

  const meta = STATUS_META[status];
  const Icon = meta.icon;
  const folds = !filtered && rows.length > CLOSED_LIMIT;
  const visible = folds && !expanded ? rows.slice(0, CLOSED_LIMIT) : rows;
  const titleId = `board-closed-${status}`;

  return (
    <section aria-labelledby={titleId} className="rounded-lg border bg-card px-3 pt-1">
      <header className="flex h-9 items-center gap-2 whitespace-nowrap">
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <h4 id={titleId} className="truncate text-meta font-semibold">
          {meta.label}
        </h4>
        <span className="text-xs text-muted-foreground tabular">
          {rows.length}
          <span className="sr-only"> {rows.length === 1 ? "job" : "jobs"}</span>
        </span>
        {folds && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className={cn(LINK_BUTTON, "ml-auto text-xs")}
          >
            {expanded ? "Show fewer" : "Show all"}
          </button>
        )}
      </header>
      <ul className="-mx-3 divide-y border-t">
        {visible.map((job) => (
          <ClosedRow key={job.id} job={job} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

function closedLine(job: Job) {
  const date = formatDate(statusSince(job));
  return job.status === "rejected" ? `Rejected ${date}` : `No reply by ${date}`;
}

function ClosedRow({ job, onOpen }: { job: Job; onOpen: (id: string) => void }) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: job.id,
    data: { job },
  });
  const dnd: JobCardDnd = { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging };
  const line = closedLine(job);

  return (
    <li
      ref={setNodeRef}
      {...listeners}
      className={cn(
        "group/card relative px-3 py-2.5 select-none transition-[background-color,opacity] duration-150 last:rounded-b-lg",
        "touch-manipulation [-webkit-touch-callout:none] hover:bg-muted/50 has-[[data-card-open]:focus-visible]:bg-muted/50",
        isDragging && "opacity-40",
      )}
    >
      <OpenOverlay
        job={job}
        dnd={dnd}
        onOpen={onOpen}
        label={`${job.company}, ${job.title}. ${priorityNote(job.priority)}${line}`}
      />
      <p className="flex min-w-0 items-center gap-1.5 pr-6 text-meta font-semibold">
        <span className="truncate" title={job.company}>
          {job.company}
        </span>
        <PriorityMark priority={job.priority} className="relative z-10" onClick={() => onOpen(job.id)} />
      </p>
      <p className="mt-0.5 text-xs leading-4 text-muted-foreground tabular">
        {job.title}. {line}
      </p>
      <JobActionsMenu
        job={job}
        className={cn(
          "absolute top-1.5 right-1.5 bg-transparent hover:bg-muted",
          REVEAL_ON_HOVER,
          "group-hover/card:opacity-100 group-has-[[data-card-open]:focus-visible]/card:opacity-100",
        )}
      />
    </li>
  );
}

/* ------------------------------------------------------------ skeleton */

const SKELETON_CARDS: Record<Stage, number> = { saved: 3, applied: 4, interview: 3, offer: 1, closed: 2 };

export function BoardSkeleton() {
  return (
    <BoardScroller label="Loading board">
      {STAGES.map((stage) => (
        <div key={stage} className={COLUMN_CLASS} aria-hidden>
          <div className="mb-3 flex h-10 items-center gap-2 border-b-2 px-1">
            <span className="h-3.5 w-16 animate-pulse rounded bg-muted" />
          </div>
          <div className="flex flex-col gap-3 pb-2">
            {Array.from({ length: SKELETON_CARDS[stage] }, (_, k) => (
              <JobCardSkeleton key={k} />
            ))}
          </div>
        </div>
      ))}
    </BoardScroller>
  );
}
