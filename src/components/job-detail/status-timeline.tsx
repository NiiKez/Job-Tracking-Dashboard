"use client";

import { ArrowRight, Mail } from "lucide-react";
import { RelativeTime } from "@/components/jobs/relative-time";
import { SOURCE_LABEL, STATUS_META } from "@/lib/status";
import type { StatusEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Status history, newest first, one dot per change in the target status color. */
export function StatusTimeline({
  history,
  linkedEmailIds,
  onViewEmail,
}: {
  history: StatusEvent[];
  /** Emails that are present in the Emails list (only those get "View email"). */
  linkedEmailIds: ReadonlySet<string>;
  onViewEmail: (emailId: string) => void;
}) {
  const events = [...history].sort((a, b) => b.at.localeCompare(a.at));
  if (!events.length) {
    return <p className="text-sm text-muted-foreground">No status changes yet.</p>;
  }
  return (
    <ol className="flex flex-col">
      {events.map((ev, i) => {
        const last = i === events.length - 1;
        const to = STATUS_META[ev.to];
        const emailId = ev.emailId && linkedEmailIds.has(ev.emailId) ? ev.emailId : null;
        return (
          <li key={ev.id} className="flex gap-3">
            <div aria-hidden className="flex w-2.5 shrink-0 flex-col items-center">
              <span className={cn("mt-[5px] size-2.5 shrink-0 rounded-full", to.dotClass)} />
              {!last && <span className="mt-1.5 w-px flex-1 bg-border" />}
            </div>
            <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", !last && "pb-5")}>
              <div className="flex items-baseline gap-3">
                <p className="min-w-0 flex-1 text-sm">
                  {ev.from ? (
                    <>
                      <span className="text-muted-foreground">Moved </span>
                      <span className="text-muted-foreground">{STATUS_META[ev.from].label}</span>
                      <ArrowRight
                        aria-hidden
                        className="mx-1 inline size-3.5 -translate-y-px text-muted-foreground"
                      />
                      <span className="sr-only"> to </span>
                      <span className="font-medium">{to.label}</span>
                    </>
                  ) : (
                    <span className="font-medium">{to.label}</span>
                  )}
                </p>
                <RelativeTime
                  iso={ev.at}
                  className="shrink-0 text-xs text-muted-foreground tabular"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {SOURCE_LABEL[ev.source]}
                {ev.note && <> · {ev.note}</>}
              </p>
              {emailId && (
                <button
                  type="button"
                  onClick={() => onViewEmail(emailId)}
                  className="-mx-1 mt-0.5 inline-flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-primary outline-none hover:underline hover:underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:py-2"
                >
                  <Mail aria-hidden className="size-3.5" />
                  View email
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
