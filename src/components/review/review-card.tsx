"use client";

import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleSlash,
  EyeOff,
  Loader2,
  Newspaper,
  Scale,
  SearchX,
  Split,
  TextSearch,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { HighlightedText, KeywordChips } from "@/components/email/highlighted-text";
import { CompanyAvatar } from "@/components/jobs/company-avatar";
import { RelativeTime } from "@/components/jobs/relative-time";
import { StatusBadge } from "@/components/jobs/status-badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useResolveReview } from "@/lib/api/hooks";
import { LANGUAGE_LABEL, OUTCOME_META, REVIEW_REASON_META, STATUS_META } from "@/lib/status";
import type { Email, Job, KeywordRule, ReviewAction, ReviewReason, Status } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AssignForm, CreateForm } from "./review-forms";

const REASON_ICON: Record<ReviewReason, LucideIcon> = {
  ambiguous_job: Split,
  unknown_job: SearchX,
  no_keyword: TextSearch,
  conflicting_keywords: Scale,
  status_mismatch: CircleSlash,
  bulk_mail: Newspaper,
};

export interface ReviewCardProps {
  email: Email;
  jobs: Job[];
  jobsById: Map<string, Job>;
  rules: KeywordRule[] | undefined;
  /** True while the card animates out after it was resolved. */
  leaving: boolean;
  /** Right before the request: the list keeps the card around while it animates out. */
  onStart: (email: Email) => void;
  /** Request succeeded: start the exit animation. */
  onResolved: (id: string) => void;
  /** Request failed: the card stays. */
  onFailed: (id: string) => void;
}

/* ------------------------------------------------------------ helpers */

function Spinner() {
  return <Loader2 aria-hidden className="size-4 animate-spin" />;
}

/** "Applied → Interview", or "Stays Interview" when nothing would change. */
function StatusChange({ from, to }: { from: Status; to: Status }) {
  if (from === to) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        Stays
        <StatusBadge status={to} />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusBadge status={from} />
      <ArrowRight aria-hidden className="size-3.5 text-muted-foreground" />
      <span className="sr-only">to</span>
      <StatusBadge status={to} />
    </span>
  );
}

