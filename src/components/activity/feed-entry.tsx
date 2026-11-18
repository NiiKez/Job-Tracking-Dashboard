"use client";

import { format, isToday } from "date-fns";
import { ArrowRight, ChevronDown, Hourglass } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { HighlightedText, KeywordChips } from "@/components/email/highlighted-text";
import { CompanyAvatar } from "@/components/jobs/company-avatar";
import { RelativeTime } from "@/components/jobs/relative-time";
import { StatusBadge } from "@/components/jobs/status-badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDateTime } from "@/lib/format";
import { OUTCOME_META, REVIEW_REASON_META, STATUS_META } from "@/lib/status";
import type { Email, Job, Status, StatusEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------ pieces */

/** Relative time today ("2h ago"), clock time on earlier days (the day is in the group header). */
function EntryTime({ iso }: { iso: string }) {
  const cls = "shrink-0 pt-0.5 text-xs text-muted-foreground tabular";
  if (isToday(new Date(iso))) return <RelativeTime iso={iso} className={cls} />;
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={cls}>
      {format(new Date(iso), "HH:mm")}
    </time>
  );
}

function IconSquare({ className, label, children }: { className: string; label: string; children: React.ReactNode }) {
  return (
    <span
      title={label}
      className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md", className)}
    >
      {children}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Change({ from, to }: { from: Status | null; to: Status }) {
  if (!from) return <StatusBadge status={to} />;
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusBadge status={from} />
      <ArrowRight aria-hidden className="size-3.5 text-muted-foreground" />
      <span className="sr-only">to</span>
      <StatusBadge status={to} />
    </span>
  );
}

function Line({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground", className)}>
      {children}
    </div>
  );
}

/** What the app did with the email, in words + status badges. */
function WhatHappened({ email }: { email: Email }) {
  const c = email.statusChange;
  switch (email.outcome) {
    case "matched":
    case "resolved": {
      const prefix = email.outcome === "resolved" ? "Confirmed by you" : null;
      if (!c) {
        return <Line>{prefix ? `${prefix} · linked to the application` : "Linked to the application"}</Line>;
      }
      if (c.from === c.to) {
        return (
          <Line>
            <span>{prefix ? `${prefix} · status stays` : "Linked · status stays"}</span>
            <StatusBadge status={c.to} />
          </Line>
        );
      }
      return (
        <Line>
          {prefix && <span>{prefix}</span>}
          <Change from={c.from} to={c.to} />
        </Line>
      );
    }
    case "created":
      return (
        <Line>
          <span className="font-medium text-foreground">Created a new application</span>
          <StatusBadge status={c?.to ?? "applied"} />
        </Line>
      );
    case "review":
      return (
        <Line>
          <span className="font-medium text-attention">Waiting for your review</span>
          {email.reviewReason && <span>· {REVIEW_REASON_META[email.reviewReason].label}</span>}
          <Link
            href="/review"
            className="inline-flex min-h-10 items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none sm:min-h-0"
          >
            Review
            <ArrowRight aria-hidden className="size-3" />
          </Link>
        </Line>
      );
    case "ignored":
      return <Line>Not job related, ignored</Line>;
    case "dismissed":
      return <Line>You marked it as not job related</Line>;
  }
}

export function JobLink({ job }: { job: Job }) {
  return (
    <Link
      href={`/jobs/${job.id}`}
      className="group/job inline-flex max-w-full min-h-10 items-center gap-2 rounded-md text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:min-h-0"
    >
      <CompanyAvatar company={job.company} size="sm" />
      <span className="min-w-0 truncate">
        <span className="font-medium underline-offset-4 group-hover/job:text-primary group-hover/job:underline">
          {job.company}
        </span>
        <span className="text-muted-foreground"> · {job.title}</span>
      </span>
    </Link>
  );
}

/* ----------------------------------------------------------- entries */

export function EmailEntry({ email, job }: { email: Email; job: Job | undefined }) {
  const [open, setOpen] = useState(false);
  const meta = OUTCOME_META[email.outcome];
  const Icon = meta.icon;
  const muted = email.outcome === "ignored" || email.outcome === "dismissed";

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <article className="flex gap-3 px-3 pt-3 pb-1.5 sm:px-4 sm:pt-3.5 sm:pb-2.5">
        <IconSquare className={meta.className} label={meta.label}>
          <Icon aria-hidden className="size-4" />
        </IconSquare>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className={cn("truncate text-sm font-medium", muted && "text-foreground/80")}>
                {email.subject}
              </h3>
              <p className="truncate text-xs text-muted-foreground">
                {email.fromName}
                <span className="hidden font-mono sm:inline"> &lt;{email.fromAddress}&gt;</span>
              </p>
            </div>
            <EntryTime iso={email.receivedAt} />
          </div>

          <WhatHappened email={email} />

          {job && (
            <div>
              <JobLink job={job} />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <KeywordChips keywords={email.matchedKeywords} />
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="-ml-1.5 h-10 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground sm:h-6"
              >
                {open ? "Hide email" : "Show email"}
                <ChevronDown
                  aria-hidden
                  className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")}
                />
              </Button>
            </CollapsibleTrigger>
          </div>

          <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
            <div className="rounded-md border bg-surface-sunken p-3">
              <HighlightedText
                text={email.body}
                keywords={email.matchedKeywords}
                className="text-sm leading-relaxed"
              />
            </div>
          </CollapsibleContent>
        </div>
      </article>
    </Collapsible>
  );
}

export function SystemEntry({ job, event }: { job: Job; event: StatusEvent }) {
  const meta = STATUS_META[event.to];
  return (
    <article className="flex gap-3 px-3 py-3 sm:px-4 sm:py-3.5">
      <IconSquare className={meta.badgeClass} label="Automatic status change">
        <Hourglass aria-hidden className="size-4" />
      </IconSquare>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium">{event.note ?? "No reply in time"}</h3>
            <p className="truncate text-xs text-muted-foreground">Automatic check · not an email</p>
          </div>
          <EntryTime iso={event.at} />
        </div>
        <Line>
          <Change from={event.from} to={event.to} />
        </Line>
        <div>
          <JobLink job={job} />
        </div>
      </div>
    </article>
  );
}
