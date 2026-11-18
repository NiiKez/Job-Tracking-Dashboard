"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { STATUS_META } from "@/lib/status";
import { STATUSES, type Status } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Status picker: icon in the status color + label (never color alone). */
export function StatusSelect({
  id,
  value,
  onValueChange,
  disabled,
  invalid,
  placeholder = "Choose status",
  className,
  "aria-describedby": describedBy,
}: {
  id?: string;
  value: Status | "";
  onValueChange: (status: Status) => void;
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
  className?: string;
  "aria-describedby"?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onValueChange(v as Status)} disabled={disabled}>
      <SelectTrigger
        id={id}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn("h-10 w-full bg-background sm:h-8", className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {STATUSES.map((s) => {
          const meta = STATUS_META[s];
          const Icon = meta.icon;
          return (
            <SelectItem key={s} value={s} className="h-9 sm:h-8">
              <Icon aria-hidden className={cn("size-4", meta.textClass)} />
              {meta.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
