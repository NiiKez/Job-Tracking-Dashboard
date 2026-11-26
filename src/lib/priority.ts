import { DEFAULT_PRIORITY, PRIORITIES, type Priority } from "./types";

/*
 * How a priority reads in the UI. The glyph (components/jobs/priority.tsx)
 * shows it as filled bars; these labels always go with it, so colour never
 * carries the meaning alone.
 */

export interface PriorityMeta {
  value: Priority;
  /** "High", in pickers and the detail view. */
  label: string;
  /** "High priority", for tooltips and screen readers. */
  long: string;
  /** Filled bars of three. */
  bars: 1 | 2 | 3;
}

export const PRIORITY_META: Record<Priority, PriorityMeta> = {
  high: { value: "high", label: "High", long: "High priority", bars: 3 },
  medium: { value: "medium", label: "Medium", long: "Medium priority", bars: 2 },
  low: { value: "low", label: "Low", long: "Low priority", bars: 1 },
};

/** Medium is the default: cards and rows only mark jobs that differ from it. */
export function isMarkedPriority(p: Priority) {
  return p !== DEFAULT_PRIORITY;
}

/**
 * "High priority. " for a card's or row's spoken name, empty for Medium (the
 * default isn't shown, so it isn't spoken either).
 */
export function priorityNote(p: Priority) {
  return isMarkedPriority(p) ? `${PRIORITY_META[p].long}. ` : "";
}

export function parsePriorities(raw: string | null): Priority[] {
  if (!raw) return [];
  const wanted = new Set(raw.split(","));
  return PRIORITIES.filter((p) => wanted.has(p));
}
