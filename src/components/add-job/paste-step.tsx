"use client";

import { ArrowRight, FileText, Link2, Loader2, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { isSubmitShortcut, StepFooter, StepIndicator, SubmitShortcut } from "./dialog-parts";
import { isLink } from "./job-form";

type Detected = "link" | "text" | null;

export function detectInput(raw: string): Detected {
  const t = raw.trim();
  if (!t) return null;
  if (isLink(t)) return "link";
  // A few words at least before we call it job text.
  return t.length >= 12 || t.includes("\n") ? "text" : null;
}

function DetectionChip({ kind }: { kind: Detected }) {
  return (
    <span aria-live="polite" className="min-h-6">
      {kind && (
        <span
          key={kind}
          className="inline-flex h-6 items-center gap-1 rounded-full border bg-muted/60 px-2 text-xs font-medium text-muted-foreground duration-150 animate-in fade-in-0"
        >
          {kind === "link" ? (
            <Link2 aria-hidden className="size-3.5" />
          ) : (
            <FileText aria-hidden className="size-3.5" />
          )}
          {kind === "link" ? "Link detected" : "Job text detected"}
        </span>
      )}
    </span>
  );
}

/**
 * Step 1: one box for a link or the full job text. Pasting into the empty
 * box reads it right away, so a typical link is paste + one click to save.
 */
export function PasteStep({
  inputId,
  value,
  onChange,
  onRead,
  onManual,
  reading,
  error,
}: {
  inputId: string;
  value: string;
  onChange: (value: string) => void;
  onRead: (value: string) => void;
  onManual: () => void;
  reading: boolean;
  error: string | null;
}) {
  const kind = detectInput(value);
  const canRead = !!value.trim() && !reading;

  return (
    <>
      <DialogHeader className="shrink-0 gap-1.5 px-4 pt-4 pr-12 pb-3 sm:px-5 sm:pt-5">
        <StepIndicator step={1} />
        <DialogTitle className="text-lg font-semibold tracking-tight">Add a job</DialogTitle>
        <DialogDescription>
          Paste a job link or the job ad. We fill in the details, you check them.
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-5 sm:px-5">
        <Field data-invalid={error ? true : undefined} className="gap-1.5">
          <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <FieldLabel htmlFor={inputId}>Job link or job text</FieldLabel>
            <DetectionChip kind={kind} />
          </div>
          <Textarea
            id={inputId}
            value={value}
            autoFocus
            spellCheck={false}
            readOnly={reading}
            aria-busy={reading || undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${inputId}-helper${error ? ` ${inputId}-error` : ""}`}
            placeholder={"https://boards.greenhouse.io/acme/jobs/123\n\nor paste the whole job ad here"}
            onChange={(e) => onChange(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData("text/plain");
              if (value.trim() || !pasted.trim() || reading) return;
              e.preventDefault();
              onChange(pasted);
              onRead(pasted);
            }}
            onKeyDown={(e) => {
              if (isSubmitShortcut(e) && canRead) {
                e.preventDefault();
                onRead(value);
              }
            }}
            className="max-h-[40vh] min-h-36 overflow-y-auto text-sm leading-relaxed read-only:opacity-70"
          />
          <FieldDescription id={`${inputId}-helper`} className="text-xs">
            A link to the posting works best. If the site needs a login, or you found the job in an
            email, copy the whole ad and paste the text instead.
          </FieldDescription>
          {error && (
            <FieldError id={`${inputId}-error`} className="text-xs">
              {error}
            </FieldError>
          )}
        </Field>
      </div>

      <StepFooter className="justify-end">
        <Button
          type="button"
          variant="outline"
          className="h-10 sm:h-9"
          onClick={onManual}
          disabled={reading}
        >
          <PenLine aria-hidden />
          Fill in manually
        </Button>
        <Button
          type="button"
          className="h-10 min-w-28 sm:h-9"
          onClick={() => onRead(value)}
          disabled={!canRead}
        >
          {reading ? (
            <>
              <Loader2 aria-hidden className="animate-spin" />
              Reading…
            </>
          ) : (
            <>
              Read job
              <ArrowRight aria-hidden />
              <SubmitShortcut />
            </>
          )}
        </Button>
      </StepFooter>
    </>
  );
}
