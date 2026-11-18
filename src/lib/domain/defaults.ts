import type { KeywordRule } from "@/lib/types";

/**
 * Keyword rules every new user starts with. A phrase hits when it occurs in the subject or body
 * as a substring after normalize(), so a German compound or ending still hits
 * ("vorstellungsgespräch" in "Videovorstellungsgesprächen", "andere bewerber" in "andere
 * Bewerberinnen"), and so does any text that merely contains it. Hence the choices below:
 *
 *   - German mail says "du" as often as "Sie": a phrase with a pronoun is listed in both forms
 *     ("dank für ihre bewerbung", "dank für deine bewerbung"; both cover "vielen Dank" and
 *     "herzlichen Dank"), or avoids it ("bewerbung erhalten").
 *   - No bare adverbs or verbs that normal mail is full of. "leider" alone moved a job to
 *     Rejected on "leider ist der Termin nicht mehr verfügbar", and "absage" hit the button
 *     "Absagen oder verschieben" of an interview reminder; "kennenlernen" is what a rejection
 *     regrets ("können nicht jeden persönlich kennenlernen"). They are listed with the words
 *     that make them news: "leider mitteilen", "eine absage", "gerne persönlich kennenlernen".
 *   - Rejections are recognised by what they say about the application ("nicht
 *     berücksichtigen", "andere Kandidaten", "nicht in die engere Wahl") and by their closing
 *     ("für Ihren weiteren beruflichen Werdegang").
 *
 * The German phrases come from real mail (2026-11-17, docs/plan/2-gmail-ingest.md, "After the
 * first real scan"). RETIRED_DEFAULT_RULES lists what earlier versions started users with.
 */
