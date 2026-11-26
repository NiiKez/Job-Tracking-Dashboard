"use client";

import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { PasteStep } from "@/components/add-job/paste-step";
import { ReviewStep } from "@/components/add-job/review-step";
import type { CaptureStatus } from "@/components/add-job/status-choice";
import {
  EMPTY_JOB_FIELDS,
  isLink,
  withScheme,
  type JobFieldName,
  type JobFieldValues,
  type JobPayload,
} from "@/components/add-job/job-form";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useCreateJob, useParseJob } from "@/lib/api/hooks";
import { DEFAULT_PRIORITY, type Job, type ParseResult, type Priority } from "@/lib/types";
import type { AddJobOptions } from "./add-job-provider";

interface ReviewState {
  /** Bumped per read so the review form re-mounts with fresh values. */
  key: number;
  initial: JobFieldValues;
  missing: JobFieldName[];
  duplicateOf: Job | null;
}

function fromParse(r: ParseResult): Omit<ReviewState, "key"> {
  const parsed: JobFieldValues = {
    title: r.title,
    company: r.company,
    location: r.location,
    url: r.url ?? "",
    description: r.description,
  };
  const dup = r.duplicateOf;
  if (!dup) return { initial: parsed, missing: r.missing, duplicateOf: null };
  // Saving updates the existing entry, so start from what the user already
  // curated there (e.g. "Northwind Labs", not the URL slug "Northwindlabs")
  // and only fill its gaps from the parse.
  const initial: JobFieldValues = {
    title: dup.title || parsed.title,
    company: dup.company || parsed.company,
    location: dup.location || parsed.location,
    url: parsed.url || dup.url || "",
    description:
      parsed.description.length > dup.description.length ? parsed.description : dup.description,
  };
  return {
    initial,
    missing: r.missing.filter((name) => !initial[name].trim()),
    duplicateOf: dup,
  };
}

/**
 * Global "Add job" dialog: paste a link or job text → check the fields →
 * save as Saved or Applied, with a priority (Medium unless picked). Rendered by AddJobProvider with a fresh key on
 * every open, so all state below starts clean.
 */
export function AddJobDialog({
  open,
  onOpenChange,
  options,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: AddJobOptions;
}) {
  const router = useRouter();
  const inputId = useId();
  const parse = useParseJob();
  const create = useCreateJob();

  const [step, setStep] = useState<"paste" | "review">("paste");
  const [input, setInput] = useState(options.input ?? "");
  const [status, setStatus] = useState<CaptureStatus>(options.status ?? "saved");
  const [priority, setPriority] = useState<Priority>(DEFAULT_PRIORITY);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const showReview = (next: Omit<ReviewState, "key">) => {
    setReview((prev) => ({ ...next, key: (prev?.key ?? 0) + 1 }));
    // A job that is already tracked keeps its priority unless the user picks another.
    setPriority(next.duplicateOf?.priority ?? DEFAULT_PRIORITY);
    setStep("review");
  };

  const read = (raw: string) => {
    const text = raw.trim();
    if (!text || parse.isPending) return;
    setReadError(null);
    parse.mutate(isLink(text) ? withScheme(text) : text, {
      onSuccess: (result) => showReview(fromParse(result)),
      onError: (err) => {
        setReadError("We couldn't read that. Check it, or fill in the details yourself.");
        toast.error("Couldn't read the job", { description: err.message });
      },
    });
  };

  const fillManually = () => {
    setReadError(null);
    showReview({ initial: EMPTY_JOB_FIELDS, missing: [], duplicateOf: null });
  };

  // Opened with a prefilled link/text (e.g. from an empty state): read it once.
  const autoRead = useEffectEvent(() => read(options.input ?? ""));
  const autoReadDone = useRef(false);
  useEffect(() => {
    if (!open || autoReadDone.current || !options.input?.trim()) return;
    autoReadDone.current = true;
    autoRead();
  }, [open, options.input]);

  const save = (payload: JobPayload) => {
    if (create.isPending) return;
    create.mutate(
      { ...payload, status, priority, captureMethod: "paste" },
      {
        onSuccess: ({ job, duplicate }) => {
          const title = duplicate
            ? "Updated existing job"
            : status === "applied"
              ? "Added to Applied"
              : "Added to Saved";
          toast.success(title, {
            description: `${job.company} · ${job.title}`,
            action: { label: "View", onClick: () => router.push(`/?job=${job.id}`) },
          });
          onOpenChange(false);
        },
        onError: (err) => toast.error("Couldn't save the job", { description: err.message }),
      },
    );
  };

  // Don't lose a paste or edits to a stray click on the backdrop.
  const hasWork = step === "review" || !!input.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onInteractOutside={(e) => {
          if (hasWork) e.preventDefault();
        }}
      >
        {step === "review" && review ? (
          <ReviewStep
            key={review.key}
            initial={review.initial}
            missing={review.missing}
            duplicateOf={review.duplicateOf}
            status={status}
            onStatusChange={setStatus}
            priority={priority}
            onPriorityChange={setPriority}
            onBack={() => setStep("paste")}
            onSubmit={save}
            onOpenDuplicate={() => onOpenChange(false)}
            saving={create.isPending}
          />
        ) : (
          <PasteStep
            inputId={inputId}
            value={input}
            onChange={(v) => {
              setInput(v);
              if (readError) setReadError(null);
            }}
            onRead={read}
            onManual={fillManually}
            reading={parse.isPending}
            error={readError}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
