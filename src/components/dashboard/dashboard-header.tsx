"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAddJob } from "@/components/jobs/add-job-provider";
import { formatAgo, formatDateTime, plural } from "@/lib/format";
import type { Settings } from "@/lib/types";

/** Title block shared by the page and its loading fallback. */
function TitleBlock({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2 @3xl:shrink-0">
      <SidebarTrigger className="-ml-1.5 size-9 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <h1 className="text-2xl leading-9 font-semibold tracking-tight">Applications</h1>
        {children}
      </div>
    </div>
  );
}

const HEADER = "flex flex-col gap-3 @3xl:flex-row @3xl:items-center @3xl:gap-4";

/**
 * The Applications page header: title, how much is tracked and when the
 * inbox was last synced, then search, the Board / Table switch and "Add a job".
 */
export function DashboardHeader({
  total,
  inbox,
  children,
}: {
  /** Jobs tracked; undefined while loading. */
  total: number | undefined;
  inbox: Settings["inbox"] | undefined;
  /** Search field and view switch. */
  children: React.ReactNode;
}) {
  const { openAddJob } = useAddJob();
  return (
    <header className={HEADER}>
      <TitleBlock>
        <p className="min-h-5 text-meta text-muted-foreground tabular @3xl:whitespace-nowrap">
          {total !== undefined && inbox && (
            <>
              {plural(total, "job")} tracked.{" "}
              {inbox.state === "needs_reconnect" ? (
                "Inbox needs reconnecting."
              ) : !inbox.connected ? (
                "Inbox not connected."
              ) : inbox.lastCheckedAt ? (
                // Relative for a glance; the exact time is one hover away (and in the sidebar).
                <time dateTime={inbox.lastCheckedAt} title={formatDateTime(inbox.lastCheckedAt)}>
                  Inbox synced {formatAgo(inbox.lastCheckedAt)}.
                </time>
              ) : inbox.syncing ? (
                "Inbox syncing for the first time."
              ) : (
                "Inbox not synced yet."
              )}
            </>
          )}
        </p>
      </TitleBlock>
      <div className="flex min-w-0 items-center gap-2 @3xl:flex-1 @3xl:justify-end">
        {children}
        <Button onClick={() => openAddJob()} className="h-9 shrink-0 gap-1.5 px-3 pointer-coarse:h-10">
          <Plus aria-hidden />
          <span className="hidden @lg:inline">Add a job</span>
          <span className="sr-only @lg:hidden">Add a job</span>
        </Button>
      </div>
    </header>
  );
}

export function DashboardHeaderSkeleton() {
  return (
    <div className={HEADER}>
      <TitleBlock>
        <span aria-hidden className="mt-1 block h-4 w-56 animate-pulse rounded bg-muted" />
      </TitleBlock>
      <div aria-hidden className="flex min-w-0 items-center gap-2 @3xl:flex-1 @3xl:justify-end">
        <span className="h-9 min-w-0 flex-1 animate-pulse rounded-lg bg-muted @3xl:max-w-64" />
        <span className="h-9 w-40 animate-pulse rounded-lg bg-muted" />
      </div>
    </div>
  );
}
