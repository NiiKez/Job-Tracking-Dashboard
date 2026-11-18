"use client";

import { ArrowRight, Clock, Mail } from "lucide-react";
import Link from "next/link";
import { useHydrated } from "@/hooks/use-hydrated";
import { Skeleton } from "@/components/ui/skeleton";
import { useSettings } from "@/lib/api/hooks";
import { INBOX_STATE_LABEL, scanProgressText } from "@/components/email/inbox-copy";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** An exact time ("14 Nov, 09:12"), not "yesterday". */
function LastSynced({ iso }: { iso: string | null }) {
  if (!iso) return <>Not synced yet</>;
  return (
    <>
      Last synced{" "}
      <time dateTime={iso} className="tabular">
        {formatDateTime(iso)}
      </time>
    </>
  );
}

/** One row: which inbox is read, how often, when it was last synced (or how far the first scan is). */
export function InboxSummary() {
  const { data: settings, isPending } = useSettings();
  const hydrated = useHydrated();

  if (!hydrated || isPending) return <Skeleton className="h-[42px] w-full rounded-lg" />;
  if (!settings) return null;
  const inbox = settings.inbox;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border bg-card px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", inbox.connected ? "bg-muted-foreground/60" : "bg-attention")}
        />
        <Mail aria-hidden className="size-4 shrink-0" />
        {inbox.address && (
          <span className="truncate text-sm font-medium text-foreground">{inbox.address}</span>
        )}
        <span className="shrink-0">
          {inbox.demo ? "Demo mail" : "Gmail"} · {INBOX_STATE_LABEL[inbox.state].toLowerCase()}
        </span>
      </span>
      {/* Only a connected inbox syncs on a schedule. */}
      {inbox.connected && (
        <span className="flex items-center gap-1.5">
          <Clock aria-hidden className="size-3.5" />
          Syncs every <span className="tabular">{inbox.intervalMinutes}</span> min
        </span>
      )}
      <span className="tabular">
        {inbox.backfill ? scanProgressText(inbox.backfill) : <LastSynced iso={inbox.lastCheckedAt} />}
      </span>
      <Link
        href="/settings"
        className="ml-auto inline-flex min-h-10 items-center gap-1 rounded-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none sm:min-h-0"
      >
        Manage
        <ArrowRight aria-hidden className="size-3" />
      </Link>
    </div>
  );
}
