"use client";

import { CheckCheck, CircleAlert, ListRestart, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useRunInboxCheck } from "@/components/email/use-run-inbox-check";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { useJobs, useRecheckReview, useReviewEmails, useRules } from "@/lib/api/hooks";
import type { Email, ReviewRecheckResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ReviewCard } from "./review-card";
import { useHydrated } from "@/hooks/use-hydrated";

function omit<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

/** How long a resolved card takes to fade + collapse (matches duration-200). */
const LEAVE_MS = 200;

export function ReviewList() {
  const reviewQuery = useReviewEmails();
  const jobsQuery = useJobs();
  const { data: rules } = useRules();
  const hydrated = useHydrated();

  /*
   * Resolving refetches the list, which would drop the card instantly. Keep a
   * copy of every card that is being resolved so it can fade + collapse first.
   */
  const [held, setHeld] = useState<Record<string, Email>>({});
  const [leaving, setLeaving] = useState<Record<string, true>>({});

  const release = (id: string) => {
    setHeld((h) => omit(h, id));
    setLeaving((l) => omit(l, id));
  };
  const hold = (email: Email) => setHeld((h) => ({ ...h, [email.id]: email }));
  const leave = (id: string) => {
    setLeaving((l) => ({ ...l, [id]: true }));
    window.setTimeout(() => release(id), LEAVE_MS + 40);
  };

  const jobs = useMemo(() => jobsQuery.data ?? [], [jobsQuery.data]);
  const jobsById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);

  const items = useMemo(() => {
    const byId = new Map<string, Email>();
    for (const e of reviewQuery.data ?? []) byId.set(e.id, e);
    for (const e of Object.values(held)) if (!byId.has(e.id)) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }, [reviewQuery.data, held]);

  if (!hydrated) return <ReviewListSkeleton />;

  if (reviewQuery.isError) {
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden />
        <AlertTitle>Couldn&apos;t load the review list</AlertTitle>
        <AlertDescription>
          <p>{reviewQuery.error.message}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => reviewQuery.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (reviewQuery.isPending || jobsQuery.isPending) return <ReviewListSkeleton />;

  const waiting = items.filter((e) => !leaving[e.id]).length;

  if (items.length === 0) return <ReviewEmpty />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm" aria-live="polite">
          <span className="font-semibold tabular">{waiting}</span> {waiting === 1 ? "email" : "emails"} waiting
          <span className="text-muted-foreground"> · nothing changes until you decide</span>
        </p>
        <div className="flex items-center gap-x-3">
          <RecheckButton waiting={waiting} />
          <Link
            href="/activity"
            className="rounded-sm text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            All email activity
          </Link>
        </div>
      </div>

      <ul className="flex flex-col" aria-label="Emails to review">
        {items.map((email) => {
          const isLeaving = !!leaving[email.id];
          return (
            <li
              key={email.id}
              className={cn(
                "grid grid-cols-1 transition-[grid-template-rows,opacity,translate] ease-in motion-safe:duration-200",
                isLeaving ? "grid-rows-[0fr] -translate-y-1 opacity-0" : "grid-rows-[1fr] opacity-100",
              )}
            >
              <div className={cn("min-h-0", isLeaving && "overflow-hidden")}>
                <div className="pb-3 animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
                  <ReviewCard
                    email={email}
                    jobs={jobs}
                    jobsById={jobsById}
                    rules={rules}
                    leaving={isLeaving}
                    onStart={hold}
                    onResolved={leave}
                    onFailed={release}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "12 linked to an application, 3 added as new applications, 9 dismissed. 4 still need you." */
function recheckSummary(r: ReviewRecheckResult): string {
  const done = [
    r.linked ? `${r.linked} linked to an application` : "",
    r.created ? count(r.created, "new application added", "new applications added") : "",
    r.dismissed ? `${r.dismissed} dismissed as not job related` : "",
  ].filter(Boolean);
  const rest = r.remaining ? `${count(r.remaining, "email still needs", "emails still need")} you.` : "Nothing is left to review.";
  return done.length ? `${done.join(", ")}. ${rest}` : `Nothing changed. ${rest}`;
}

/**
 * "Check again": the emails that wait here are read once more with the keywords and
 * applications of now (POST /api/emails/recheck). Unlike everything else on this page it
 * decides for the owner, so it asks first.
 */
function RecheckButton({ waiting }: { waiting: number }) {
  const recheck = useRecheckReview();
  const [open, setOpen] = useState(false);

  const run = () =>
    recheck.mutate(undefined, {
      onSuccess: (result) => {
        setOpen(false);
        toast.success("Checked the review list again", { description: recheckSummary(result) });
      },
      onError: (err) => {
        setOpen(false);
        toast.error("Couldn’t check the emails again", { description: err.message });
      },
    });

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-10 gap-1.5 sm:h-8"
        onClick={() => setOpen(true)}
        disabled={recheck.isPending}
      >
        {recheck.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <ListRestart aria-hidden className="size-4" />}
        Check again
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => !recheck.isPending && setOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Check {count(waiting, "this email", `these ${waiting} emails`)} again?</AlertDialogTitle>
            <AlertDialogDescription>
              Each email is read again with your keywords and applications as they are now, oldest first. Use it after
              you changed a keyword or added an application. An email that now clearly belongs to an application is
              linked to it and can change its status. A confirmation, rejection or invitation for an application that
              is not here yet adds it. Email that is not about a job is dismissed. Everything else stays in this list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={recheck.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={recheck.isPending}
              onClick={(e) => {
                e.preventDefault();
                run();
              }}
            >
              {recheck.isPending ? "Checking…" : "Check again"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ReviewEmpty() {
  const check = useRunInboxCheck();
  return (
    <Empty className="rounded-lg border bg-card py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="size-10 rounded-lg bg-muted text-muted-foreground">
          <CheckCheck aria-hidden className="size-5" />
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold">All caught up</EmptyTitle>
        <EmptyDescription>New uncertain emails will show up here.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-col justify-center gap-2 sm:flex-row">
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
        <Button variant="outline" asChild className="h-10 w-full sm:h-8 sm:w-auto">
          <Link href="/activity">See email activity</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function ReviewListSkeleton() {
  return (
    <div className="space-y-4" aria-busy aria-label="Loading emails to review">
      <Skeleton className="h-5 w-64" />
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-lg border bg-card">
            <div className="space-y-3 p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
                <Skeleton className="h-4 w-20" />
              </div>
              <Skeleton className="h-6 w-40 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-5/6" />
              </div>
            </div>
            <div className="mx-3 mb-3 rounded-lg border bg-surface-sunken p-3 sm:mx-4 sm:mb-4 sm:p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Skeleton className="size-8 rounded-md" />
                  <div className="space-y-1.5">
                    <Skeleton className="h-4 w-52" />
                    <Skeleton className="h-4 w-24 rounded-full" />
                  </div>
                </div>
                <Skeleton className="h-8 w-24" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
