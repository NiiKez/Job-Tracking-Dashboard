import { DEFAULT_PRIORITY, PRIORITIES, type Job, type Priority } from "@/lib/types";
import { ChevronsDown, ChevronsUp, Equal } from "lucide-react";
import { useId } from "react";

/*
 * The job's priority in the popup: High, Medium or Low, as a segmented control beside Save and
 * Applied. It is a group of native radio buttons, so Chrome gives it the radio group's keys
 * (Tab enters on the checked option, the arrow keys move and check) and screen readers say
 * "Priority, radio group, Medium, 2 of 3".
 *
 * What it shows: the priority picked in this popup (or in an earlier opening on this page, kept
 * in the draft), else the stored one of a job the tracker already has, else Medium.
 *
 * What is sent: only a priority the user picked (priorityInput). Unpicked, the tracker decides:
 * a new job gets Medium (as the control showed), and a job it already has keeps its priority.
 * That matters when the tracker knows the job but the popup doesn't (the read failed, or the
 * page's link differs): sending the Medium on show would quietly undo a High set in the
 * tracker. An older tracker that doesn't know priorities ignores the field.
 */

const OPTIONS: Record<Priority, { label: string; Icon: typeof ChevronsUp }> = {
  high: { label: "High", Icon: ChevronsUp },
  medium: { label: "Medium", Icon: Equal },
  low: { label: "Low", Icon: ChevronsDown },
};

export function priorityLabel(priority: Priority) {
  return OPTIONS[priority].label;
}

/** The priority the control shows: the one picked, else the stored job's, else the default. */
export function shownPriority(chosen: Priority | null, duplicateOf: Pick<Job, "priority"> | null): Priority {
  return chosen ?? duplicateOf?.priority ?? DEFAULT_PRIORITY;
}

/** The save request's priority: only one the user picked (see above). */
export function priorityInput(chosen: Priority | null): { priority?: Priority } {
  return chosen ? { priority: chosen } : {};
}

export function PriorityControl({ value, onChange }: { value: Priority; onChange: (priority: Priority) => void }) {
  const id = useId();
  return (
    <div className="priority">
      <span id={`${id}-label`} className="priority-label">
        Priority
      </span>
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="segmented">
        {PRIORITIES.map((priority) => {
          const { label, Icon } = OPTIONS[priority];
          return (
            <label key={priority} className="segment" data-priority={priority}>
              <input
                type="radio"
                name="priority"
                value={priority}
                checked={value === priority}
                onChange={() => onChange(priority)}
              />
              <span className="segment-face">
                <Icon aria-hidden />
                {label}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
