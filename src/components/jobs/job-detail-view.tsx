"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { DetailHeader } from "@/components/job-detail/detail-header";
import { DetailSection } from "@/components/job-detail/detail-section";
import { JobDetailSkeleton } from "@/components/job-detail/detail-skeleton";
import { JobDeleted, JobLoadError, JobNotFound } from "@/components/job-detail/detail-states";
import { EditJobForm } from "@/components/job-detail/edit-job-form";
import { JobDescription } from "@/components/job-detail/job-description";
import { JobFacts } from "@/components/job-detail/job-facts";
import { LinkedEmails } from "@/components/job-detail/linked-emails";
import { LockNotice } from "@/components/job-detail/lock-notice";
import { StatusTimeline } from "@/components/job-detail/status-timeline";
import { ApiError } from "@/lib/api/client";
import { useJob } from "@/lib/api/hooks";
import type { JobWithEmails } from "@/lib/types";

export interface JobDetailViewProps {
  jobId: string;
  /** "sheet": inside the dashboard side sheet. "page": the /jobs/[id] route. */
  variant: "sheet" | "page";
  /** Called after the job was deleted (sheet closes / page navigates home). */
  onDeleted?: () => void;
}

/**
 * Everything about one job: header + actions, lock notice, facts, description,
 * status timeline and linked emails. Lays out as one column in the dashboard
 * sheet and as main + aside on the full page (container queries, so it adapts
 * to the space it gets rather than the viewport).
 *
 * In the sheet it adds px-6/py-6 itself; on the page the container pads it.
 */
export function JobDetailView(props: JobDetailViewProps) {
  // Fresh local state (edit mode, open emails) whenever another job is shown.
  const view = <JobDetail key={props.jobId} {...props} />;
  // The sheet renders us edge to edge; the page container brings its own padding.
  return props.variant === "sheet" ? <div className="px-4 py-5 sm:px-6 sm:py-6">{view}</div> : view;
}

function JobDetail({ jobId, variant, onDeleted }: JobDetailViewProps) {
  const router = useRouter();
  const { data: job, error, refetch, isFetching } = useJob(jobId);
  const [deleted, setDeleted] = useState(false);

  const handleDeleted = useCallback(() => {
    setDeleted(true);
    onDeleted?.();
    if (variant === "page") router.push("/");
  }, [onDeleted, router, variant]);

  if (deleted) return <JobDeleted />;
  if (!job) {
    if (error) {
      return error instanceof ApiError && error.status === 404 ? (
        <JobNotFound />
      ) : (
        <JobLoadError
          message={error.message || "Something went wrong."}
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      );
    }
    return <JobDetailSkeleton variant={variant} />;
  }
  return <JobDetailContent job={job} variant={variant} onDeleted={handleDeleted} />;
}

function JobDetailContent({
  job,
  variant,
  onDeleted,
}: {
  job: JobWithEmails;
  variant: "sheet" | "page";
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [openEmails, setOpenEmails] = useState<string[]>([]);
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const baseId = useId();

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const emailDomId = useCallback((id: string) => `${baseId}-email-${id}`, [baseId]);
  const linkedEmailIds = useMemo(() => new Set(job.emails.map((e) => e.id)), [job.emails]);

  const setEmailOpen = useCallback((id: string, open: boolean) => {
    setOpenEmails((prev) =>
      open ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id),
    );
  }, []);

  /** From the timeline: expand the email, scroll to it, focus it, flash it. */
  const viewEmail = useCallback(
    (id: string) => {
      setEmailOpen(id, true);
      setFlashId(id);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlashId(null), 1600);
      requestAnimationFrame(() => {
        const el = document.getElementById(emailDomId(id));
        if (!el) return;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
        el.querySelector<HTMLElement>("[data-email-trigger]")?.focus({ preventScroll: true });
      });
    },
    [emailDomId, setEmailOpen],
  );

  const startEditing = useCallback(() => setEditing(true), []);

  const top = editing ? (
    <EditJobForm job={job} onDone={() => setEditing(false)} />
  ) : (
    <DetailHeader job={job} variant={variant} onEdit={startEditing} onDeleted={onDeleted} />
  );
  const lock = job.statusLocked && !editing ? <LockNotice job={job} /> : null;

  const facts = (
    <DetailSection title="Details">
      <JobFacts job={job} />
    </DetailSection>
  );
  const description = editing ? null : (
    <DetailSection title="Description">
      <JobDescription text={job.description} onEdit={startEditing} />
    </DetailSection>
  );
  const timeline = (
    <DetailSection title="Activity">
      <StatusTimeline
        history={job.history}
        linkedEmailIds={linkedEmailIds}
        onViewEmail={viewEmail}
      />
    </DetailSection>
  );
  const emails = (
    <DetailSection title="Emails" count={job.emails.length}>
      <LinkedEmails
        emails={job.emails}
        openIds={openEmails}
        flashId={flashId}
        onOpenChange={setEmailOpen}
        domId={emailDomId}
        scrollMargin={variant === "page" ? "scroll-mt-20" : "scroll-mt-4"}
      />
    </DetailSection>
  );

  if (variant === "sheet") {
    return (
      <article aria-label={`${job.title} at ${job.company}`} className="@container flex flex-col gap-5">
        {top}
        {lock}
        <div className="flex flex-col [&>section]:border-t [&>section]:py-6 [&>section:last-child]:pb-0">
          {facts}
          {description}
          {timeline}
          {emails}
        </div>
      </article>
    );
  }

  return (
    <article aria-label={`${job.title} at ${job.company}`} className="@container flex flex-col gap-5">
      {top}
      {lock}
      <div className="grid gap-x-10 gap-y-8 border-t pt-6 @4xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="flex min-w-0 flex-col gap-8">
          {description}
          {emails}
        </div>
        <aside
          aria-label="Status and history"
          className="flex flex-col gap-6 self-start rounded-lg border bg-card p-5"
        >
          {facts}
          <div className="border-t" />
          {timeline}
        </aside>
      </div>
    </article>
  );
}
