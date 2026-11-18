"use client";

import { Check, Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Email, Job, Status } from "@/lib/types";
import { cn } from "@/lib/utils";
import { guessCompany, guessTitle } from "./guess";
import { JobCombobox } from "./job-combobox";
import { StatusSelect } from "./status-select";

const labelClass = "text-xs font-medium text-muted-foreground";

function FieldMessage({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="text-xs text-destructive">
      {children}
    </p>
  );
}

function Spinner() {
  return <Loader2 aria-hidden className="size-4 animate-spin" />;
}

/* ---------------------------------------------------------- assign form */

/** Pick any application + status. Used for "Choose differently". */
export function AssignForm({
  idBase,
  jobs,
  suggestedIds,
  defaultJobId,
  defaultStatus,
  pending,
  disabled,
  primary,
  onSubmit,
}: {
  idBase: string;
  jobs: Job[];
  suggestedIds: string[];
  defaultJobId?: string;
  defaultStatus?: Status | null;
  pending: boolean;
  disabled: boolean;
  /** Render "Apply" as the main action (when there is no suggestion to confirm). */
  primary?: boolean;
  onSubmit: (jobId: string, status: Status) => void;
}) {
  const [jobId, setJobId] = useState(defaultJobId ?? "");
  const [status, setStatus] = useState<Status | "">(defaultStatus ?? "");
  const [tried, setTried] = useState(false);
  const jobError = tried && !jobId;
  const statusError = tried && !status;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (jobId && status) onSubmit(jobId, status);
      }}
      className="grid gap-3 @xl/decision:grid-cols-[minmax(0,1fr)_10.5rem_auto] @xl/decision:items-start"
    >
      <div className="grid min-w-0 gap-1.5">
        <Label htmlFor={`${idBase}-job`} className={labelClass}>
          Application
        </Label>
        <JobCombobox
          id={`${idBase}-job`}
          jobs={jobs}
          suggestedIds={suggestedIds}
          value={jobId}
          onChange={setJobId}
          disabled={disabled}
          invalid={jobError}
          aria-describedby={jobError ? `${idBase}-job-error` : undefined}
        />
        {jobError && <FieldMessage id={`${idBase}-job-error`}>Choose an application.</FieldMessage>}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idBase}-status`} className={labelClass}>
          New status
        </Label>
        <StatusSelect
          id={`${idBase}-status`}
          value={status}
          onValueChange={setStatus}
          disabled={disabled}
          invalid={statusError}
          aria-describedby={statusError ? `${idBase}-status-error` : undefined}
        />
        {statusError && <FieldMessage id={`${idBase}-status-error`}>Choose a status.</FieldMessage>}
      </div>
      <Button
        type="submit"
        variant={primary ? "default" : "outline"}
        disabled={disabled}
        aria-busy={pending || undefined}
        className={cn("h-10 gap-1.5 sm:h-8 @xl/decision:mt-[22px]", !primary && "bg-background")}
      >
        {pending ? <Spinner /> : <Check aria-hidden className="size-4" />}
        {pending ? "Applying…" : "Apply"}
      </Button>
    </form>
  );
}

/* ---------------------------------------------------------- create form */

/** No application matches: add one from the email (company + title prefilled with a guess). */
export function CreateForm({
  idBase,
  email,
  pending,
  disabled,
  onSubmit,
}: {
  idBase: string;
  email: Email;
  pending: boolean;
  disabled: boolean;
  onSubmit: (input: { company: string; title: string; status: Status }) => void;
}) {
  const [company, setCompany] = useState(() => guessCompany(email));
  const [title, setTitle] = useState(() => guessTitle(email));
  const [status, setStatus] = useState<Status>(email.suggestedStatus ?? "applied");
  const [tried, setTried] = useState(false);
  const [guessed] = useState(() => !!(company || title));
  const companyError = tried && !company.trim();
  const titleError = tried && !title.trim();

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (company.trim() && title.trim()) {
          onSubmit({ company: company.trim(), title: title.trim(), status });
        }
      }}
      className="grid items-start gap-3 @md/decision:grid-cols-2"
    >
      <div className="grid gap-1.5">
        <Label htmlFor={`${idBase}-company`} className={labelClass}>
          Company
          <span aria-hidden className="-ml-1.5 text-destructive">
            *
          </span>
        </Label>
        <Input
          id={`${idBase}-company`}
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          required
          autoComplete="off"
          placeholder="e.g. Meridian Consulting"
          disabled={disabled}
          aria-invalid={companyError || undefined}
          aria-describedby={companyError ? `${idBase}-company-error` : undefined}
          className="h-10 bg-background sm:h-8"
        />
        {companyError && <FieldMessage id={`${idBase}-company-error`}>Enter the company name.</FieldMessage>}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idBase}-title`} className={labelClass}>
          Job title
          <span aria-hidden className="-ml-1.5 text-destructive">
            *
          </span>
        </Label>
        <Input
          id={`${idBase}-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          autoComplete="off"
          placeholder="e.g. Frontend Engineer"
          disabled={disabled}
          aria-invalid={titleError || undefined}
          aria-describedby={titleError ? `${idBase}-title-error` : undefined}
          className="h-10 bg-background sm:h-8"
        />
        {titleError && <FieldMessage id={`${idBase}-title-error`}>Enter the job title.</FieldMessage>}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idBase}-create-status`} className={labelClass}>
          Status
        </Label>
        <StatusSelect
          id={`${idBase}-create-status`}
          value={status}
          onValueChange={setStatus}
          disabled={disabled}
        />
      </div>
      <div className="flex flex-col @md/decision:pt-[22px]">
        <Button
          type="submit"
          disabled={disabled}
          aria-busy={pending || undefined}
          className="h-10 gap-1.5 sm:h-8"
        >
          {pending ? <Spinner /> : <Plus aria-hidden className="size-4" />}
          {pending ? "Creating…" : "Create application"}
        </Button>
      </div>
      {guessed && (
        <p className="text-xs text-muted-foreground @md/decision:col-span-2">
          Company and title are a guess from the sender and subject. Check them before creating.
        </p>
      )}
    </form>
  );
}
