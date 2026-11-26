"use client";

import { useEffect, useMemo, useState } from "react";
import { useJobs, useReviewEmails, useSettings, useStats } from "@/lib/api/hooks";
import { PRIORITIES, type Job, type Priority } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useHydrated } from "@/hooks/use-hydrated";
import { BoardSkeleton, BoardView } from "./board-view";
import { ChangeStatusProvider } from "./change-status-context";
import { DashboardHeader } from "./dashboard-header";
import { DASHBOARD_FRAME } from "./dashboard-skeleton";
import { EmptyDashboard, LoadError, NoResults } from "./dashboard-states";
import { JobSheet } from "./job-sheet";
import { KpiRow } from "./kpi-row";
import { ListSkeleton, ListView } from "./list-view";
import { ReviewBanner } from "./review-banner";
import { PipelineControls, SearchField, ViewToggle } from "./toolbar";
import { useDashboardParams } from "./use-dashboard-params";

/**
 * The Applications dashboard: header, the KPI row (waiting for a reply, weekly
 * pace, reply rate, interviews, the sent-to-offer funnel), emails that need a
 * decision, then the pipeline as a board or a table. Filters, view and the
 * open job live in the URL.
 */
export function Dashboard() {
  const {
    q,
    statuses,
    priorities,
    view,
    sort,
    jobId,
    setParams,
    setStatuses,
    toggleStatus,
    setPriorities,
    togglePriority,
    setView,
    setSort,
    openJob,
    closeJob,
  } = useDashboardParams();

  // The input updates instantly; the URL (and the query) follow ~200ms later.
  const [search, setSearch] = useState(q);
  useEffect(() => {
    const next = search.trim();
    if (next === q) return;
    const t = window.setTimeout(() => setParams({ q: next || null }), 200);
    return () => window.clearTimeout(t);
  }, [search, q, setParams]);

  // The board is already grouped by status, so the status filter only applies to the list.
  const activeStatuses = view === "list" ? statuses : [];

  const hydrated = useHydrated();
  const stats = useStats();
  const settings = useSettings();
  const review = useReviewEmails();
  const all = useJobs();
  const jobs = useJobs({
    q: q || undefined,
    statuses: activeStatuses.length ? activeStatuses : undefined,
  });
  const statsData = hydrated ? stats.data : undefined;
  const allJobs = hydrated ? all.data : undefined;
  const settingsData = hydrated ? settings.data : undefined;
  const noResponseDays = settingsData?.noResponseDays ?? 30;

  const hasFilters = q !== "" || activeStatuses.length > 0 || priorities.length > 0;
  const clearFilters = () => {
    setSearch("");
    setParams({ q: null, status: null, priority: null });
  };

  // Priority is filtered here, on the jobs the server returned for the search and statuses.
  const fetched = hydrated ? jobs.data : undefined;
  const data = useMemo(
    () =>
      fetched && priorities.length
        ? fetched.filter((j) => priorities.includes(j.priority))
        : fetched,
    [fetched, priorities],
  );
  const priorityCounts = useMemo(() => countPriorities(allJobs), [allJobs]);
  const stale = jobs.isPlaceholderData || search.trim() !== q;
  const failed = !data && hydrated && jobs.isError;
  const empty = data?.length === 0 && !hasFilters && !jobs.isPlaceholderData;

  let body: React.ReactNode;
  if (failed) {
    body = (
      <LoadError
        message={jobs.error?.message}
        onRetry={() => void jobs.refetch()}
        retrying={jobs.isFetching}
      />
    );
  } else if (!data) {
    body = view === "board" ? <BoardSkeleton /> : <ListSkeleton />;
  } else if (empty) {
    body = <EmptyDashboard />;
  } else if (data.length === 0) {
    body = (
      <NoResults q={q} statuses={activeStatuses} priorities={priorities} onClear={clearFilters} />
    );
  } else if (view === "board") {
    body = (
      <BoardView
        jobs={data}
        onOpen={openJob}
        filtered={q !== "" || priorities.length > 0}
        noResponseDays={noResponseDays}
      />
    );
  } else {
    body = <ListView jobs={data} sort={sort} onOpen={openJob} />;
  }

  const total = allJobs?.length;

  return (
    <div className={DASHBOARD_FRAME}>
      <ChangeStatusProvider>
        <DashboardHeader total={total} inbox={settingsData?.inbox}>
          <SearchField
            value={search}
            onChange={setSearch}
            busy={hydrated && jobs.isFetching && stale}
          />
          <ViewToggle view={view} onChange={setView} />
        </DashboardHeader>

        {/* One error for one failure: when jobs can't load, only the pipeline says so. */}
        {!failed && !empty && total !== 0 && (
          <>
            <KpiRow jobs={allJobs} noResponseDays={noResponseDays} onOpen={openJob} />
            <ReviewBanner emails={hydrated ? review.data : undefined} />
          </>
        )}

        <section aria-label="All applications" className="flex min-w-0 flex-col gap-3">
          {!failed && !empty && total !== 0 && (
            <PipelineControls
              view={view}
              statuses={statuses}
              statusCounts={statsData?.byStatus}
              onToggleStatus={toggleStatus}
              onClearStatuses={() => setStatuses([])}
              priorities={priorities}
              priorityCounts={priorityCounts}
              onTogglePriority={togglePriority}
              onClearPriorities={() => setPriorities([])}
              sort={sort}
              onSortChange={setSort}
              hasFilters={hasFilters}
              onClearFilters={clearFilters}
              resultCount={data?.length ?? null}
              total={total ?? null}
            />
          )}
          <div
            aria-busy={hydrated && jobs.isFetching && stale}
            className={cn("min-w-0 transition-opacity duration-200", stale && data && "opacity-60")}
          >
            {body}
          </div>
        </section>
      </ChangeStatusProvider>
      <JobSheet jobId={jobId} onClose={closeJob} />
    </div>
  );
}

function countPriorities(jobs: Job[] | undefined): Record<Priority, number> | undefined {
  if (!jobs) return undefined;
  const out = Object.fromEntries(PRIORITIES.map((p) => [p, 0])) as Record<Priority, number>;
  for (const j of jobs) out[j.priority] += 1;
  return out;
}
