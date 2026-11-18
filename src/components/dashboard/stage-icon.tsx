import type { Stage } from "@/lib/stages";
import { cn } from "@/lib/utils";

/*
 * A stage's glyph: a ring that fills as the application moves forward.
 * Shape carries the stage, never colour (one accent only). It always sits
 * next to the stage's name, so it is decorative for assistive tech.
 *
 *   Saved ◌   Applied ◔   Interview ◑   Offer ◕   Closed ⊗
 */

const PIE: Partial<Record<Stage, string>> = {
  applied: "M8 8V4.5A3.5 3.5 0 0 1 11.5 8Z",
  interview: "M8 8V4.5A3.5 3.5 0 0 1 8 11.5Z",
  offer: "M8 8V4.5A3.5 3.5 0 1 1 4.5 8Z",
};

/** Saved and Closed are the quiet ends of the pipeline. */
const QUIET: ReadonlySet<Stage> = new Set(["saved", "closed"]);

export function StageIcon({ stage, className }: { stage: Stage; className?: string }) {
  const pie = PIE[stage];
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      className={cn(
        "size-3.5 shrink-0",
        QUIET.has(stage) ? "text-muted-foreground" : "text-foreground",
        className,
      )}
    >
      <circle
        cx="8"
        cy="8"
        r="6.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={stage === "saved" ? "2.4 2.5" : undefined}
      />
      {pie && <path d={pie} fill="currentColor" />}
      {stage === "closed" && (
        <path
          d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
