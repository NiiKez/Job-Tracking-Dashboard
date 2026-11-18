import { BoardSkeleton } from "./board-view";
import { DashboardHeaderSkeleton } from "./dashboard-header";
import { KpiRowSkeleton } from "./kpi-row";

/** Shared padded frame for the dashboard body (also used by the fallback). */
export const DASHBOARD_FRAME = "@container flex min-w-0 flex-col gap-5 px-4 pt-5 pb-8 sm:px-6";

/** Suspense fallback: reserves the space of header + KPI row + board (the default view). */
export function DashboardSkeleton() {
  return (
    <div className={DASHBOARD_FRAME} aria-busy="true" aria-label="Loading applications">
      <DashboardHeaderSkeleton />
      <KpiRowSkeleton />
      <BoardSkeleton />
    </div>
  );
}
