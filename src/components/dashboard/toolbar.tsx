"use client";

import {
  ArrowUpDown,
  ChevronDown,
  Columns3,
  ListFilter,
  Loader2,
  Rows3,
  Search,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PriorityIcon } from "@/components/jobs/priority";
import { PRIORITY_META } from "@/lib/priority";
import { STATUS_META } from "@/lib/status";
import { PRIORITIES, STATUSES, type Priority, type Stats, type Status } from "@/lib/types";
import { cn } from "@/lib/utils";
import { SORT_OPTIONS, type DashboardView, type ListSort } from "./use-dashboard-params";

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/* Controls are 40px tall on touch screens, 36px with a mouse. */
const CONTROL_H = "h-9 pointer-coarse:h-10";

/* ---------------------------------------------------------------- search */

export function SearchField({
  value,
  onChange,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" focuses the search from anywhere on the page (unless already typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target) || document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <InputGroup role="search" className={cn(CONTROL_H, "min-w-0 flex-1 bg-background @3xl:max-w-64")}>
      <InputGroupAddon>
        {busy ? (
          <Loader2 aria-hidden className="animate-spin" />
        ) : (
          <Search aria-hidden />
        )}
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          if (value) onChange("");
          else e.currentTarget.blur();
        }}
        placeholder="Search company or title"
        aria-label="Search jobs by company or title"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
      />
      <InputGroupAddon align="inline-end">
        {value ? (
          <InputGroupButton
            size="icon-xs"
            aria-label="Clear search"
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            className="pointer-coarse:size-8"
          >
            <X aria-hidden />
          </InputGroupButton>
        ) : (
          <Kbd className="hidden @lg:inline-flex" aria-hidden>
            /
          </Kbd>
        )}
      </InputGroupAddon>
    </InputGroup>
  );
}

/* --------------------------------------------------------------- filters */

interface FilterOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

/**
 * A multi-select filter in a popover: one checkbox per value, a count of all
 * jobs beside each, and its own clear button. The trigger shows how many
 * values are on.
 */
function FilterPopover<T extends string>({
  name,
  heading,
  groupLabel,
  options,
  selected,
  counts,
  onToggle,
  onClear,
}: {
  /** "Status", "Priority": the trigger's text and the labels built from it. */
  name: string;
  /** "Show jobs that are…" */
  heading: string;
  /** Names the checkbox group: "Statuses". */
  groupLabel: string;
  options: Array<FilterOption<T>>;
  selected: T[];
  counts: Partial<Record<T, number>> | undefined;
  onToggle: (value: T) => void;
  onClear: () => void;
}) {
  const active = selected.length;
  const lower = name.toLowerCase();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(CONTROL_H, "gap-1.5 bg-background", active > 0 && "border-foreground/40")}
          aria-label={active ? `${name} filter, ${active} selected` : `Filter by ${lower}`}
        >
          <ListFilter aria-hidden className="text-muted-foreground" />
          {name}
          {active > 0 && (
            <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground tabular">
              {active}
            </span>
          )}
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 gap-0 p-1">
        <p className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{heading}</p>
        <div role="group" aria-label={groupLabel}>
          {options.map((o) => {
            const checked = selected.includes(o.value);
            return (
              <label
                key={o.value}
                className="flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm transition-colors duration-150 hover:bg-muted"
              >
                <Checkbox checked={checked} onCheckedChange={() => onToggle(o.value)} />
                {o.icon}
                <span className="flex-1">{o.label}</span>
                <span className="text-xs text-muted-foreground tabular">{counts?.[o.value] ?? ""}</span>
              </label>
            );
          })}
        </div>
        <Separator className="my-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-full justify-start text-muted-foreground"
          disabled={active === 0}
          onClick={onClear}
        >
          <X aria-hidden />
          Clear {lower} filter
        </Button>
      </PopoverContent>
    </Popover>
  );
}

const STATUS_OPTIONS: Array<FilterOption<Status>> = STATUSES.map((s) => ({
  value: s,
  label: STATUS_META[s].label,
}));

