import {
  EMPTY_JOB_FIELDS,
  JOB_FIELD_ORDER,
  type JobFieldName,
  type JobFieldValues,
} from "@/components/add-job/job-form";
import type { Job, PageSnapshot, Priority } from "@/lib/types";
import { isDisconnected, type Api } from "../lib/api";
import { readDraft } from "../lib/storage";
import { readTab, webAddress, type TargetTab } from "../lib/tab";

/*
 * Step 2 of the popup (docs/plan/4-chrome-extension.md, Popup): read the page in the target
 * tab, let the tracker turn that into job fields, and lay any unsaved edits from an earlier
 * opening on top. The form opens whatever happens here, so the job can always be typed in:
 *
 * - a page Chrome doesn't let extensions script: empty fields, the link when it is a web page;
 * - the tracker unreachable or failing: what the site reader found, cut to what the tracker
 *   saves, and the error with Try again (or Allow access, when its site access was withdrawn);
 * - the key routes' 401 (the key was refused) is the one failure that is thrown: the popup
 *   forgets the connection.
 *
 * A job the tracker already has starts from what the tracker stored (fromStoredJob), and shows
 * its stored priority (priority.tsx).
 */

export type ReadNotice =
  | { kind: "unreadable" }
  /** An ApiError, or a bug's error. */
  | { kind: "failed"; error: unknown };

export interface ReadOutcome {
  /**
   * What the tracker made of the page (for a duplicate, what it stored, gaps filled from the
   * page): the base the user's edits are measured against.
   */
  initial: JobFieldValues;
  /** `initial` with the edits of an earlier opening of the popup on this page. */
  values: JobFieldValues;
  missing: JobFieldName[];
  duplicateOf: Job | null;
  notice: ReadNotice | null;
  /** The priority picked in an earlier opening of the popup on this page; null when none was. */
  chosenPriority: Priority | null;
}

/** The page's address as tabs report it; drafts are kept per tab and address. */
export function draftAddress(tab: TargetTab | null) {
  return tab?.url ?? null;
}

/** Empty fields, but the tab's link when it is a web page: the form when nothing could be read. */
export function emptyRead(tab: TargetTab | null, notice: ReadNotice): ReadOutcome {
  const initial = { ...EMPTY_JOB_FIELDS, url: (tab && webAddress(tab)) ?? "" };
  return { initial, values: initial, missing: [], duplicateOf: null, notice, chosenPriority: null };
}

/**
 * The fields for a job already in the tracker: what it stored, with only its empty fields filled
 * from the page. Starting from the page would quietly undo corrections made in the tracker:
 * saving sends every field, and the tracker takes each one that isn't empty.
 */
export function fromStoredJob(job: Job, page: JobFieldValues): JobFieldValues {
  const fields: JobFieldValues = {
    title: job.title,
    company: job.company,
    location: job.location,
    url: job.url ?? "",
    description: job.description,
  };
  for (const name of JOB_FIELD_ORDER) {
    if (!fields[name].trim()) fields[name] = page[name];
  }
  return fields;
}

/**
 * The job input limits (jobInputSchema in src/lib/server/schemas.ts; MAX_FIELD and
 * MAX_DESCRIPTION in src/lib/server/parse/limits.ts, which is server-only and can't be bundled
 * here). tests/extension/shell/read-job.test.ts checks them against the schema.
 */
export const MAX_FIELD = 200;
export const MAX_DESCRIPTION = 50_000;

/**
 * A field as the tracker's parser would return it (fit in limits.ts): without NUL characters,
 * which the tracker refuses in any request, well-formed, trimmed, and cut to `max` UTF-16 units
 * without leaving half of a surrogate pair.
 */
function fit(value: string, max: number) {
  const text = value.replace(/\u0000/g, "").toWellFormed().trim();
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/**
 * What the site reader found, for when the tracker can't be asked. A reader may keep more text
 * than the tracker saves (and the page may hold a NUL), so each field is cut to the job input
 * limits here, as the tracker's parser does: the form must be saveable as it opens.
 */
function fromSnapshot(snapshot: PageSnapshot): JobFieldValues {
  const fields = snapshot.site?.fields ?? {};
  return {
    title: fit(fields.title ?? "", MAX_FIELD),
    company: fit(fields.company ?? "", MAX_FIELD),
    location: fit(fields.location ?? "", MAX_FIELD),
    // A link isn't cut (half a link is no link); the snapshot's limits keep it short.
    url: (fields.url ?? snapshot.url).replace(/\u0000/g, "").toWellFormed().trim(),
    description: fit(fields.description ?? "", MAX_DESCRIPTION),
  };
}

async function readFields(
  api: Api,
  tab: TargetTab | null,
): Promise<Omit<ReadOutcome, "values" | "chosenPriority">> {
  const snapshot = tab ? await readTab(tab) : null;
  if (!snapshot) return emptyRead(tab, { kind: "unreadable" });
  try {
    const parsed = await api.read(snapshot);
    const fromPage: JobFieldValues = {
      title: parsed.title,
      company: parsed.company,
      location: parsed.location,
      url: parsed.url ?? "",
      description: parsed.description,
    };
    return {
      initial: parsed.duplicateOf ? fromStoredJob(parsed.duplicateOf, fromPage) : fromPage,
      missing: parsed.missing,
      duplicateOf: parsed.duplicateOf,
      notice: null,
    };
  } catch (error) {
    if (isDisconnected(error)) throw error;
    return {
      initial: fromSnapshot(snapshot),
      missing: [],
      duplicateOf: null,
      notice: { kind: "failed", error },
    };
  }
}

export async function readJob(api: Api, tab: TargetTab | null): Promise<ReadOutcome> {
  const read = await readFields(api, tab);
  const address = draftAddress(tab);
  const draft = tab && address ? await readDraft(tab.id, address) : null;
  const values = { ...read.initial };
  for (const name of Object.keys(values) as JobFieldName[]) {
    const edited = draft?.edits[name];
    if (edited !== undefined) values[name] = edited;
  }
  return { ...read, values, chosenPriority: draft?.priority ?? null };
}
