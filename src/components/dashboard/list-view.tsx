"use client";

import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { PriorityMark } from "@/components/jobs/priority";
import { RelativeTime } from "@/components/jobs/relative-time";
import { compareInStage, groupByStage, STAGE_META, STAGES, type Stage } from "@/lib/stages";
import type { Job } from "@/lib/types";
import { cn } from "@/lib/utils";
import { JobActionsMenu, REVEAL_ON_HOVER, StageMeta } from "./job-meta";
import { StageIcon } from "./stage-icon";
import type { ListSort } from "./use-dashboard-params";

const COMPARE: Record<ListSort, (a: Job, b: Job) => number> = {
  next: compareInStage,
  activity: (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt),
  added: (a, b) => b.createdAt.localeCompare(a.createdAt),
  company: (a, b) =>
    a.company.localeCompare(b.company, undefined, { sensitivity: "base" }) ||
    a.title.localeCompare(b.title),
};

/** Same stages as the board. */
function useGroups(jobs: Job[], sort: ListSort) {
  return useMemo(() => {
    const groups = groupByStage(jobs, COMPARE[sort]);
    return STAGES.map((stage) => ({ stage, jobs: groups[stage] })).filter((g) => g.jobs.length > 0);
  }, [jobs, sort]);
}

const isQuiet = (job: Job) => job.status === "rejected" || job.status === "no_response";

/** The menu sits on a row that may be tinted on hover: no own background. */
const ROW_MENU = cn(
  REVEAL_ON_HOVER,
  "bg-transparent hover:bg-muted group-hover/row:opacity-100 group-has-[[data-row-open]:focus-visible]/row:opacity-100",
);

/* ---------------------------------------------------------- group header */

/**
 * The stage's band: a full-width grey bar with the stage glyph, name and
 * count. It is the only background in the list (rows are separated by
 * hairlines), so each stage reads as its own section at a glance.
 */
