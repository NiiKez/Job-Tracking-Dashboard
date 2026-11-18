"use client";

import { createContext, useContext } from "react";
import { useChangeStatus } from "@/components/jobs/status-menu";

type ChangeStatus = ReturnType<typeof useChangeStatus>;

const ChangeStatusContext = createContext<ChangeStatus | null>(null);

/**
 * TanStack Query skips `mutate(…, { onSuccess })` callbacks once the calling
 * component unmounts — and a card unmounts as soon as the optimistic update
 * moves it to another column, which would swallow the "Moved to … / Undo"
 * toast. Owning the mutation here (the dashboard never unmounts mid-change)
 * keeps the toast reliable for drag & drop and "Mark applied".
 */
export function ChangeStatusProvider({ children }: { children: React.ReactNode }) {
  const change = useChangeStatus();
  return <ChangeStatusContext.Provider value={change}>{children}</ChangeStatusContext.Provider>;
}

export function useDashboardChangeStatus(): ChangeStatus {
  const fromDashboard = useContext(ChangeStatusContext);
  const local = useChangeStatus();
  return fromDashboard ?? local;
}
