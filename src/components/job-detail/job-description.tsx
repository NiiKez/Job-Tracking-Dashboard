"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Job description, clamped to ~12 lines with Show more / Show less. */
export function JobDescription({ text, onEdit }: { text: string; onEdit: () => void }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  // Measure whether the clamp actually hides something (depends on width).
  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const ro = new ResizeObserver(() => setOverflowing(el.scrollHeight > el.clientHeight + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  if (!text.trim()) {
    return (
      <p className="text-sm text-muted-foreground">
        No description.{" "}
        <button
          type="button"
          onClick={onEdit}
          className="rounded-sm font-medium text-foreground underline underline-offset-4 outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Edit the job
        </button>{" "}
        to paste one.
      </p>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div
        ref={ref}
        id={id}
        className={cn(
          "w-full scroll-mt-24 text-sm leading-relaxed text-pretty whitespace-pre-line",
          !expanded && "line-clamp-12",
        )}
      >
        {text}
      </div>
      {(overflowing || expanded) && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 text-primary hover:text-primary max-sm:h-10"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => {
            setExpanded((v) => !v);
            if (expanded) ref.current?.scrollIntoView({ block: "nearest" });
          }}
        >
          {expanded ? "Show less" : "Show more"}
          {expanded ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
        </Button>
      )}
    </div>
  );
}
