/*
 * Mail that looks like job mail to the other rules but is not news about an application. Three
 * kinds, each a fixed list of phrases (experience from real mailboxes, like the platform list in
 * extract.ts: extend as needed), compared after normalize():
 *
 *   portal  A career portal's housekeeping: a verification code, "account created", a password
 *           link, "we created a profile for you". It comes from the employer's domain or its
 *           applicant-tracking system and names the application, so it would wait in review
 *           ("no keyword") or be read as news ("Termine zu Vorstellungsgesprächen vereinbaren"
 *           in a welcome mail). Read from the subject only: a real confirmation often ends with
 *           "Passwort vergessen?" or a link to the portal.
 *   advert  A job board advertising: recommended jobs, "Jetzt bewerben", an upsell after an
 *           application. Only mail from a job board: an employer's rejection may end with a link
 *           to its open positions.
 *   study   An application for a place at a university ("Bewerbung für einen Studienplatz"):
 *           the same words as a job application, and confirmations of its own. Not when the
 *           mail carries a job posting's marks (a gender marker, "Werkstudent", "Praktikum", a
 *           thesis): a student job's posting asks for a "Studiengang" too, and quoted in a
 *           confirmation it must not drop the mail.
 *
 * What each kind does is in classify.ts and relatedness.ts.
 */
import { normalize } from "@/lib/domain/normalize";
import { GENDER_RE, platformOf } from "./extract";
import type { MailInput } from "./types";

export type NoiseKind = "portal" | "advert" | "study";

/** Subjects of portal housekeeping. */
const PORTAL_SUBJECT: readonly RegExp[] = [
  /verifizierungscode|bestatigungscode|sicherheitscode|einmalcode|einmalpasswort|einmalkennwort/,
  /verification code|security code|one-time (?:password|passcode|code)|\botp\b/,
  /passwor[td]|kennwort/,
  /\b(?:account|konto|profil|benutzerkonto|kandidatenprofil) (?:wurde )?(?:erstellt|angelegt|eingerichtet|aktiviert)\b/,
  /\bein (?:profil|konto|account)\b.*\b(?:angelegt|erstellt|eingerichtet)\b/,
  /\b(?:account|profile) (?:has been |was )?(?:created|activated)\b/,
  /\b(?:activate|verify|confirm) your (?:account|e-?mail|email address)\b/,
  /\b(?:konto|account|e-?mail-adresse|registrierung) (?:aktivieren|bestatigen|verifizieren)\b/,
  /\bwillkommen (?:in|im|bei) (?:unserem|deinem|ihrem|dem)? ?(?:karriereportal|bewerberportal|bewerbungsportal|talent ?pool)\b/,
  /\bwelcome to (?:our|the|your) (?:career|careers|candidate|talent) (?:portal|site|community|home)\b/,
];

/** Phrases of a job board's advertising, in the subject or the body. */
const ADVERT_TEXT: readonly RegExp[] = [
  /konnte diese stelle|passende (?:jobs|stellen|stellenangebote)|jobs,? die zu (?:ihnen|dir) passen/,
  /\b(?:neue|empfohlene|ahnliche) (?:jobs|stellen|stellenangebote)\b|jobempfehlung|job ?alert/,
  /\bjetzt bewerben\b|\bjob anzeigen\b|schnellbewerbung/,
  /\bheben sie sich\b|\bhebe dich\b/,
  /\b(?:new|recommended|similar) jobs\b|\bjobs (?:for you|you may like|you might like)\b|\bapply now\b|\bview job\b/,
];

/** Words of an application for a place at a university. */
const STUDY_TEXT = /studienplatz|studiengang|masterstudium|bachelorstudium|zulassungsverfahren/;

/** Words of a student job, which an admission mail does not use (see "study" above). */
const STUDENT_JOB_TEXT = /werkstudent|working student|praktikum|praktikant|abschlussarbeit|masterarbeit|bachelorarbeit|thesis/;

/** The kind of noise an email is, or null: see the top of this file. */
export function noiseKind(mail: Pick<MailInput, "fromAddress" | "replyToAddress" | "subject" | "body">): NoiseKind | null {
  const subject = normalize(mail.subject);
  if (PORTAL_SUBJECT.some((re) => re.test(subject))) return "portal";
  const text = normalize(`${mail.subject}\n${mail.body}`);
  const board = platformOf(mail.fromAddress) === "board" || platformOf(mail.replyToAddress ?? "") === "board";
  if (board && ADVERT_TEXT.some((re) => re.test(text))) return "advert";
  if (STUDY_TEXT.test(text) && !STUDENT_JOB_TEXT.test(text) && !GENDER_RE.test(`${mail.subject}\n${mail.body}`)) return "study";
  return null;
}
