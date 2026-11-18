"use client";

import { Lock, Minus, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { Settings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { SettingsCard } from "./settings-layout";
import { useSaveSettings } from "./use-save-settings";

const MIN_DAYS = 7;
const MAX_DAYS = 120;

export function AutomationSettings({ settings }: { settings: Settings }) {
  const { save } = useSaveSettings();

  return (
    <SettingsCard>
      <div className="px-4 py-4">
        <NoResponseDays value={settings.noResponseDays} />
      </div>

      <div className="px-4 py-4">
        <Field orientation="horizontal" className="gap-4">
          <FieldContent>
            <FieldLabel htmlFor="create-from-confirmation">
              Create an application from confirmation emails
            </FieldLabel>
            <FieldDescription className="text-xs">
              A confirmation for a job that isn’t in the dashboard adds it as Applied.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="create-from-confirmation"
            checked={settings.createFromConfirmation}
            onCheckedChange={(checked) => save({ createFromConfirmation: checked })}
          />
        </Field>
      </div>

      <div className="px-4 py-4">
        <Field orientation="horizontal" className="gap-4">
          <FieldContent>
            <FieldLabel htmlFor="review-uncertain">
              Send uncertain emails to review
              <Lock aria-hidden className="size-3.5 text-muted-foreground" />
            </FieldLabel>
            <FieldDescription className="text-xs">
              Always on: an email that can’t be matched to one job and status waits in Needs
              review until you confirm it.
            </FieldDescription>
          </FieldContent>
          <Switch id="review-uncertain" checked disabled />
        </Field>
      </div>
    </SettingsCard>
  );
}

/** Number input with −/+ steppers. Saves on blur, Enter or a stepper click. */
function NoResponseDays({ value }: { value: number }) {
  const { save } = useSaveSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [showError, setShowError] = useState(false);

  const text = draft ?? String(value);
  const parsed = Number(text);
  const valid =
    text.trim() !== "" && Number.isInteger(parsed) && parsed >= MIN_DAYS && parsed <= MAX_DAYS;
  const invalid = showError && !valid;

  const commit = () => {
    if (!valid) {
      setShowError(true);
      return;
    }
    setShowError(false);
    setDraft(null);
    if (parsed !== value) save({ noResponseDays: parsed });
  };

  const step = (delta: number) => {
    const base = valid ? parsed : value;
    const next = Math.min(MAX_DAYS, Math.max(MIN_DAYS, base + delta));
    setShowError(false);
    setDraft(null);
    if (next !== value) save({ noResponseDays: next });
  };

  return (
    <Field
      orientation="horizontal"
      data-invalid={invalid || undefined}
      className="flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between"
    >
      <FieldContent>
        <FieldLabel htmlFor="no-response-days">Mark as No response after</FieldLabel>
        <FieldDescription className="text-xs">
          Applications with no reply for this many days move to No response, once your inbox is connected and its first scan has finished. Allowed:{" "}
          {MIN_DAYS}–{MAX_DAYS} days.
        </FieldDescription>
      </FieldContent>
      <div className="flex shrink-0 flex-col gap-1.5 sm:w-auto sm:items-end">
        <div className="flex items-center gap-2">
          <div className="flex items-center">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-10 rounded-r-none md:size-9"
              aria-label="Fewer days"
              onClick={() => step(-1)}
              disabled={valid ? parsed <= MIN_DAYS : value <= MIN_DAYS}
            >
              <Minus aria-hidden />
            </Button>
            <Input
              id="no-response-days"
              type="number"
              inputMode="numeric"
              min={MIN_DAYS}
              max={MAX_DAYS}
              step={1}
              value={text}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? "no-response-days-error" : undefined}
              onChange={(e) => {
                setDraft(e.target.value);
                if (showError) setShowError(false);
              }}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  setDraft(null);
                  setShowError(false);
                }
              }}
              className={cn(
                "h-10 w-16 rounded-none border-x-0 text-center tabular md:h-9",
                "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
              )}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-10 rounded-l-none md:size-9"
              aria-label="More days"
              onClick={() => step(1)}
              disabled={valid ? parsed >= MAX_DAYS : value >= MAX_DAYS}
            >
              <Plus aria-hidden />
            </Button>
          </div>
          <span className="text-sm text-muted-foreground">days</span>
        </div>
        {invalid && (
          <FieldError id="no-response-days-error" className="text-xs">
            Enter a whole number from {MIN_DAYS} to {MAX_DAYS}.
          </FieldError>
        )}
      </div>
    </Field>
  );
}
