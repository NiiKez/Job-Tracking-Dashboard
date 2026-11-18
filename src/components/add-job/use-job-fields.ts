"use client";

import { useCallback, useId, useMemo, useState } from "react";
import {
  JOB_FIELD_ORDER,
  toJobPayload,
  validateJobFields,
  type JobFieldErrors,
  type JobFieldName,
  type JobFieldValues,
} from "./job-form";

/**
 * Form state for the five job fields. Errors show after a field was left
 * (blur) or after the first submit attempt, then update live while typing.
 */
export function useJobFields(initial: JobFieldValues) {
  const idPrefix = useId();
  const [values, setValues] = useState(initial);
  const [touched, setTouched] = useState<Partial<Record<JobFieldName, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);

  const allErrors = useMemo(() => validateJobFields(values), [values]);
  const errors = useMemo(() => {
    const out: JobFieldErrors = {};
    for (const name of JOB_FIELD_ORDER) {
      if (allErrors[name] && (submitted || touched[name])) out[name] = allErrors[name];
    }
    return out;
  }, [allErrors, submitted, touched]);

  const setField = useCallback((name: JobFieldName, value: string) => {
    setValues((v) => ({ ...v, [name]: value }));
  }, []);

  const blurField = useCallback((name: JobFieldName) => {
    setTouched((t) => (t[name] ? t : { ...t, [name]: true }));
  }, []);

  const fieldId = useCallback((name: JobFieldName) => `${idPrefix}-${name}`, [idPrefix]);

  /** Returns the API payload, or null after focusing the first invalid field. */
  const submit = useCallback(() => {
    setSubmitted(true);
    const first = JOB_FIELD_ORDER.find((name) => allErrors[name]);
    if (first) {
      document.getElementById(fieldId(first))?.focus();
      return null;
    }
    return toJobPayload(values);
  }, [allErrors, fieldId, values]);

  const dirty = useMemo(
    () => JOB_FIELD_ORDER.some((name) => values[name] !== initial[name]),
    [values, initial],
  );

  return { values, errors, setField, blurField, fieldId, submit, dirty };
}

export type JobFieldsState = ReturnType<typeof useJobFields>;