function GroupHeader({
  stage,
  count,
  open,
  onToggle,
  controls,
}: {
  stage: Stage;
  count: number;
  open: boolean;
  onToggle: () => void;
  controls?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md bg-muted px-2 text-left outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/25 pointer-coarse:h-11"
    >
      <ChevronRight
        aria-hidden
        className={cn(
          "-mr-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-150",
          open && "rotate-90",
        )}
      />
      <StageIcon stage={stage} />
      <span className="text-sm font-semibold">{STAGE_META[stage].label}</span>
      <span className="text-xs text-muted-foreground tabular">
        {count}
        <span className="sr-only"> {count === 1 ? "job" : "jobs"}</span>
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------- view */

/**
 * Jobs grouped by stage, read top-down. No container box: each stage opens
 * with a grey band, 24px of space sits between stages, and hairlines separate
 * the rows within one. The band sticks to the top while its rows scroll, so
 * you always know which stage you're in. Closed starts folded.
 */

/** The Applications header scrolls away, so the band sticks to the very top. */
const STICKY_BAND = "sticky top-0 z-10 bg-background";
export function ListView({
  jobs,
  sort,
  onOpen,
}: {
  jobs: Job[];
  sort: ListSort;
  onOpen: (id: string) => void;
}) {
  const groups = useGroups(jobs, sort);
  const [collapsed, setCollapsed] = useState<Partial<Record<Stage, boolean>>>({ closed: true });
  const toggle = (s: Stage) => setCollapsed((c) => ({ ...c, [s]: !c[s] }));

  return (
    <div>
      {/* Wide containers: one semantic table, a <tbody> per stage. */}
      <table className="hidden w-full border-collapse text-sm @2xl:table">
        <caption className="sr-only">Jobs grouped by stage</caption>
        <thead>
          <tr className="border-b text-left text-xs whitespace-nowrap text-muted-foreground">
            <th scope="col" className="h-8 py-0 pr-3 pl-1 font-normal">
              Company
            </th>
            <th scope="col" className="px-3 font-normal">
              Role
            </th>
            <th scope="col" className="px-3 font-normal">
              Where it stands
            </th>
            <th scope="col" className="hidden px-3 font-normal @5xl:table-cell">
              Location
            </th>
            <th scope="col" className="hidden px-3 font-normal @4xl:table-cell">
              Last activity
            </th>
            <th scope="col" className="w-10">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        {groups.map(({ stage, jobs: rows }, i) => {
          const open = !collapsed[stage];
          return (
            <tbody key={stage}>
              <tr>
                <th
                  scope="colgroup"
                  colSpan={6}
                  className={cn(STICKY_BAND, "p-0 pb-1 text-left font-normal", i === 0 ? "pt-3" : "pt-6")}
                >
                  <GroupHeader
                    stage={stage}
                    count={rows.length}
                    open={open}
                    onToggle={() => toggle(stage)}
                  />
                </th>
              </tr>
              {open && rows.map((job) => <TableRow key={job.id} job={job} onOpen={onOpen} />)}
            </tbody>
          );
        })}
      </table>

      {/* Narrow containers: stacked two-line rows, like the board cards. */}
      <div className="@2xl:hidden">
        {groups.map(({ stage, jobs: rows }, i) => {
          const open = !collapsed[stage];
          const id = `list-group-${stage}`;
          return (
            <section key={stage} aria-label={STAGE_META[stage].label}>
              <div className={cn(STICKY_BAND, "pb-1", i === 0 ? "pt-2" : "pt-5")}>
                <GroupHeader
                  stage={stage}
                  count={rows.length}
                  open={open}
                  onToggle={() => toggle(stage)}
                  controls={id}
                />
              </div>
              <ul id={id} hidden={!open} className="divide-y">
                {rows.map((job) => (
                  <StackedRow key={job.id} job={job} onOpen={onOpen} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- rows */

function TableRow({ job, onOpen }: { job: Job; onOpen: (id: string) => void }) {
  const quiet = isQuiet(job);
  return (
    <tr
      onClick={() => onOpen(job.id)}
      // The first row sits right under the band: no hairline (border or background, never both).
      className="group/row cursor-pointer border-t transition-colors duration-150 nth-2:border-t-0 hover:bg-muted/50 has-[[data-row-open]:focus-visible]:bg-muted/50"
    >
      <td className="h-12 py-0 pr-3 pl-1 align-middle">
        <div className="flex max-w-48 items-center gap-1.5 @4xl:max-w-64">
          <button
            type="button"
            data-row-open
            className={cn(
              "block min-w-0 cursor-pointer truncate rounded-sm text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/25",
              job.status === "offer" ? "font-semibold" : "font-medium",
              quiet && "font-normal text-muted-foreground",
            )}
          >
            {job.company}
          </button>
          <PriorityMark priority={job.priority} />
        </div>
      </td>
      <td className="w-full max-w-0 px-3 align-middle text-muted-foreground">
        <span className="block truncate">{job.title}</span>
      </td>
      <td className="px-3 align-middle">
        <StageMeta job={job} className="max-w-72 text-meta leading-5" />
      </td>
      <td className="hidden px-3 align-middle text-muted-foreground @5xl:table-cell">
        <span className="block max-w-44 truncate">
          {job.location || (
            <>
              <span aria-hidden>—</span>
              <span className="sr-only">No location</span>
            </>
          )}
        </span>
      </td>
      <td className="hidden px-3 align-middle text-xs whitespace-nowrap text-muted-foreground @4xl:table-cell">
        <RelativeTime iso={job.lastActivityAt} className="tabular" />
      </td>
      <td className="pr-1 pl-2 align-middle">
        <JobActionsMenu job={job} className={ROW_MENU} />
      </td>
    </tr>
  );
}

function StackedRow({ job, onOpen }: { job: Job; onOpen: (id: string) => void }) {
  const quiet = isQuiet(job);
  return (
    <li className="group/row relative flex items-center gap-2 py-2.5 pl-1 transition-colors duration-150 hover:bg-muted/50 has-[[data-row-open]:focus-visible]:bg-muted/50">
      <div className="min-w-0 flex-1">
        <button
          type="button"
          data-row-open
          onClick={() => onOpen(job.id)}
          className="block w-full cursor-pointer truncate text-left text-sm leading-5 outline-none after:absolute after:inset-0"
        >
          <span className={cn("font-medium", quiet && "font-normal text-muted-foreground")}>
            {job.company}
          </span>
          <PriorityMark priority={job.priority} tooltip={false} className="ml-1.5 align-[-2px]" />
          <span className="text-muted-foreground"> · {job.title}</span>
        </button>
        <StageMeta job={job} className="mt-0.5" />
      </div>
      <JobActionsMenu job={job} className={ROW_MENU} />
    </li>
  );
}

/* ------------------------------------------------------------ skeleton */

export function ListSkeleton() {
  return (
    <div aria-hidden>
      <div className="h-8 border-b" />
      {[3, 5, 2].map((rows, g) => (
        <div key={g} className={g === 0 ? "pt-3" : "pt-6"}>
          <div className="mb-1 flex h-9 items-center gap-2 rounded-md bg-muted px-2">
            <span className="h-3.5 w-20 animate-pulse rounded bg-foreground/10" />
          </div>
          {Array.from({ length: rows }, (_, r) => (
            <div key={r} className="flex h-12 items-center gap-4 border-t px-1 nth-2:border-t-0">
              <span className="h-3.5 w-28 animate-pulse rounded bg-muted" />
              <span className="h-3.5 flex-1 animate-pulse rounded bg-muted" />
              <span className="hidden h-3 w-32 animate-pulse rounded bg-muted sm:block" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