const PRIORITY_OPTIONS: Array<FilterOption<Priority>> = PRIORITIES.map((p) => ({
  value: p,
  label: PRIORITY_META[p].label,
  icon: <PriorityIcon priority={p} />,
}));

/* ------------------------------------------------------------ view + sort */

const VIEWS: Array<{ value: DashboardView; label: string; icon: typeof Columns3 }> = [
  { value: "board", label: "Board", icon: Columns3 },
  { value: "list", label: "Table", icon: Rows3 },
];

/** Board / Table as a segmented control: the selected side is raised. */
export function ViewToggle({
  view,
  onChange,
}: {
  view: DashboardView;
  onChange: (v: DashboardView) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      value={view}
      onValueChange={(v) => v && onChange(v as DashboardView)}
      aria-label="Layout"
      className="shrink-0 gap-0.5 bg-muted p-0.5"
    >
      {VIEWS.map(({ value, label, icon: Icon }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={`${label} view`}
          className="h-8 gap-1.5 rounded-md px-2.5 text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs pointer-coarse:h-9"
        >
          <Icon aria-hidden />
          <span className="hidden @lg:inline">{label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function SortSelect({ sort, onChange }: { sort: ListSort; onChange: (s: ListSort) => void }) {
  return (
    <Select value={sort} onValueChange={(v) => onChange(v as ListSort)}>
      <SelectTrigger
        aria-label="Sort jobs in each group"
        className={cn(CONTROL_H, "gap-1.5 bg-background data-[size=default]:h-9 pointer-coarse:data-[size=default]:h-10")}
      >
        <ArrowUpDown aria-hidden className="text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        {SORT_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* ------------------------------------------------------- pipeline controls */

/**
 * The row above the pipeline. The priority filter works on both views; the
 * status filter and the sort order only on the table (the board is already
 * grouped by status, and higher priority leads each column).
 */
export function PipelineControls({
  view,
  statuses,
  statusCounts,
  onToggleStatus,
  onClearStatuses,
  priorities,
  priorityCounts,
  onTogglePriority,
  onClearPriorities,
  sort,
  onSortChange,
  hasFilters,
  onClearFilters,
  resultCount,
  total,
}: {
  view: DashboardView;
  statuses: Status[];
  statusCounts: Stats["byStatus"] | undefined;
  onToggleStatus: (s: Status) => void;
  onClearStatuses: () => void;
  priorities: Priority[];
  priorityCounts: Record<Priority, number> | undefined;
  onTogglePriority: (p: Priority) => void;
  onClearPriorities: () => void;
  sort: ListSort;
  onSortChange: (s: ListSort) => void;
  hasFilters: boolean;
  onClearFilters: () => void;
  resultCount: number | null;
  total: number | null;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {view === "list" && (
        <FilterPopover
          name="Status"
          heading="Show jobs that are…"
          groupLabel="Statuses"
          options={STATUS_OPTIONS}
          selected={statuses}
          counts={statusCounts}
          onToggle={onToggleStatus}
          onClear={onClearStatuses}
        />
      )}
      <FilterPopover
        name="Priority"
        heading="Show jobs with priority…"
        groupLabel="Priorities"
        options={PRIORITY_OPTIONS}
        selected={priorities}
        counts={priorityCounts}
        onToggle={onTogglePriority}
        onClear={onClearPriorities}
      />
      {hasFilters && (
        <Button
          variant="ghost"
          className={cn(CONTROL_H, "gap-1.5 px-2.5 text-muted-foreground")}
          onClick={onClearFilters}
        >
          <X aria-hidden />
          <span className="hidden @lg:inline">Clear filters</span>
          <span className="@lg:hidden">Clear</span>
        </Button>
      )}
      {hasFilters && resultCount !== null && total !== null && (
        <p
          aria-live="polite"
          className="hidden text-xs whitespace-nowrap text-muted-foreground tabular @2xl:block"
        >
          {resultCount} of {total}
        </p>
      )}
      {view === "list" && (
        <div className="ml-auto">
          <SortSelect sort={sort} onChange={onSortChange} />
        </div>
      )}
    </div>
  );
}
