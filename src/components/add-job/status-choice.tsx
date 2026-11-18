"use client";

import { Bookmark, Send, type LucideIcon } from "lucide-react";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";

export type CaptureStatus = "saved" | "applied";

const CHOICES: Array<{ value: CaptureStatus; title: string; hint: string; icon: LucideIcon }> = [
  { value: "saved", title: "Saved", hint: "I haven't applied yet", icon: Bookmark },
  { value: "applied", title: "Applied", hint: "I've sent my application", icon: Send },
];

/** Two large selectable cards: where the job goes on the dashboard. */
export function StatusChoice({
  value,
  onChange,
  idPrefix,
}: {
  value: CaptureStatus;
  onChange: (value: CaptureStatus) => void;
  idPrefix: string;
}) {
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label" className="mb-0">
        Where does it go?
      </FieldLegend>
      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as CaptureStatus)}
        className="grid grid-cols-2 gap-2 sm:gap-3"
      >
        {CHOICES.map((c) => {
          const meta = STATUS_META[c.value];
          const Icon = c.icon;
          const id = `${idPrefix}-status-${c.value}`;
          const checked = value === c.value;
          return (
            <label
              key={c.value}
              htmlFor={id}
              className={cn(
                "relative flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 transition-colors duration-150",
                "hover:bg-muted/50 has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                checked && "border-primary bg-primary/5 hover:bg-primary/5 dark:bg-primary/10",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-md",
                  meta.badgeClass,
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{c.title}</span>
                <span className="block text-xs leading-snug text-muted-foreground">{c.hint}</span>
              </span>
              <RadioGroupItem value={c.value} id={id} className="mt-0.5" />
            </label>
          );
        })}
      </RadioGroup>
    </FieldSet>
  );
}
