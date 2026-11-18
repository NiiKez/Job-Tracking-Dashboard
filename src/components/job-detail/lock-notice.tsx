"use client";

import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useUpdateJob } from "@/lib/api/hooks";
import type { Job } from "@/lib/types";

/** Shown while a manual status change blocks email updates. */
export function LockNotice({ job }: { job: Pick<Job, "id"> }) {
  const update = useUpdateJob();
  const unlock = () =>
    update.mutate(
      { id: job.id, patch: { statusLocked: false } },
      {
        onSuccess: () => toast.success("Emails can update this status again"),
        onError: (err) => toast.error("Couldn't change that", { description: err.message }),
      },
    );

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-surface-sunken px-3 py-2.5 @md:flex-row @md:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          You set this status by hand, so emails won&apos;t change it.
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="self-start max-sm:h-10 @md:self-auto"
        onClick={unlock}
        disabled={update.isPending}
      >
        {update.isPending && <Loader2 aria-hidden className="animate-spin" />}
        Let emails update it
      </Button>
    </div>
  );
}