export const DEFAULT_RULES: Array<Omit<KeywordRule, "id">> = [
  { status: "applied", phrase: "thank you for applying", language: "en" },
  { status: "applied", phrase: "thanks for applying", language: "en" },
  { status: "applied", phrase: "thank you for your application", language: "en" },
  { status: "applied", phrase: "we received your application", language: "en" },
  { status: "applied", phrase: "we have received your application", language: "en" },
  { status: "applied", phrase: "your application has been received", language: "en" },
  { status: "applied", phrase: "dank für ihre bewerbung", language: "de" },
  { status: "applied", phrase: "dank für deine bewerbung", language: "de" },
  { status: "applied", phrase: "danke für ihre bewerbung", language: "de" },
  { status: "applied", phrase: "danke für deine bewerbung", language: "de" },
  { status: "applied", phrase: "bewerbung erhalten", language: "de" },
  { status: "applied", phrase: "wir haben ihre bewerbung", language: "de" },
  { status: "applied", phrase: "wir haben deine bewerbung", language: "de" },
  { status: "applied", phrase: "bewerbung ist eingegangen", language: "de" },
  { status: "applied", phrase: "bei uns eingegangen", language: "de" },
  { status: "applied", phrase: "eingang ihrer bewerbung", language: "de" },
  { status: "applied", phrase: "eingang deiner bewerbung", language: "de" },
  { status: "applied", phrase: "bewerbung wurde weitergeleitet", language: "de" },
  { status: "applied", phrase: "bei uns beworben", language: "de" },
  { status: "applied", phrase: "eingangsbestätigung", language: "de" },
  { status: "interview", phrase: "interview", language: "en" },
  { status: "interview", phrase: "schedule a call", language: "en" },
  { status: "interview", phrase: "availability", language: "en" },
  { status: "interview", phrase: "vorstellungsgespräch", language: "de" },
  { status: "interview", phrase: "bewerbungsgespräch", language: "de" },
  { status: "interview", phrase: "kennenlerngespräch", language: "de" },
  { status: "interview", phrase: "erstgespräch", language: "de" },
  { status: "interview", phrase: "gerne persönlich kennenlernen", language: "de" },
  { status: "interview", phrase: "gerne kennenlernen", language: "de" },
  { status: "interview", phrase: "näher kennenlernen", language: "de" },
  { status: "interview", phrase: "einladung zum", language: "de" },
  { status: "interview", phrase: "einladung zu einem", language: "de" },
  { status: "interview", phrase: "terminvorschlag", language: "de" },
  { status: "offer", phrase: "pleased to offer", language: "en" },
  { status: "offer", phrase: "offer letter", language: "en" },
  { status: "offer", phrase: "arbeitsvertrag", language: "de" },
  { status: "offer", phrase: "vertragsangebot", language: "de" },
  { status: "offer", phrase: "vertragsunterlagen", language: "de" },
  { status: "offer", phrase: "einstellungszusage", language: "de" },
  { status: "rejected", phrase: "unfortunately", language: "en" },
  { status: "rejected", phrase: "other candidates", language: "en" },
  { status: "rejected", phrase: "not moving forward", language: "en" },
  { status: "rejected", phrase: "decided to pursue", language: "en" },
  { status: "rejected", phrase: "not selected", language: "en" },
  { status: "rejected", phrase: "regret to inform", language: "en" },
  { status: "rejected", phrase: "position has been filled", language: "en" },
  { status: "rejected", phrase: "nicht weiter berücksichtigen", language: "de" },
  { status: "rejected", phrase: "nicht berücksichtigen", language: "de" },
  { status: "rejected", phrase: "nicht berücksichtigt", language: "de" },
  { status: "rejected", phrase: "anderen kandidaten", language: "de" },
  { status: "rejected", phrase: "andere kandidaten", language: "de" },
  { status: "rejected", phrase: "andere kandidat:innen", language: "de" },
  { status: "rejected", phrase: "andere kandidatinnen", language: "de" },
  { status: "rejected", phrase: "andere bewerber", language: "de" },
  { status: "rejected", phrase: "anderen bewerber", language: "de" },
  { status: "rejected", phrase: "nicht in die engere wahl", language: "de" },
  { status: "rejected", phrase: "eine absage", language: "de" },
  { status: "rejected", phrase: "unsere absage", language: "de" },
  { status: "rejected", phrase: "diese absage", language: "de" },
  { status: "rejected", phrase: "als absage", language: "de" },
  { status: "rejected", phrase: "leider mitteilen", language: "de" },
  { status: "rejected", phrase: "keine passende position", language: "de" },
  { status: "rejected", phrase: "keine passende stelle", language: "de" },
  { status: "rejected", phrase: "nicht anbieten können", language: "de" },
  { status: "rejected", phrase: "nicht fortzuführen", language: "de" },
  { status: "rejected", phrase: "nicht weiterverfolgen", language: "de" },
  { status: "rejected", phrase: "bereits besetzt", language: "de" },
  { status: "rejected", phrase: "anderweitig besetzt", language: "de" },
  { status: "rejected", phrase: "weiteren beruflichen", language: "de" },
  { status: "rejected", phrase: "weiteren berufsweg", language: "de" },
];

/**
 * Default rules of earlier versions that are no longer defaults: too broad, or covered by a
 * shorter phrase (see the choices above). "Update defaults" in Settings removes them from a
 * user's rules and adds the DEFAULT_RULES that are missing; rules the user added stay. A phrase
 * retired here must not be in DEFAULT_RULES for the same status.
 */
export const RETIRED_DEFAULT_RULES: ReadonlyArray<Pick<KeywordRule, "status" | "phrase">> = [
  { status: "applied", phrase: "vielen dank für ihre bewerbung" },
  { status: "applied", phrase: "ihre bewerbung ist bei uns eingegangen" },
  { status: "interview", phrase: "kennenlernen" },
  { status: "rejected", phrase: "leider" },
  { status: "rejected", phrase: "absage" },
];

export interface UserSettingsDefaults {
  noResponseDays: number;
  createFromConfirmation: boolean;
  reviewUncertain: boolean;
  languages: readonly string[];
  inboxIntervalMinutes: number;
}

/** Settings a new user starts with (inserted at first sign-in). Copy `languages` before mutating. */
export const DEFAULT_USER_SETTINGS: Readonly<UserSettingsDefaults> = {
  noResponseDays: 30,
  createFromConfirmation: true,
  reviewUncertain: true,
  languages: ["en", "de"],
  inboxIntervalMinutes: 15,
};
