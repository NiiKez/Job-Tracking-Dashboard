"use client";

import { RelativeTime } from "@/components/jobs/relative-time";
import { PrioritySelect } from "@/components/jobs/priority";
import { StatusBadge } from "@/components/jobs/status-badge";
import { formatDate, formatDateTime } from "@/lib/format";
import { SOURCE_LABEL } from "@/lib/status";
import type { CaptureMethod, JobWithEmails } from "@/lib/types";
import { NextInterviewField, OfferDeadlineField } from "./schedule-field";

const CAPTURED: Record<CaptureMethod, string> = {
  extension: "with the Chrome extension",
  paste: "by pasting the posting",
  email: "from a confirmation email",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">{children}</dd>
    </>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

/**
 * Status, priority (changed right here), the stage's key date, other dates
 * and counts as a compact definition list. Sources are spelled out as text,
 * not icons.
 */
export function JobFacts({ job }: { job: JobWithEmails }) {
  const emailCount = job.emails.length;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-sm">
      <Row label="Status">
        <StatusBadge status={job.status} />
        <Muted>
          {SOURCE_LABEL[job.statusSource]}
          {job.statusLocked && " · emails won’t change it"}
        </Muted>
      </Row>
      <Row label="Priority">
        <PrioritySelect job={job} />
      </Row>
      {job.status === "interview" && (
        <Row label="Next interview">
          <NextInterviewField job={job} />
        </Row>
      )}
      {job.status === "offer" && (
        <Row label="Respond by">
          <OfferDeadlineField job={job} />
        </Row>
      )}
      <Row label="Added">
        <time dateTime={job.createdAt} title={formatDateTime(job.createdAt)} className="tabular">
          {formatDate(job.createdAt)}
        </time>
        <Muted>{CAPTURED[job.captureMethod]}</Muted>
      </Row>
      <Row label="Applied">
        {job.appliedAt ? (
          <time dateTime={job.appliedAt} title={formatDateTime(job.appliedAt)} className="tabular">
            {formatDate(job.appliedAt)}
          </time>
        ) : (
          <>
            <span aria-hidden className="text-muted-foreground">
              —
            </span>
            <span className="sr-only">Not yet</span>
          </>
        )}
      </Row>
      <Row label="Last activity">
        <RelativeTime iso={job.lastActivityAt} className="tabular" />
      </Row>
      <Row label="Linked emails">
        <span className="tabular">{emailCount}</span>
      </Row>
    </dl>
  );
}
