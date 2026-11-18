"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

/** A titled block of the job detail view (Details, Description, Activity, Emails). */
export function DetailSection({
  title,
  count,
  action,
  className,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-3", className)}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3
          id={id}
          className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase"
        >
          {title}
          {count !== undefined && (
            <span className="rounded-full bg-muted px-1.5 text-[11px] leading-4 font-medium tracking-normal tabular">
              {count}
            </span>
          )}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}
