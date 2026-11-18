"use client";

import { ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import { CompanyAvatar } from "@/components/jobs/company-avatar";
import { StatusDot } from "@/components/jobs/status-badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { STATUS_META } from "@/lib/status";
import type { Job } from "@/lib/types";
import { cn } from "@/lib/utils";

function JobOption({ job }: { job: Job }) {
  return (
    <>
      <CompanyAvatar company={job.company} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{job.company}</span>
        <span className="block truncate text-xs text-muted-foreground">{job.title}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <StatusDot status={job.status} />
        <span className="max-sm:sr-only">{STATUS_META[job.status].label}</span>
      </span>
    </>
  );
}

/**
 * Searchable job picker (Popover + Command). Suggested jobs come first,
 * then every application sorted by company.
 */
export function JobCombobox({
  id,
  jobs,
  suggestedIds,
  value,
  onChange,
  disabled,
  invalid,
  "aria-describedby": describedBy,
}: {
  id?: string;
  jobs: Job[];
  suggestedIds: string[];
  value: string;
  onChange: (jobId: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  "aria-describedby"?: string;
}) {
  const [open, setOpen] = useState(false);

  const { selected, suggested, rest } = useMemo(() => {
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const suggested = suggestedIds.map((sid) => byId.get(sid)).filter((j): j is Job => !!j);
    const rest = jobs
      .filter((j) => !suggestedIds.includes(j.id))
      .sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title));
    return { selected: byId.get(value), suggested, rest };
  }, [jobs, suggestedIds, value]);

  const pick = (jobId: string) => {
    onChange(jobId);
    setOpen(false);
  };

  const item = (job: Job) => (
    <CommandItem
      key={job.id}
      value={job.id}
      keywords={[job.company, job.title]}
      data-checked={job.id === value}
      onSelect={() => pick(job.id)}
      className="cursor-pointer gap-2.5"
    >
      <JobOption job={job} />
    </CommandItem>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          disabled={disabled}
          className="h-10 w-full min-w-0 justify-between gap-2 px-2.5 font-normal sm:h-8"
        >
          {selected ? (
            <span className="flex min-w-0 items-center gap-2">
              <CompanyAvatar company={selected.company} size="sm" className="size-5 text-[9px]" />
              <span className="truncate">
                <span className="font-medium">{selected.company}</span>
                <span className="text-muted-foreground"> · {selected.title}</span>
              </span>
            </span>
          ) : (
            <span className="truncate text-muted-foreground">Choose application</span>
          )}
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn("w-(--radix-popover-trigger-width) min-w-[min(20rem,calc(100vw-2rem))] p-0")}
      >
        <Command>
          <CommandInput placeholder="Search company or title" aria-label="Search applications" />
          <CommandList>
            <CommandEmpty>No application found.</CommandEmpty>
            {suggested.length > 0 && <CommandGroup heading="Suggested">{suggested.map(item)}</CommandGroup>}
            <CommandGroup heading="All applications">{rest.map(item)}</CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
