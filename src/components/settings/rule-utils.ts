import { normalize } from "@/lib/domain/normalize";
import { LANGUAGE_LABEL, STATUS_META } from "@/lib/status";
import type { KeywordRule } from "@/lib/types";

export type RuleStatus = KeywordRule["status"];

/** The four statuses a keyword rule can point at, in pipeline order. */
export const RULE_STATUSES: RuleStatus[] = ["applied", "interview", "offer", "rejected"];

/** Same normalization as the keyword engine: case, accents and spacing don't matter. */
export const normalizePhrase = normalize;

/** "EN", "DE", … */
export const langCode = (lang: string) => lang.toUpperCase();

/** "German", or the code when the language has no label yet. */
export const langName = (lang: string) => LANGUAGE_LABEL[lang] ?? lang.toUpperCase();

/** Unique, order kept: first the given list, then anything new. */
export function uniqueLanguages(...lists: string[][]) {
  return [...new Set(lists.flat().filter(Boolean))];
}

/**
 * What happens when a phrase is listed under two statuses. Mirrors the engine:
 * "applied" loses to any later stage; two later stages disagree -> review.
 */
export function overlapHint(adding: RuleStatus, existing: RuleStatus) {
  const other = STATUS_META[existing].label;
  if (adding !== "applied" && existing !== "applied") {
    return `Also listed under ${other}. Emails with this phrase will go to review because the keywords disagree.`;
  }
  const winner = STATUS_META[adding === "applied" ? existing : adding].label;
  return `Also listed under ${other}. ${winner} wins when both match.`;
}
