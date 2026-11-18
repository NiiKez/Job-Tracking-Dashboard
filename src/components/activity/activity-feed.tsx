"use client";

import {
  CheckCheck,
  CircleAlert,
  EyeOff,
  Loader2,
  MailCheck,
  MailPlus,
  MailSearch,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { useRunInboxCheck } from "@/components/email/use-run-inbox-check";
import { useHydrated } from "@/hooks/use-hydrated";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEmails, useJobs } from "@/lib/api/hooks";
import { EmailEntry, SystemEntry } from "./feed-entry";
import {
  FILTERS,
  buildFeed,
  countByFilter,
  groupByDay,
  isFilter,
  matchesFilter,
  type FilterValue,
} from "./feed-model";

const EMPTY_COPY: Record<FilterValue, { icon: LucideIcon; title: string; description: string }> = {
  all: {
    icon: MailSearch,
    title: "No email activity yet",
    description: "Job emails show up here after each sync, with what they changed.",
  },
  changes: {
    icon: MailCheck,
    title: "No status changes yet",
    description: "Emails that move an application, and applications with no reply, show up here.",
  },
  created: {
    icon: MailPlus,
    title: "No applications created from email",
    description: "A confirmation for a job that isn't in the dashboard adds it here.",
  },
  review: {
    icon: CheckCheck,
    title: "Nothing waiting for review",
    description: "Emails that couldn't be matched to a job or status show up here.",
  },
  ignored: {
    icon: EyeOff,
    title: "Nothing ignored",
    description:
      "Emails that aren't about a job aren't kept. This list shows the emails you dismissed from review.",
  },
};

export function ActivityFeed() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("filter");
  const filter: FilterValue = isFilter(raw) ? raw : "all";

  const setFilter = (next: FilterValue) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "all") params.delete("filter");
    else params.set("filter", next);
    const qs = params.toString();
    // Shallow URL update; Next syncs useSearchParams with history.replaceState.
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  };

  const emailsQuery = useEmails();
  const jobsQuery = useJobs();
  const hydrated = useHydrated();

  const feed = useMemo(
    () => buildFeed(emailsQuery.data ?? [], jobsQuery.data ?? []),
    [emailsQuery.data, jobsQuery.data],
  );
  const jobsById = useMemo(() => new Map((jobsQuery.data ?? []).map((j) => [j.id, j])), [jobsQuery.data]);
  const counts = useMemo(() => countByFilter(feed), [feed]);
  const groups = useMemo(() => groupByDay(feed.filter((i) => matchesFilter(i, filter))), [feed, filter]);

  if (hydrated && (emailsQuery.isError || jobsQuery.isError)) {
    const error = emailsQuery.error ?? jobsQuery.error;
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden />
        <AlertTitle>Couldn&apos;t load email activity</AlertTitle>
        <AlertDescription>
          <p>{error?.message}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => {
              emailsQuery.refetch();
              jobsQuery.refetch();
            }}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const loading = !hydrated || emailsQuery.isPending || jobsQuery.isPending;

  return (
    <Tabs value={filter} onValueChange={(v) => setFilter(v as FilterValue)} className="gap-0">
      <div className="no-scrollbar -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <TabsList
          aria-label="Filter email activity"
          className="group-data-horizontal/tabs:h-10 sm:group-data-horizontal/tabs:h-9"
        >
          {FILTERS.map((f) => (
            <TabsTrigger key={f.value} value={f.value} className="cursor-pointer gap-1.5 px-2.5 text-[13px]">
              {f.label}
              <span className="text-xs font-normal text-muted-foreground tabular">
                {loading ? "–" : counts[f.value]}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent value={filter} className="mt-5">
        {loading ? (
          <FeedSkeleton />
        ) : groups.length === 0 ? (
          <FeedEmpty filter={filter} onShowAll={() => setFilter("all")} />
        ) : (
          <div className="space-y-5">
            {groups.map((group) => (
              <section key={group.key} aria-labelledby={`day-${group.key}`}>
                <h2
                  id={`day-${group.key}`}
                  className="sticky top-14 z-10 -mx-1 flex items-baseline gap-1.5 bg-background/90 px-1 py-2 text-xs font-medium text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-background/75"
                >
                  <span className="text-foreground">{group.label}</span>
                  <span className="tabular">· {group.items.length}</span>
                </h2>
                <ol className="divide-y rounded-lg border bg-card">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      {item.kind === "email" ? (
                        <EmailEntry
                          email={item.email}
                          job={item.email.jobId ? jobsById.get(item.email.jobId) : undefined}
                        />
                      ) : (
                        <SystemEntry job={item.job} event={item.event} />
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

function FeedEmpty({ filter, onShowAll }: { filter: FilterValue; onShowAll: () => void }) {
  const copy = EMPTY_COPY[filter];
  const Icon = copy.icon;
  const check = useRunInboxCheck();
  return (
    <Empty className="rounded-lg border bg-card py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="size-10 rounded-lg">
          <Icon aria-hidden className="size-5" />
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold">{copy.title}</EmptyTitle>
        <EmptyDescription>{copy.description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-col justify-center gap-2 sm:flex-row">
        {filter !== "all" && (
          <Button variant="outline" onClick={onShowAll} className="h-10 w-full sm:h-8 sm:w-auto">
            Show all activity
          </Button>
        )}
        {(filter === "all" || filter === "review") && (
          <Button
            onClick={check.run}
            disabled={check.isPending || !check.connected}
            aria-busy={check.isPending || undefined}
            className="h-10 w-full gap-1.5 sm:h-8 sm:w-auto"
          >
            {check.isPending ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <RefreshCw aria-hidden className="size-4" />
            )}
            {check.isPending ? "Syncing…" : "Sync inbox now"}
          </Button>
        )}
      </EmptyContent>
    </Empty>
  );
}

export function FeedSkeleton() {
  return (
    <div className="space-y-5" aria-busy aria-label="Loading email activity">
      {[3, 2].map((rows, g) => (
        <div key={g}>
          <Skeleton className="my-2 h-4 w-24" />
          <div className="divide-y rounded-lg border bg-card">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex gap-3 px-3 py-3.5 sm:px-4">
                <Skeleton className="size-8 shrink-0 rounded-md" />
                <div className="flex-1 space-y-2">
                  <div className="flex justify-between gap-3">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3.5 w-10" />
                  </div>
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-5 w-44 rounded-full" />
                  <Skeleton className="h-5 w-56" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Suspense fallback for the whole feed (tabs + list). */
export function ActivityFeedSkeleton() {
  return (
    <div>
      <Skeleton className="h-10 w-full max-w-[34rem] rounded-lg sm:h-9" />
      <div className="mt-5">
        <FeedSkeleton />
      </div>
    </div>
  );
}
