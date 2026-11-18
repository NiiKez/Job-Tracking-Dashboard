"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { STATUSES, type Status } from "@/lib/types";

export type DashboardView = "board" | "list";
export type ListSort = "next" | "activity" | "added" | "company";

export const SORT_OPTIONS: Array<{ value: ListSort; label: string }> = [
  { value: "next", label: "Next step first" },
  { value: "activity", label: "Last activity" },
  { value: "added", label: "Date added" },
  { value: "company", label: "Company A–Z" },
];

/* ------------------------------------------------ remembered view (localStorage) */

const VIEW_KEY = "jt:view";
const VIEW_EVENT = "jt:view-change";

function readStoredView(): DashboardView | null {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    return v === "board" || v === "list" ? v : null;
  } catch {
    return null;
  }
}

function writeStoredView(view: DashboardView) {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Storage blocked (private mode): the URL still carries the view.
  }
  window.dispatchEvent(new Event(VIEW_EVENT));
}

function subscribeView(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(VIEW_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(VIEW_EVENT, onChange);
  };
}

/* ------------------------------------------------------------- URL helpers */

export function parseStatuses(raw: string | null): Status[] {
  if (!raw) return [];
  const wanted = new Set(raw.split(","));
  return STATUSES.filter((s) => wanted.has(s));
}

/** "?q=x&status=applied,interview" — commas kept readable. */
function toSearch(params: URLSearchParams) {
  const qs = params.toString().replace(/%2C/gi, ",");
  return qs ? `?${qs}` : "";
}

type ParamPatch = Partial<Record<"q" | "status" | "view" | "sort" | "job", string | null>>;

/**
 * Dashboard state that lives in the URL:
 * `?q=…&status=applied,interview&view=board|list&sort=activity|added|company&job=<id>`.
 *
 * The board is the default view; the last view the user picked is remembered.
 *
 * Updates use `history.replaceState`, which Next.js integrates with the router
 * (useSearchParams re-renders) without a server round-trip per keystroke.
 */
export function useDashboardParams() {
  const searchParams = useSearchParams();
  const storedView = useSyncExternalStore(subscribeView, readStoredView, () => null);

  const q = (searchParams.get("q") ?? "").trim();
  const statusRaw = searchParams.get("status");
  const statuses = useMemo(() => parseStatuses(statusRaw), [statusRaw]);
  const viewParam = searchParams.get("view");
  const view: DashboardView =
    viewParam === "board" || viewParam === "list" ? viewParam : (storedView ?? "board");
  const sortParam = searchParams.get("sort");
  const sort: ListSort =
    sortParam === "activity" || sortParam === "added" || sortParam === "company" ? sortParam : "next";
  const jobId = searchParams.get("job");

  const setParams = useCallback((patch: ParamPatch) => {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    window.history.replaceState(null, "", `${window.location.pathname}${toSearch(next)}`);
  }, []);

  const setStatuses = useCallback(
    (next: Status[]) => {
      const ordered = STATUSES.filter((s) => next.includes(s));
      setParams({ status: ordered.length ? ordered.join(",") : null });
    },
    [setParams],
  );

  const toggleStatus = useCallback(
    (status: Status) => {
      setStatuses(
        statuses.includes(status) ? statuses.filter((s) => s !== status) : [...statuses, status],
      );
    },
    [statuses, setStatuses],
  );

  const setView = useCallback(
    (next: DashboardView) => {
      writeStoredView(next);
      setParams({ view: next });
    },
    [setParams],
  );

  const setSort = useCallback(
    (next: ListSort) => setParams({ sort: next === "next" ? null : next }),
    [setParams],
  );

  const openJob = useCallback((id: string) => setParams({ job: id }), [setParams]);
  const closeJob = useCallback(() => setParams({ job: null }), [setParams]);

  return {
    q,
    statuses,
    view,
    sort,
    jobId,
    setParams,
    setStatuses,
    toggleStatus,
    setView,
    setSort,
    openJob,
    closeJob,
  };
}
