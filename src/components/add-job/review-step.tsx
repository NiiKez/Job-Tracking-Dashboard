"use client";

import { ArrowLeft, Bookmark, Info, Loader2, RefreshCw, Send } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/jobs/status-badge";
import { STATUS_META } from "@/lib/status";
import type { Job } from "@/lib/types";
import { isSubmitShortcut, StepFooter, StepIndicator, SubmitShortcut } from "./dialog-parts";
import { JobFields } from "./job-fields";
import type { JobFieldName, JobFieldValues, JobPayload } from "./job-form";
import { StatusChoice, type CaptureStatus } from "./status-choice";
import { useJobFields } from "./use-job-fields";

function DuplicateNotice({ job, onOpen }: { job: Job; onOpen: () => void }) {
  return (
    <Alert className="border-attention/35 bg-attention-subtle">
      <Info aria-hidden className="text-attention!" />
      <AlertTitle className="text-foreground">Already in your dashboard</AlertTitle>
      <AlertDescription className="text-pretty text-foreground/80">
        <p className="mb-1! flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-foreground">
            {job.company} · {job.title}
          </span>
          <StatusBadge status={job.status} className="ring-1 ring-current/15" />
        </p>
        <p>
          Saving updates that entry instead of creating a duplicate.
          {job.status !== "saved" && <> Its status stays {STATUS_META[job.status].label}.</>}{" "}
          <Link
            href={`/?job=${job.id}`}
            onClick={onOpen}
            className="font-medium text-foreground underline-offset-4 hover:text-primary"
          >
            Open it
          </Link>
        </p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Step 2: check the fields, pick Saved or Applied, save. Owns its own form
 * state; the dialog re-mounts it (new key) for every read.
 */
export function ReviewStep({
  initial,
  missing,
  duplicateOf,
  status,
  onStatusChange,
  onBack,
  onSubmit,
  onOpenDuplicate,
  saving,
}: {
  initial: JobFieldValues;
  missing: readonly JobFieldName[];
  duplicateOf: Job | null;
  status: CaptureStatus;
  onStatusChange: (s: CaptureStatus) => void;
  onBack: () => void;
  onSubmit: (payload: JobPayload) => void;
  onOpenDuplicate: () => void;
  saving: boolean;
}) {
  const form = useJobFields(initial);
  const statusId = useId();

  // Land on the first required field we couldn't fill; otherwise on Save.
  const focusField: JobFieldName | undefined = !initial.title.trim()
    ? "title"
    : !initial.company.trim()
      ? "company"
      : undefined;

  const submit = () => {
    if (saving) return;
    const payload = form.submit();
    if (payload) onSubmit(payload);
  };

  const SubmitIcon = duplicateOf ? RefreshCw : status === "applied" ? Send : Bookmark;
  const submitLabel = duplicateOf
    ? "Update existing job"
    : status === "applied"
      ? "Add as applied"
      : "Save job";

  return (
    <>
      <DialogHeader className="shrink-0 gap-1.5 px-4 pt-4 pr-12 pb-3 sm:px-5 sm:pt-5">
        <StepIndicator step={2} />
        <DialogTitle className="text-lg font-semibold tracking-tight">Check the details</DialogTitle>
        <DialogDescription>
          Fix anything that looks off, then choose where the job goes.
        </DialogDescription>
      </DialogHeader>

      <form
        noValidate
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (isSubmitShortcut(e)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pt-1 pb-5 sm:px-5">
          {duplicateOf && <DuplicateNotice job={duplicateOf} onOpen={onOpenDuplicate} />}
          <JobFields form={form} missing={missing} collapseLongDescription autoFocus={focusField} />
          <StatusChoice value={status} onChange={onStatusChange} idPrefix={statusId} />
        </div>

        <StepFooter>
          <Button
            type="button"
            variant="ghost"
            className="-ml-2 h-10 sm:h-9"
            onClick={onBack}
            disabled={saving}
          >
            <ArrowLeft aria-hidden />
            Back
          </Button>
          <Button
            type="submit"
            className="ml-auto h-10 sm:h-9"
            autoFocus={!focusField}
            aria-busy={saving || undefined}
          >
            {saving ? (
              <Loader2 aria-hidden className="animate-spin" />
            ) : (
              <SubmitIcon aria-hidden />
            )}
            {submitLabel}
            <SubmitShortcut />
          </Button>
        </StepFooter>
      </form>
    </>
  );
}