/** Keywords; when they disagree, grouped by the status their rule points to. */
function Keywords({ email, rules }: { email: Email; rules: KeywordRule[] | undefined }) {
  const keywords = email.matchedKeywords;
  if (!keywords.length) return null;

  if (email.reviewReason === "conflicting_keywords" && rules?.length) {
    const groups = new Map<Status | "other", string[]>();
    for (const k of keywords) {
      const status = rules.find((r) => r.phrase.toLowerCase() === k.toLowerCase())?.status ?? "other";
      groups.set(status, [...(groups.get(status) ?? []), k]);
    }
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-xs text-muted-foreground">Keywords found</span>
        {[...groups].map(([status, words]) => (
          <span key={status} className="inline-flex items-center gap-1.5">
            {status !== "other" && <StatusBadge status={status} />}
            <KeywordChips keywords={words} />
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Keywords found</span>
      <KeywordChips keywords={keywords} />
    </div>
  );
}

/* --------------------------------------------------------------- card */

export function ReviewCard({
  email,
  jobs,
  jobsById,
  rules,
  leaving,
  onStart,
  onResolved,
  onFailed,
}: ReviewCardProps) {
  const router = useRouter();
  const resolve = useResolveReview();
  const uid = useId();
  const [pending, setPending] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [altOpen, setAltOpen] = useState(false);
  const busy = pending !== null || leaving;

  const reason = email.reviewReason ? REVIEW_REASON_META[email.reviewReason] : null;
  const ReasonIcon = email.reviewReason ? REASON_ICON[email.reviewReason] : OUTCOME_META.review.icon;
  const suggestedJobs = email.suggestedJobIds
    .map((id) => jobsById.get(id))
    .filter((j): j is Job => !!j);
  const suggestedStatus = email.suggestedStatus;
  const mode: "suggest" | "create" | "assign" =
    suggestedJobs.length > 0 && suggestedStatus
      ? "suggest"
      : email.reviewReason === "unknown_job" || suggestedJobs.length === 0
        ? "create"
        : "assign";

  const langCode = email.language.toUpperCase();
  const langName = LANGUAGE_LABEL[email.language] ?? langCode;
  const preview = email.body.replace(/\s*\n+\s*/g, " ").trim();
  const bodyId = `${uid}-body`;
  const subjectId = `${uid}-subject`;

  function run(key: string, action: ReviewAction) {
    if (busy) return;
    setPending(key);
    onStart(email);
    resolve.mutate(
      { id: email.id, action },
      {
        onSuccess: ({ email: updated, job }) => {
          onResolved(email.id);
          if (!job) {
            toast.success("Dismissed", {
              description: `“${email.subject}” was marked as not job related.`,
            });
            return;
          }
          const to = updated.statusChange?.to ?? job.status;
          const from = updated.statusChange?.from ?? null;
          const viewJob = { label: "View job", onClick: () => router.push(`/jobs/${job.id}`) };
          if (action.action === "create") {
            toast.success(`Added ${job.company}`, {
              description: `${job.title} · ${STATUS_META[to].label}`,
              action: viewJob,
            });
          } else if (from && from === to) {
            toast.success(`Linked to ${job.company}`, {
              description: `${job.title} · stays ${STATUS_META[to].label}`,
              action: viewJob,
            });
          } else {
            toast.success(`Moved ${job.company} to ${STATUS_META[to].label}`, {
              description: job.title,
              action: viewJob,
            });
          }
        },
        onError: (err) => {
          setPending(null);
          onFailed(email.id);
          toast.error("Couldn't save your choice", { description: err.message });
        },
      },
    );
  }

  const dismissButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => run("dismiss", { action: "dismiss" })}
      disabled={busy}
      aria-busy={pending === "dismiss" || undefined}
      className="ml-auto h-10 gap-1.5 text-muted-foreground sm:h-8"
    >
      {pending === "dismiss" ? <Spinner /> : <EyeOff aria-hidden className="size-4" />}
      Not job related
    </Button>
  );

  const assignForm = (defaults: { jobId?: string; status?: Status | null; primary?: boolean }) => (
    <AssignForm
      idBase={`${uid}-assign`}
      jobs={jobs}
      suggestedIds={email.suggestedJobIds}
      defaultJobId={defaults.jobId}
      defaultStatus={defaults.status}
      pending={pending === "assign"}
      disabled={busy}
      primary={defaults.primary}
      onSubmit={(jobId, status) => run("assign", { action: "assign", jobId, status })}
    />
  );

  return (
    <article
      aria-labelledby={subjectId}
      aria-busy={busy || undefined}
      className="rounded-lg border bg-card text-card-foreground"
    >
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        {/* Sender + meta */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{email.fromName}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{email.fromAddress}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  aria-label={`Language: ${langName}`}
                  className="inline-flex h-5 items-center rounded border px-1.5 font-mono text-[11px] leading-none font-medium text-foreground/80 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {langCode}
                </span>
              </TooltipTrigger>
              <TooltipContent>Written in {langName}</TooltipContent>
            </Tooltip>
            <RelativeTime iso={email.receivedAt} className="tabular" />
          </div>
        </div>

        {/* Why it is here */}
        {reason && (
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2.5">
            <span
              className={cn(
                "inline-flex h-6 w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium",
                OUTCOME_META.review.className,
              )}
            >
              <ReasonIcon aria-hidden className="size-3.5" />
              {reason.label}
            </span>
            <p className="text-xs text-muted-foreground">{reason.explain}</p>
          </div>
        )}

        {/* Subject + body */}
        <div className="space-y-1">
          <h2 id={subjectId} className="text-sm font-medium tracking-tight text-pretty">
            {email.subject}
          </h2>
          <div id={bodyId} className="text-sm text-muted-foreground">
            {expanded ? (
              <HighlightedText
                text={email.body}
                keywords={email.matchedKeywords}
                className="leading-relaxed text-foreground/90"
              />
            ) : (
              <HighlightedText text={preview} keywords={email.matchedKeywords} className="line-clamp-3" />
            )}
          </div>
          <Button
            type="button"
            variant="link"
            size="sm"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((v) => !v)}
            className="h-9 gap-1 px-0 text-xs text-muted-foreground hover:text-foreground sm:h-7"
          >
            {expanded ? "Show less" : "Show full email"}
            <ChevronDown
              aria-hidden
              className={cn("size-3.5 transition-transform duration-200", expanded && "rotate-180")}
            />
          </Button>
        </div>

        <Keywords email={email} rules={rules} />
      </div>

      {/* Decision */}
      <div className="@container/decision mx-3 mb-3 rounded-lg border bg-surface-sunken p-3 pb-1.5 sm:mx-4 sm:mb-4 sm:p-4 sm:pb-2">
        {mode === "suggest" && suggestedStatus && (
          <Collapsible open={altOpen} onOpenChange={setAltOpen} className="space-y-3">
            <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
              <span className="font-medium">
                {suggestedJobs.length > 1 ? "Looks like one of these" : "Looks like"}
              </span>
              <span className="tabular" title="How sure the matcher was">
                {Math.round(email.confidence * 100)}% sure
              </span>
            </div>
            <ul className="space-y-3">
              {suggestedJobs.map((job, i) => {
                const key = i === 0 ? "confirm" : `confirm:${job.id}`;
                const action: ReviewAction =
                  i === 0
                    ? { action: "confirm" }
                    : { action: "assign", jobId: job.id, status: suggestedStatus };
                return (
                  <li
                    key={job.id}
                    className="flex flex-col gap-2.5 @md/decision:flex-row @md/decision:items-center @md/decision:justify-between @md/decision:gap-4"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <CompanyAvatar company={job.company} />
                      <div className="min-w-0 space-y-1">
                        <p className="truncate text-sm">
                          <span className="font-medium">{job.company}</span>
                          <span className="text-muted-foreground"> · {job.title}</span>
                        </p>
                        <StatusChange from={job.status} to={suggestedStatus} />
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant={i === 0 ? "default" : "outline"}
                      onClick={() => run(key, action)}
                      disabled={busy}
                      aria-busy={pending === key || undefined}
                      aria-label={`Confirm: ${job.company} → ${STATUS_META[suggestedStatus].label}`}
                      className={cn("h-10 gap-1.5 px-3.5 sm:h-8", i > 0 && "bg-background")}
                    >
                      {pending === key ? <Spinner /> : <Check aria-hidden className="size-4" />}
                      {pending === key ? "Saving…" : "Confirm"}
                    </Button>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t pt-2">
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="-ml-2 h-10 gap-1 sm:h-8"
                >
                  Choose differently
                  <ChevronDown
                    aria-hidden
                    className={cn("size-3.5 transition-transform duration-200", altOpen && "rotate-180")}
                  />
                </Button>
              </CollapsibleTrigger>
              {dismissButton}
            </div>
            <CollapsibleContent className="pb-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
              {assignForm({ jobId: suggestedJobs[0]?.id, status: suggestedStatus })}
            </CollapsibleContent>
          </Collapsible>
        )}

        {mode === "create" && (
          <Collapsible open={altOpen} onOpenChange={setAltOpen} className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">
              None of your applications match. Add it as a new one?
            </p>
            <CreateForm
              idBase={`${uid}-create`}
              email={email}
              pending={pending === "create"}
              disabled={busy}
              onSubmit={(input) => run("create", { action: "create", ...input })}
            />
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t pt-2">
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="-ml-2 h-10 gap-1 sm:h-8"
                >
                  Link to an existing application
                  <ChevronDown
                    aria-hidden
                    className={cn("size-3.5 transition-transform duration-200", altOpen && "rotate-180")}
                  />
                </Button>
              </CollapsibleTrigger>
              {dismissButton}
            </div>
            <CollapsibleContent className="pb-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
              {assignForm({ status: suggestedStatus })}
            </CollapsibleContent>
          </Collapsible>
        )}

        {mode === "assign" && (
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">
              {suggestedJobs.length === 1
                ? `Probably about ${suggestedJobs[0].company}. Pick what the email means.`
                : "Pick the application and what the email means."}
            </p>
            {assignForm({ jobId: suggestedJobs[0]?.id, status: suggestedStatus, primary: true })}
            <div className="flex justify-end border-t pt-2">{dismissButton}</div>
          </div>
        )}
      </div>
    </article>
  );
}
