/**
 * Shared field model + validation for the "Add job" review step and the
 * inline "Edit details" form on the job detail view.
 */

export interface JobFieldValues {
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
}

export type JobFieldName = keyof JobFieldValues;
export type JobFieldErrors = Partial<Record<JobFieldName, string>>;

/** Visual + focus order of the fields. */
export const JOB_FIELD_ORDER: JobFieldName[] = ["title", "company", "location", "url", "description"];

export const EMPTY_JOB_FIELDS: JobFieldValues = {
  title: "",
  company: "",
  location: "",
  url: "",
  description: "",
};

/** Looks like "company.com/jobs/1" or "https://…" (no spaces). */
const LINK_RE = /^(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;

/** True when the whole input is a single link (with or without https://). */
export function isLink(raw: string) {
  const t = raw.trim();
  return !!t && !/\s/.test(t) && (LINK_RE.test(t) || /^https?:\/\/\S+$/i.test(t));
}

/** Adds https:// to bare links so the parser treats them as URLs. */
export function withScheme(raw: string) {
  const t = raw.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

/**
 * Normalizes the link field. Empty is fine (no link). Bare domains get
 * https:// added. Returns undefined when it can't be a web link.
 */
export function normalizeUrl(raw: string): string | null | undefined {
  const t = raw.trim();
  if (!t) return null;
  if (/\s/.test(t)) return undefined;
  try {
    const url = new URL(withScheme(t));
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function validateJobFields(v: JobFieldValues): JobFieldErrors {
  const errors: JobFieldErrors = {};
  if (!v.title.trim()) errors.title = "Add the job title.";
  else if (v.title.trim().length > 200) errors.title = "Keep the title under 200 characters.";
  if (!v.company.trim()) errors.company = "Add the company name.";
  else if (v.company.trim().length > 200) errors.company = "Keep the company under 200 characters.";
  if (v.location.trim().length > 200) errors.location = "Keep the location under 200 characters.";
  if (normalizeUrl(v.url) === undefined) {
    errors.url = "Enter a full link, like https://company.com/jobs/123.";
  }
  return errors;
}

export interface JobPayload {
  title: string;
  company: string;
  location: string;
  url: string | null;
  description: string;
}

/** Trimmed values ready for the API (call only after validation passed). */
export function toJobPayload(v: JobFieldValues): JobPayload {
  return {
    title: v.title.trim(),
    company: v.company.trim(),
    location: v.location.trim(),
    url: normalizeUrl(v.url) ?? null,
    description: v.description.trim(),
  };
}
