"use client";

import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useUpdateJob } from "@/lib/api/hooks";
import type { JobPatch } from "@/lib/api/client";
import { daysUntil, formatDate, formatDateTime, formatWhen } from "@/lib/format";
import type { Job } from "@/lib/types";
import { cn } from "@/lib/utils";

/*
 * The two dates the dashboard cards are built around: the next interview
 * (Interview stage) and the respond-by date (Offer stage). Edited inline from
 * the job's Details.
 */

function useSave(jobId: string) {
  const update = useUpdateJob();
  const save = (patch: JobPatch, done: () => void) =>
    update.mutate(
      { id: jobId, patch },
      {
        onSuccess: done,
        onError: (err) => toast.error("Couldn't save the date", { description: err.message }),
      },
    );
  return { save, pending: update.isPending };
}

function EditPopover({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" className="max-sm:h-8">
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function FormActions({
  pending,
  onCancel,
  onRemove,
}: {
  pending: boolean;
  onCancel: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 pt-1">
      <Button type="submit" size="sm" disabled={pending}>
        {pending && <Loader2 aria-hidden className="animate-spin" />}
        Save
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto text-muted-foreground"
          disabled={pending}
          onClick={onRemove}
        >
          Remove
        </Button>
      )}
    </div>
  );
}

export function NextInterviewField({ job }: { job: Job }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const { save, pending } = useSave(job.id);
  const next = job.nextInterview;
  const upcoming = next ? daysUntil(next.at) >= 0 : false;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const at = String(form.get("at") ?? "");
    if (!at) return;
    const round = String(form.get("round") ?? "").trim();
    save({ nextInterview: { at: new Date(at).toISOString(), round } }, () => setOpen(false));
  };

  return (
    <>
      {next ? (
        <span className="flex min-w-0 flex-col">
          <time
            dateTime={next.at}
            title={formatDateTime(next.at)}
            className={cn("tabular", upcoming ? "font-medium" : "text-muted-foreground")}
          >
            {upcoming ? formatWhen(next.at) : `${formatDateTime(next.at)} · past`}
          </time>
          {next.round && <span className="text-xs text-muted-foreground">{next.round}</span>}
        </span>
      ) : (
        <span className="text-muted-foreground">Not set</span>
      )}
      <EditPopover label={next ? "Change" : "Add date"} open={open} onOpenChange={setOpen}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-at`}>Date and time</Label>
            <Input
              id={`${id}-at`}
              name="at"
              type="datetime-local"
              required
              defaultValue={next ? format(new Date(next.at), "yyyy-MM-dd'T'HH:mm") : ""}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-round`}>
              Round <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id={`${id}-round`}
              name="round"
              maxLength={80}
              placeholder="Technical interview"
              defaultValue={next?.round ?? ""}
            />
          </div>
          <FormActions
            pending={pending}
            onCancel={() => setOpen(false)}
            onRemove={next ? () => save({ nextInterview: null }, () => setOpen(false)) : undefined}
          />
        </form>
      </EditPopover>
    </>
  );
}

export function OfferDeadlineField({ job }: { job: Job }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const { save, pending } = useSave(job.id);
  const due = job.offerDeadline;
  const left = due ? daysUntil(due) : null;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const day = String(new FormData(e.currentTarget).get("due") ?? "");
    if (!day) return;
    // Respond *by* that day: store the end of it, in local time.
    save({ offerDeadline: new Date(`${day}T23:59`).toISOString() }, () => setOpen(false));
  };

  return (
    <>
      {due && left !== null ? (
        <span className="font-medium text-attention tabular">
          <time dateTime={due}>{formatDate(due)}</time>
          <span className="font-normal">
            {left > 1
              ? ` · ${left} days left`
              : left === 1
                ? " · tomorrow"
                : left === 0
                  ? " · today"
                  : " · passed"}
          </span>
        </span>
      ) : (
        <span className="text-muted-foreground">Not set</span>
      )}
      <EditPopover label={due ? "Change" : "Add date"} open={open} onOpenChange={setOpen}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-due`}>Respond by</Label>
            <Input
              id={`${id}-due`}
              name="due"
              type="date"
              required
              defaultValue={due ? format(new Date(due), "yyyy-MM-dd") : ""}
            />
          </div>
          <FormActions
            pending={pending}
            onCancel={() => setOpen(false)}
            onRemove={due ? () => save({ offerDeadline: null }, () => setOpen(false)) : undefined}
          />
        </form>
      </EditPopover>
    </>
  );
}
