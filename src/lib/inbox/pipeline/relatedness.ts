/*
 * Is the email about a job application at all? Real mail is full of single job-ish words
 * ("leider", "availability", "stelle" inside "stellen"), so one weak sign is not enough.
 *
 *   Strong (one is enough): the thread is linked to a job; mail from this address was linked
 *     to a job before (not a platform's shared address, match.ts); the sender's domain is a
 *     job's company, unless the mail is bulk mail; the sender is an applicant-tracking system;
 *     an "applied" keyword together with a hint word. An "applied" phrase that names the
 *     application has its hint in itself ("vielen Dank für Ihre Bewerbung"); one that does not
 *     ("Eingangsbestätigung", "bei uns eingegangen") is what every insurer and shop writes
 *     too, and alone counts as any other keyword.
 *   Weak (two different kinds are needed): any other keyword; a hint word (whole words only);
 *     a job's company named; the sender is a job board.
 *   Noise (noise.ts) overrides this: a job board's advertising and mail about a place at a
 *     university are related only in a thread that is linked to a job. A career portal's
 *     housekeeping stays related as counted here; classify.ts links it quietly or drops it.
 *   Bulk-mail headers (List-Unsubscribe, List-Id, Precedence bulk/list/junk) cancel one weak
 *     item.
 *   Bulk mail whose only strong evidence is the sender's domain or the sender's history (no
 *     linked thread, no applicant-tracking system, no "applied" phrase) is related exactly when
 *     a keyword hits, and then only for review ("bulk_mail", decide.ts): it never changes a job
 *     by itself. An employer's own newsletters and shop mail ("Leider ist dein Wunschartikel
 *     ausverkauft") come from its domain and carry its name, and a recruiter's newsletter comes
 *     from the address that wrote about the job; but an offer or an interview invitation can
 *     carry List-Unsubscribe or "Precedence: bulk" too, and must not be lost. Without a keyword
 *     such mail is ignored. A linked thread is about that job's conversation, so bulk mail in it
 *     is treated like any other mail.
 */
import type { KeywordHit } from "@/lib/types";
import { hasWords, platformOf, wordText } from "./extract";
import type { JobScore } from "./match";
import { noiseKind, type NoiseKind } from "./noise";
import type { BulkHeaders, Evidence, MailInput } from "./types";

/** Words that suggest job mail when they stand alone as words (weak evidence). */
export const JOB_HINTS = [
  "application",
  "applications",
  "applying",
  "candidate",
  "candidates",
  "position",
  "role",
  "recruiter",
  "recruiting",
  "recruitment",
  "bewerbung",
  "bewerbungen",
  "bewerbungsunterlagen",
  "stelle",
];

const NOISE_EVIDENCE: Record<NoiseKind, Evidence> = {
  portal: "portal_mail",
  advert: "job_advert",
  study: "study_application",
};

export function isBulk(bulk: BulkHeaders | undefined): boolean {
  if (!bulk) return false;
  const precedence = (bulk.precedence ?? "").trim().toLowerCase();
  return bulk.listUnsubscribe || !!bulk.listId?.trim() || ["bulk", "list", "junk"].includes(precedence);
}

export interface Relatedness {
  related: boolean;
  /** Strong items, then weak ones, then "bulk", then the kind of noise. */
  evidence: Evidence[];
  /** The kind of noise the mail is (noise.ts), or null. */
  noise: NoiseKind | null;
  /** Related only as bulk mail from the sender's domain or history: review, never a change. */
  bulkSender: boolean;
}

export function relatedness(
  mail: Pick<MailInput, "fromAddress" | "replyToAddress" | "subject" | "body" | "bulk">,
  hits: readonly KeywordHit[],
  scores: readonly JobScore[],
): Relatedness {
  const platforms = [platformOf(mail.fromAddress), platformOf(mail.replyToAddress ?? "")];
  const text = wordText(`${mail.subject}\n${mail.body}`);

  const bulk = isBulk(mail.bulk);
  const domain = scores.some((s) => s.domain);
  const history = scores.some((s) => s.senderHistory);

  const hint = JOB_HINTS.some((h) => hasWords(text, [h]));
  const applied = hits.some((h) => h.status === "applied");
  const thread = scores.some((s) => s.thread);

  const strong: Evidence[] = [];
  if (thread) strong.push("thread");
  if (history) strong.push("sender_history");
  if (domain && !bulk) strong.push("sender_domain");
  if (platforms.includes("ats")) strong.push("ats_sender");
  if (applied && hint) strong.push("applied_phrase");

  // The kinds that count towards two; in bulk mail the domain is listed first but not counted.
  const weak: Evidence[] = [];
  if (hits.some((h) => h.status !== "applied") || (applied && !hint)) weak.push("keyword");
  if (hint) weak.push("hint");
  if (scores.some((s) => s.companyNamed)) weak.push("company_named");
  if (platforms.includes("board")) weak.push("board_sender");

  const noise = noiseKind(mail);
  const listed: Evidence[] = [...strong, ...(domain && bulk ? (["sender_domain"] as const) : []), ...weak];
  const evidence: Evidence[] = [...listed, ...(bulk ? (["bulk"] as const) : []), ...(noise ? [NOISE_EVIDENCE[noise]] : [])];

  // Advertising and study applications: only a linked thread makes them a job's mail.
  if ((noise === "advert" || noise === "study") && !thread) return { related: false, evidence, bulkSender: false, noise };

  // Bulk mail that only the sender's domain or history ties to a job: see the top of this file.
  const bulkSender = bulk && (domain || history) && strong.every((e) => e === "sender_history");
  if (bulkSender) return { related: hits.length > 0, evidence, bulkSender: hits.length > 0, noise };

  const related = strong.length > 0 || weak.length - (bulk ? 1 : 0) >= 2;
  return { related, evidence, bulkSender: false, noise };
}
