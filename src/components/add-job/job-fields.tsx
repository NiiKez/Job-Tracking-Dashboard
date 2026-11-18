"use client";

import { ChevronDown, ChevronUp, CircleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { JobFieldName } from "./job-form";
import type { JobFieldsState } from "./use-job-fields";

const LONG_DESCRIPTION_CHARS = 420;
const LONG_DESCRIPTION_LINES = 8;

export function RequiredMark() {
  return (
    <span aria-hidden className="-ml-1 text-destructive">
      *
    </span>
  );
}

function MissingHint({ id }: { id: string }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-xs leading-snug text-attention">
      <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      Couldn&apos;t find this on the page — please fill it in
    </p>
  );
}

function describedBy(...ids: Array<string | false | undefined>) {
  return ids.filter(Boolean).join(" ") || undefined;
}

function TextField({
  form,
  name,
  label,
  required,
  missing,
  autoFocus,
  placeholder,
  helper,
  inputMode,
  autoComplete = "off",
  className,
}: {
  form: JobFieldsState;
  name: Exclude<JobFieldName, "description">;
  label: string;
  required?: boolean;
  missing?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  helper?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  autoComplete?: string;
  className?: string;
}) {
  const id = form.fieldId(name);
  const error = form.errors[name];
  const showMissing = !!missing && !form.values[name].trim() && !error;
  return (
    <Field data-invalid={error ? true : undefined} className={cn("gap-1.5", className)}>
      <FieldLabel htmlFor={id}>
        {label}
        {required && <RequiredMark />}
      </FieldLabel>
      <Input
        id={id}
        name={name}
        value={form.values[name]}
        onChange={(e) => form.setField(name, e.target.value)}
        onBlur={() => form.blurField(name)}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={describedBy(
          helper && `${id}-helper`,
          showMissing && `${id}-missing`,
          error && `${id}-error`,
        )}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        inputMode={inputMode}
        spellCheck={name === "url" ? false : undefined}
        placeholder={placeholder}
        className={cn(
          "h-10 md:h-9",
          showMissing && "border-attention/60",
        )}
      />
      {helper && !showMissing && !error && (
        <FieldDescription id={`${id}-helper`} className="text-xs">
          {helper}
        </FieldDescription>
      )}
      {showMissing && <MissingHint id={`${id}-missing`} />}
      {error && (
        <FieldError id={`${id}-error`} className="text-xs">
          {error}
        </FieldError>
      )}
    </Field>
  );
}

function DescriptionField({
  form,
  missing,
  collapsible,
}: {
  form: JobFieldsState;
  missing?: boolean;
  collapsible?: boolean;
}) {
  const id = form.fieldId("description");
  const value = form.values.description;
  const isLong =
    value.length > LONG_DESCRIPTION_CHARS || value.split("\n").length > LONG_DESCRIPTION_LINES;
  const [expanded, setExpanded] = useState(!collapsible || !isLong);
  const showMissing = !!missing && !value.trim();

  return (
    <Field className="gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={expanded ? id : undefined}>Description</FieldLabel>
        {collapsible && isLong && expanded && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="-mr-1.5 text-muted-foreground"
            aria-controls={id}
            aria-expanded
            onClick={() => setExpanded(false)}
          >
            Hide description
            <ChevronUp aria-hidden />
          </Button>
        )}
      </div>
      {expanded ? (
        <Textarea
          id={id}
          name="description"
          value={value}
          onChange={(e) => form.setField("description", e.target.value)}
          aria-describedby={describedBy(`${id}-helper`, showMissing && `${id}-missing`)}
          placeholder="Paste the job description, or leave it empty."
          className="max-h-[40vh] min-h-24 overflow-y-auto leading-relaxed"
        />
      ) : (
        <div className="rounded-lg border bg-surface-sunken px-3 py-2.5">
          <p className="line-clamp-3 text-sm whitespace-pre-line text-muted-foreground">{value}</p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground tabular">
              {value.length.toLocaleString("en-US")} characters
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-sm:h-10"
              aria-controls={id}
              aria-expanded={false}
              onClick={() => setExpanded(true)}
            >
              Show description
              <ChevronDown aria-hidden />
            </Button>
          </div>
        </div>
      )}
      {showMissing ? (
        <MissingHint id={`${id}-missing`} />
      ) : (
        <FieldDescription id={`${id}-helper`} className="text-xs">
          Optional. Handy later when you prepare for an interview.
        </FieldDescription>
      )}
    </Field>
  );
}

/**
 * Title*, Company*, Location, Link, Description. Two columns when the
 * container is wide enough (works inside dialogs and sheets alike).
 */
export function JobFields({
  form,
  missing = [],
  collapseLongDescription = false,
  autoFocus,
}: {
  form: JobFieldsState;
  /** Fields the parser couldn't fill: shows an amber hint while still empty. */
  missing?: readonly JobFieldName[];
  collapseLongDescription?: boolean;
  autoFocus?: JobFieldName;
}) {
  const isMissing = (name: JobFieldName) => missing.includes(name);
  return (
    <div className="@container/fields">
      <div className="grid gap-4 @md/fields:grid-cols-2">
        <TextField
          form={form}
          name="title"
          label="Title"
          required
          missing={isMissing("title")}
          autoFocus={autoFocus === "title"}
          placeholder="e.g. Senior Frontend Engineer"
          className="@md/fields:col-span-2"
        />
        <TextField
          form={form}
          name="company"
          label="Company"
          required
          missing={isMissing("company")}
          autoFocus={autoFocus === "company"}
          placeholder="e.g. Acme GmbH"
          autoComplete="organization"
        />
        <TextField
          form={form}
          name="location"
          label="Location"
          missing={isMissing("location")}
          autoFocus={autoFocus === "location"}
          placeholder="e.g. Berlin or Remote"
        />
        <TextField
          form={form}
          name="url"
          label="Link"
          missing={isMissing("url")}
          autoFocus={autoFocus === "url"}
          placeholder="https://company.com/jobs/123"
          helper="The original job posting. Also used to spot duplicates."
          inputMode="url"
          autoComplete="url"
          className="@md/fields:col-span-2"
        />
        <div className="@md/fields:col-span-2">
          <DescriptionField
            form={form}
            missing={isMissing("description")}
            collapsible={collapseLongDescription}
          />
        </div>
      </div>
    </div>
  );
}
