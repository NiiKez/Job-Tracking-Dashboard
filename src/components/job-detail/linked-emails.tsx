"use client";

import { ArrowRight, ChevronDown, Mail, MailOpen } from "lucide-react";
import { HighlightedText, KeywordChips } from "@/components/email/highlighted-text";
import { RelativeTime } from "@/components/jobs/relative-time";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDateTime } from "@/lib/format";
import { OUTCOME_META, STATUS_META } from "@/lib/status";
import type { Email } from "@/lib/types";
import { cn } from "@/lib/utils";

function OutcomeChip({ outcome }: { outcome: Email["outcome"] }) {
  const meta = OUTCOME_META[outcome];
  const Icon = meta.icon;
  return (
    <span
      title={meta.description}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap",
        meta.className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      {meta.label}
    </span>
  );
}

function StatusChangeLine({ change }: { change: NonNullable<Email["statusChange"]> }) {
  const to = STATUS_META[change.to];
  if (change.from === change.to) {
    return (
      <p className="text-xs text-muted-foreground">
        Status stayed <span className="font-medium text-foreground">{to.label}</span>
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {change.from ? (
        <>
          This email moved the job from {STATUS_META[change.from].label}
          <ArrowRight aria-hidden className="size-3" />
          <span className="sr-only">to</span>
        </>
      ) : (
        "This email added the job as"
      )}
      <span className={cn("font-medium", to.textClass)}>{to.label}</span>
    </p>
  );
}

function EmailItem({
  email,
  domId,
  open,
  flash,
  onOpenChange,
  scrollMargin,
}: {
  email: Email;
  domId: string;
  open: boolean;
  flash: boolean;
  onOpenChange: (open: boolean) => void;
  scrollMargin: string;
}) {
  return (
    <li
      id={domId}
      className={cn(
        "rounded-lg border bg-card transition-[box-shadow,border-color] duration-200",
        scrollMargin,
        flash && "border-primary/50 ring-3 ring-primary/20",
      )}
    >
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="relative rounded-lg px-3 py-3 transition-colors duration-150 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 hover:bg-muted/40">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 hidden size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground @sm:flex"
            >
              {open ? <MailOpen className="size-4" /> : <Mail className="size-4" />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-baseline gap-3">
                <p className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium">{email.fromName}</span>{" "}
                  <span className="text-xs text-muted-foreground">{email.fromAddress}</span>
                </p>
                <RelativeTime
                  iso={email.receivedAt}
                  className="shrink-0 text-xs text-muted-foreground tabular"
                />
              </div>
              <CollapsibleTrigger
                data-email-trigger
                className="w-full truncate text-left text-sm text-muted-foreground outline-none after:absolute after:inset-0 after:rounded-lg"
              >
                {email.subject}
              </CollapsibleTrigger>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <OutcomeChip outcome={email.outcome} />
                <KeywordChips keywords={email.matchedKeywords} />
              </div>
            </div>
            <ChevronDown
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                open && "rotate-180",
              )}
            />
          </div>
        </div>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="flex flex-col gap-3 border-t px-3 py-3 @sm:pl-14">
            <p className="text-xs text-muted-foreground">
              From {email.fromName} &lt;{email.fromAddress}&gt; ·{" "}
              <time dateTime={email.receivedAt} className="tabular">
                {formatDateTime(email.receivedAt)}
              </time>
            </p>
            <HighlightedText
              text={email.body}
              keywords={email.matchedKeywords}
              className="text-sm leading-relaxed break-words"
            />
            {email.statusChange && <StatusChangeLine change={email.statusChange} />}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/** Emails linked to the job, newest first. Collapsed rows expand to the full body. */
export function LinkedEmails({
  emails,
  openIds,
  flashId,
  onOpenChange,
  domId,
  scrollMargin,
}: {
  emails: Email[];
  openIds: readonly string[];
  flashId: string | null;
  onOpenChange: (emailId: string, open: boolean) => void;
  domId: (emailId: string) => string;
  /** Room above an email when it is scrolled into view (sticky page header). */
  scrollMargin: string;
}) {
  if (!emails.length) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-dashed px-4 py-4">
        <Mail aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No emails linked yet. When a reply arrives, it shows up here and moves the status.
        </p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {emails.map((email) => (
        <EmailItem
          key={email.id}
          email={email}
          domId={domId(email.id)}
          open={openIds.includes(email.id)}
          flash={flashId === email.id}
          onOpenChange={(open) => onOpenChange(email.id, open)}
          scrollMargin={scrollMargin}
        />
      ))}
    </ul>
  );
}
