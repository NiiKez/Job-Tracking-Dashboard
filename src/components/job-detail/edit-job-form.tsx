"use client";

import { Check, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { isSubmitShortcut, SubmitShortcut } from "@/components/add-job/dialog-parts";
import { JobFields } from "@/components/add-job/job-fields";
import type { JobFieldValues } from "@/components/add-job/job-form";
import { useJobFields } from "@/components/add-job/use-job-fields";
import { Button } from "@/components/ui/button";
import { useUpdateJob } from "@/lib/api/hooks";
import type { Job } from "@/lib/types";

function fieldsOf(job: Job): JobFieldValues {
  return {
    title: job.title,
    company: job.company,
    location: job.location,
    url: job.url ?? "",
    description: job.description,
  };
}

/** Inline "Edit details" form that replaces the header + description. */
export function EditJobForm({ job, onDone }: { job: Job; onDone: () => void }) {
  const [initial] = useState(() => fieldsOf(job));
  const form = useJobFields(initial);
  const update = useUpdateJob();
  const headingId = useId();

  const save = () => {
    if (update.isPending) return;
    const payload = form.submit();
    if (!payload) return;
    if (!form.dirty) {
      onDone();
      return;
    }
    update.mutate(
      { id: job.id, patch: payload },
      {
        onSuccess: () => {
          toast.success("Changes saved", { description: `${payload.company} · ${payload.title}` });
          onDone();
        },
        onError: (err) => toast.error("Couldn't save your changes", { description: err.message }),
      },
    );
  };

  return (
    <form
      noValidate
      aria-labelledby={headingId}
      className="flex flex-col gap-5 rounded-lg border bg-card p-4 sm:p-5"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (isSubmitShortcut(e)) {
          e.preventDefault();
          save();
        }
      }}
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold tracking-tight">
          Edit details
        </h2>
        <p className="text-sm text-muted-foreground">
          Changes apply right away on the dashboard. The status is changed from the status menu.
        </p>
      </div>
      <JobFields form={form} autoFocus="title" />
      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          className="h-10 sm:h-9"
          onClick={onDone}
          disabled={update.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" className="h-10 sm:h-9" aria-busy={update.isPending || undefined}>
          {update.isPending ? (
            <Loader2 aria-hidden className="animate-spin" />
          ) : (
            <Check aria-hidden />
          )}
          Save changes
          <SubmitShortcut />
        </Button>
      </div>
    </form>
  );
}
