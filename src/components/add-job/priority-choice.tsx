"use client";

import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { PriorityIcon } from "@/components/jobs/priority";
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field";
import { PRIORITY_META } from "@/lib/priority";
import { PRIORITIES, type Priority } from "@/lib/types";

/**
 * High / Medium / Low as a segmented control (a radio group: arrow keys move
 * the choice). Medium is preselected; it can be changed later in the job.
 */
export function PriorityChoice({
  value,
  onChange,
  idPrefix,
}: {
  value: Priority;
  onChange: (value: Priority) => void;
  idPrefix: string;
}) {
  const hintId = `${idPrefix}-priority-hint`;
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label" className="mb-0">
        Priority
      </FieldLegend>
      <RadioGroupPrimitive.Root
        value={value}
        onValueChange={(v) => onChange(v as Priority)}
        orientation="horizontal"
        aria-label="Priority"
        aria-describedby={hintId}
        className="inline-flex w-fit gap-0.5 rounded-lg bg-muted p-0.5"
      >
        {PRIORITIES.map((p) => (
          <RadioGroupPrimitive.Item
            key={p}
            value={p}
            id={`${idPrefix}-priority-${p}`}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-xs pointer-coarse:h-10"
          >
            <PriorityIcon priority={p} className="text-current" />
            {PRIORITY_META[p].label}
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
      <FieldDescription id={hintId} className="text-xs">
        Higher priority comes first in its column. You can change it later.
      </FieldDescription>
    </FieldSet>
  );
}
