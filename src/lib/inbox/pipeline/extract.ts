/*
 * What the pipeline reads out of an email besides keywords (those are in classify.ts): whole
 * words, the sender's domain, and the company and title guesses. The guesses prefill the review
 * form ("Create application"); a job created from a confirmation takes its company from the
 * sender's domain (companyFromDomain) or, through a recruiting platform, from the sender's name
 * when the text names it too (companyFromPlatformName), and its title from guessTitle.
 * src/components/review/guess.ts re-exports the guesses, so the client and the server share one
 * implementation. Pure and client-safe.
 */
import { normalize } from "@/lib/domain/normalize";

/* --------------------------------------------------------------------- words */

/** The words of a text after normalize(): runs of letters and digits. */
export function wordsOf(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * A text's words joined by single spaces, with a space at each end, for whole-word lookups
 * with hasWords(): " position " is not inside " composition ".
 */
export function wordText(text: string): string {
  const words = wordsOf(text);
  return words.length ? ` ${words.join(" ")} ` : " ";
}

/** True when the words of `phrase` stand in `haystack` (from wordText) as whole words, in a row. */
export function hasWords(haystack: string, phrase: string | readonly string[]): boolean {
  const words = typeof phrase === "string" ? wordsOf(phrase) : phrase;
  return words.length > 0 && haystack.includes(` ${words.join(" ")} `);
}

/* ------------------------------------------------------------------- domains */

/** Personal mail hosts: the domain says nothing about the employer. */
export const GENERIC_HOSTS: ReadonlySet<string> = new Set([
  "gmail",
  "googlemail",
  "outlook",
  "hotmail",
  "live",
  "msn",
  "yahoo",
  "ymail",
  "icloud",
  "me",
  "mac",
  "aol",
  "gmx",
  "web",
  "t-online",
  "freenet",
  "posteo",
  "mailbox",
  "proton",
  "protonmail",
  "pm",
  "fastmail",
  "zoho",
  "yandex",
  "mail",
  // RFC 2606's own name ("jobs@example.com"): invented, never an employer.
  "example",
]);

/**
 * Recruiting platforms, by registrable domain. Applicant-tracking systems ("ats") send mail about
 * an application on the employer's behalf, so a sender among them is strong evidence of job
 * mail. Job boards ("board") also send alerts and newsletters, so they are weak evidence.
 * Neither says which employer the mail is about.
 *
 * The whole registrable domain is compared, not the label: "join" alone would take join.me
 * (meetings) for JOIN (join.com), and "dice" dice.fm (tickets) for Dice (dice.com). A name
 * ending in ".*" is distinctive enough to match under any public suffix ("indeed.*": indeed.de,
 * indeed.co.uk). Invented fixture domains under the reserved ".example" suffix match a platform
 * by its name alone ("hire.lever.example"). Which platform sends from which domain is
 * experience, not documentation: extend as needed.
 */
export const RECRUITING_PLATFORMS: ReadonlyMap<string, "ats" | "board"> = new Map<string, "ats" | "board">([
  ...[
    "greenhouse.io",
    "greenhouse-mail.io",
    "lever.co",
    "workday.com",
    "myworkday.com",
    "myworkdayjobs.com",
    "myworkdaysite.com",
    "smartrecruiters.*",
    "smartrecruitersmail.com",
    "ashbyhq.com",
    "personio.*",
    "recruitee.com",
    "workable.com",
    "workablemail.com",
    "join.com",
    "teamtailor.*",
    "teamtailor-mail.com",
    "bamboohr.com",
    "jobvite.com",
    "icims.com",
    "successfactors.*",
    "sapsf.*",
    "taleo.net",
    "breezy.hr",
    "softgarden.*",
    "dvinci.*",
    "dvinci-easy.com",
    "rexx-systems.com",
    "concludis.*",
    "onlyfy.*",
    "comeet.com",
    "comeet.co",
    "pinpointhq.com",
    "homerun.co",
    "jazzhr.com",
    "applytojob.com",
    "recruiterbox.com",
    "factorialhr.*",
    "hibob.com",
  ].map((domain) => [domain, "ats"] as const),
  ...[
    "linkedin.*",
    "indeed.*",
    "indeedemail.com",
    "stepstone.*",
    "xing.*",
    "glassdoor.*",
    "monster.com",
    "monster.de",
    "monster.at",
    "monster.ch",
    "monster.co.uk",
    "monster.fr",
    "welcometothejungle.*",
    "wellfound.com",
    "otta.com",
    "jobteaser.*",
    "arbeitsagentur.de",
    "ziprecruiter.*",
    "dice.com",
    "totaljobs.com",
    "reed.co.uk",
  ].map((domain) => [domain, "board"] as const),
]);

/** Platforms by name alone, for invented fixture domains (".example"). */
const PLATFORM_NAMES: ReadonlyMap<string, "ats" | "board"> = new Map(
  [...RECRUITING_PLATFORMS].map(([domain, kind]) => [domain.slice(0, domain.indexOf(".")), kind] as const),
);

/** Public suffixes with a second level ("co.uk", "com.au"). */
const SECOND_LEVEL = new Set(["co", "com", "org", "ac", "gov", "net"]);

/** The domain of an address, lower case; "" when there is none. */
function hostOfAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at === -1) return "";
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/[>\s]+$/, "")
    .replace(/\.$/, "");
}

/**
 * The domain a host is registered under, as its label and public suffix:
 * "mail.meridian-consulting.example" -> meridian-consulting + example, "hire.lever.co" -> lever +
 * co, "emberfinance.co.uk" -> emberfinance + co.uk. RFC 2606's example.com/.net/.org count as a
 * public suffix, so an invented fixture domain such as "acme.example.com" reads like acme.com
 * and not like "example".
 */
function registrableDomain(host: string): { label: string; suffix: string } | null {
  const parts = host
    .toLowerCase()
    .replace(/\.example\.(com|net|org)$/, ".example")
    .split(".")
    .filter(Boolean);
  if (parts.length < 2) return null;
  const hasSecondLevel = parts.length >= 3 && SECOND_LEVEL.has(parts[parts.length - 2]);
  const at = parts.length - (hasSecondLevel ? 3 : 2);
  return { label: parts[at], suffix: parts.slice(at + 1).join(".") };
}

/** The label a domain is registered under (see registrableDomain): "hire.lever.co" -> "lever". */
export function registrableLabel(host: string): string | null {
  return registrableDomain(host)?.label ?? null;
}

/** The kind of recruiting platform a host belongs to, or null (see RECRUITING_PLATFORMS). */
function platformOfHost(host: string): "ats" | "board" | null {
  const domain = registrableDomain(host);
  if (!domain) return null;
  const { label, suffix } = domain;
  if (suffix === "example") return PLATFORM_NAMES.get(label) ?? null;
  return RECRUITING_PLATFORMS.get(`${label}.${suffix}`) ?? RECRUITING_PLATFORMS.get(`${label}.*`) ?? null;
}

/**
 * The employer part of an address's domain: "s.brandt@mail.meridian-consulting.example" ->
 * "meridian-consulting". Null for a personal mail host or a recruiting platform.
 */
export function domainCore(address: string): string | null {
  return employerLabel(hostOfAddress(address));
}

/** domainCore for a link's host, such as a job's posting URL. */
export function urlCore(url: string): string | null {
  try {
    return employerLabel(new URL(url).hostname);
  } catch {
    return null;
  }
}

function employerLabel(host: string): string | null {
  const label = registrableLabel(host);
  if (!label || GENERIC_HOSTS.has(label) || platformOfHost(host)) return null;
  return label;
}

/** The kind of recruiting platform an address belongs to, or null. */
export function platformOf(address: string): "ats" | "board" | null {
  return platformOfHost(hostOfAddress(address));
}

/** Legal forms left out when comparing company names with domains and text. */
const LEGAL_FORMS = new Set(["gmbh", "ag", "inc", "ltd", "llc", "co", "se", "bv", "kg", "ug", "plc", "corp"]);

/** A company's name as words, without legal forms: "Parcelwerk GmbH" -> ["parcelwerk"]. */
export function companyWords(company: string): string[] {
  return wordsOf(company).filter((w) => !LEGAL_FORMS.has(w));
}

/** German letters as domains spell them: "Müller" -> "Mueller". */
const TRANSLITERATE: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss" };

/**
 * A company name's words as domains spell them, in each spelling: with the German letters as
 * they are and transliterated, "&" left out and written as "and".
 */
function companySpellings(company: string): string[][] {
  const spellings = [company, company.replace(/[äöüÄÖÜß]/g, (c) => TRANSLITERATE[c])];
  return spellings.flatMap((spelling) => {
    const words = companyWords(spelling.replace(/&/g, " and "))
      .map((w) => w.replace(/[^a-z0-9]/g, ""))
      .filter(Boolean);
    return [words.filter((w) => w !== "and" && w !== "und"), words];
  });
}

/**
 * Words that name a company's region or group rather than the company, left out in one more
 * key: "Microsoft Deutschland GmbH" writes from microsoft.com, "Spotify Technology" from
 * spotify.com. A fixed list, compared as whole words: no key is a part of a word.
 */
const REGION_GROUP_WORDS = new Set([
  "deutschland",
  "germany",
  "group",
  "gruppe",
  "holding",
  "technology",
  "technologies",
  "international",
  "europe",
]);

/**
 * Keys that compare a company name with a domain label (see domainKeys): "Silt & Stone" ->
 * ["siltstone", "siltandstone"], "Bramble & Co" -> ["bramble", "brambleand"], "Brückenwerk AG"
 * -> ["bruckenwerk", "brueckenwerk"], and each also without region and group words: "Microsoft
 * Deutschland GmbH" -> ["microsoftdeutschland", "microsoft"]. A name of such words alone
 * ("Europe Group") has no key without them.
 */
export function companyKeys(company: string): string[] {
  const spellings = companySpellings(company);
  const keys = [...spellings, ...spellings.map((words) => words.filter((w) => !REGION_GROUP_WORDS.has(w)))];
  return [...new Set(keys.map((words) => words.join("")))].filter((k) => k.length >= 2);
}

/**
 * Every leading run of a company name's words, joined, in each spelling: "Fjordvik Energy
 * Group" -> ["fjordvik", "fjordvikenergy", "fjordvikenergygroup"]. Only a job's posting host is
 * compared with these (match.ts): a sender's domain that is just the first word ("spring" for
 * "Spring Health") says too little.
 */
export function companyPrefixes(company: string): string[] {
  const runs = new Set<string>();
  for (const words of companySpellings(company)) {
    let run = "";
    for (const word of words) {
      run += word;
      if (run.length >= 2) runs.add(run);
    }
  }
  return [...runs];
}

/** Words a career site's domain adds after the employer's name: "orbis-karriere", "acme-careers". */
const CAREER_PARTS = new Set(["karriere", "career", "careers", "jobs", "recruiting"]);

/** A domain label without the career words at its end, as long as something is left. */
function withoutCareerParts(label: string): string {
  const parts = label.split(/[-_]+/).filter(Boolean);
  while (parts.length > 1 && CAREER_PARTS.has(parts[parts.length - 1])) parts.pop();
  return parts.join("-");
}

/** A domain label's parts, without legal forms and career words: "bramble-co" -> ["bramble"]. */
function labelParts(label: string): string[] {
  return withoutCareerParts(label)
    .split(/[-_]+/)
    .filter((p) => p && !LEGAL_FORMS.has(p))
    .map((p) => p.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
}

/** A domain label as a comparison key: "bramble-co" -> "bramble", "halcyon-robotics" -> "halcyonrobotics". */
export function domainKey(label: string): string {
  return labelParts(label).join("");
}

/**
 * The keys a domain label stands for: the whole label and every leading run of its hyphenated
 * parts, "halcyon-robotics" -> ["halcyon", "halcyonrobotics"]. Keys are compared for equality,
 * never as substrings: "metabase" is not Meta, and "spring" is not Ring.
 */
export function domainKeys(label: string): string[] {
  const parts = labelParts(label);
  return parts.map((_, i) => parts.slice(0, i + 1).join(""));
}

/* ------------------------------------------------------------------- guesses */

/** The parts of an email the guesses read. */
export interface GuessSource {
  fromName: string;
  fromAddress: string;
  subject: string;
  body: string;
}

/** Longest company or title a job can hold (the jobs columns' limit, in characters). */
export const JOB_FIELD_MAX = 200;

/** Trimmed and cut to `max` characters (code points, as the column checks count them). */
export function fitField(s: string, max = JOB_FIELD_MAX): string {
  const chars = Array.from(s.trim());
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : chars.join("");
}

/** Words that describe a mailbox or team rather than the company. */
const ROLE_WORDS =
  /\b(careers?|recruiting|recruitment|talent(\s+acquisition)?|jobs|hiring|team|people|hr|karriere|bewerbungen?|no-?reply)\b/gi;

const squash = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");

const titleCase = (s: string) =>
  s
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

/** The first run of words in `words` that squashes to `target`, as the email spells it; "" when none. */
function spelledAs(words: readonly string[], target: string, capitalOnly: boolean): string {
  for (let i = 0; i < words.length; i++) {
    if (capitalOnly && !/^\p{Lu}/u.test(words[i])) continue;
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      const slice = words.slice(i, i + n);
      const joined = squash(slice.join(""));
      if (joined === target) return slice.join(" ").replace(/[.,'-]+$/, "");
      if (joined.length >= target.length) break;
    }
  }
  return "";
}

/** The words of a mail as the guesses compare them with a domain: letters, digits and & ' . - */
const guessWords = (email: GuessSource) =>
  `${email.fromName}\n${email.subject}\n${email.body}`.match(/[\p{L}\p{N}&'.-]+/gu) ?? [];

/**
 * The employer from the sender's own domain, spelled as the email spells it ("Meridian
 * Consulting", "lumora Group"), else the domain label in title case; "" for a personal mail
 * host or a recruiting platform. A career site's domain counts without its career word
 * ("jobs.orbis-karriere.example": ORBIS). A capitalised spelling is preferred to a lower-case one.
 * With companyFromPlatformName, the only companies the pipeline creates a job with: a sender's
 * name can be a person's ("Sarah Miller | Talent Acquisition") or a platform's ("Workday").
 */
export function companyFromDomain(email: GuessSource): string {
  const core = domainCore(email.fromAddress);
  if (!core) return "";
  const plain = withoutCareerParts(core);
  const targets = [...new Set([squash(core), squash(plain)])];
  const words = guessWords(email);
  for (const capitalOnly of [true, false]) {
    for (const target of targets) {
      const found = spelledAs(words, target, capitalOnly);
      if (found) return found;
    }
  }
  return titleCase(plain);
}

/**
 * Best guess of the employer, to prefill the review form: companyFromDomain, else
 * companyFromPlatformName, else the sender's name without mailbox words ("Driftwood Audio
 * Careers" -> "Driftwood Audio"). "" when there is nothing better than a person's name or a
 * platform's ("Workday").
 */
export function guessCompany(email: GuessSource): string {
  return companyFromDomain(email) || companyFromPlatformName(email) || companyFromName(email.fromName);
}

/** The sender's name without mailbox words; "" when it has none (see guessCompany). */
function companyFromName(fromName: string): string {
  const stripped = fromName.replace(ROLE_WORDS, " ").replace(/\s{2,}/g, " ").trim();
  // "Driftwood Audio Careers" -> "Driftwood Audio". A bare person's name is not a company.
  return stripped && stripped !== fromName.trim() ? stripped : "";
}

/**
 * Separators and words that can set a person apart from a role or a company in a sender's name
 * ("Sarah Miller | Talent Acquisition", "Sam Ortiz, Recruiting", "Sarah from Acme Recruiting").
 */
const NAME_SEPARATOR = /[|/\\·•,:;@()[\]–—]|\s-\s|\b(?:at|from|via|bei|von)\b/i;

/**
 * The employer from the sender's name, for mail sent through a recruiting platform (whose
 * domain names none). The platform's own name goes first ("Halden Group Workday", "Varda
 * IT-Services GmbH über Indeed"), then the mailbox words ("Fennel & Finch Hiring Team" ->
 * "Fennel & Finch"). What is left is the employer when
 *   - a platform or mailbox word was removed and the subject or body names it too, or
 *   - nothing was removed (a bare name may be a person's, which a signature repeats) but it
 *     carries a legal form ("Ostwind GmbH") and the text names it, or the subject names it
 *     ("Bewerbung | Application (quantwerk)").
 * A name written like a mailbox ("yourjob@feldmann") names the employer after the "@", when the
 * text names it; it is spelled as the text spells it. Names are compared as whole words after
 * normalize(). "" for any other sender, and when the name is split by a separator or
 * "at"/"from" (the rest may be a person's name), is the platform's own ("Workday Careers"), or
 * is not named in the text.
 */
export function companyFromPlatformName(email: GuessSource): string {
  if (!platformOf(email.fromAddress)) return "";
  const subject = wordText(email.subject);
  const text = wordText(`${email.subject}\n${email.body}`);
  const platform = registrableLabel(hostOfAddress(email.fromAddress)) ?? "";
  const isPlatform = (word: string) => {
    const key = squash(word);
    return key.length >= 4 && PLATFORM_NAMES.has(key) && platform.includes(key);
  };

  const mailbox = email.fromName.trim().match(/^[\w.+-]+@([\p{L}\p{N}-]+)$/u)?.[1];
  if (mailbox) {
    const key = squash(mailbox);
    if (key.length < 3 || PLATFORM_NAMES.has(key) || !hasWords(text, [key])) return "";
    return spelledAs(`${email.subject}\n${email.body}`.match(/[\p{L}\p{N}&'-]+/gu) ?? [], key, true) || titleCase(mailbox);
  }

  // "… über Indeed", "… via Personio", and the platform's name as a word of its own.
  const tokens = email.fromName.trim().split(/\s+/).filter(Boolean);
  const kept = tokens.filter((t, i) => {
    if (isPlatform(t)) return false;
    return !(/^(?:über|ueber|via|by|on|auf)$/i.test(t) && i + 1 < tokens.length && isPlatform(tokens[i + 1]));
  });
  const withoutPlatform = kept.join(" ");
  if (!withoutPlatform || NAME_SEPARATOR.test(withoutPlatform)) return "";
  const name = companyFromName(withoutPlatform) || withoutPlatform;
  const removed = name !== email.fromName.trim();
  const words = companyWords(name);
  const key = words.join("");
  if (key.length < 3 || PLATFORM_NAMES.has(key)) return "";
  if (removed) return hasWords(text, words) ? name : "";
  const legalForm = wordsOf(name).some((w) => LEGAL_FORMS.has(w));
  return hasWords(subject, words) || (legalForm && hasWords(text, words)) ? name : "";
}

/* -------------------------------------------------------------------- titles */

/** A run of capitalised words on one line: a subject's last word is not continued by the body's "Hi Robin, I". */
const CAP_RUN = String.raw`((?:\p{Lu}[\p{L}\p{N}/&()+.:-]*(?:,?[^\S\n]+|(?=\n)|$))+)`;

/**
 * The gender marker German postings put after the role: "(m/w/d)", "(w/m/d)", "(m/f/x)",
 * "(all genders)", "(gn)", also in brackets or bare ("m/w/d").
 */
const GENDER = String.raw`(?:[(\[]\s*(?:[mwfdx](?:\s*[/|,*]\s*[mwfdxi]){1,3}|all\s+genders|gn\*?|divers)\s*[)\]]|\b[mwf]\s*\/\s*[mwf]\s*\/\s*[dx]\b)`;

/** What stands right before a role: "Bewerbung als", "auf die Stelle", "Stelle:", "applying to the". */
const LEAD_IN = String.raw`(?:\bals\s+|\b(?:Stelle|Position|Stellenausschreibung|Ausschreibung|Stellenanzeige|Vakanz|Rolle)\s*(?::\s*|\s+als\s+|\s+)|\bBewerbung(?:\s+über\s+\p{L}+)?\s*:\s+|\b(?:applying|applied|application)\s+(?:to|for)\s+(?:the|our)\s+|\b(?:position|role)\s+(?:of|as)\s+(?:an?\s+)?)`;

/** A role as written before its gender marker: starts like a noun, stays within its sentence. */
const MARKED_ROLE = String.raw`([\p{Lu}\p{N}(](?:[^\n.!?]|\.(?!\s|$)){1,88}?)\s*${GENDER}`;

const LEAD_ROLE = new RegExp(LEAD_IN + MARKED_ROLE, "iu");
/** A gender marker anywhere ("(m/w/d)", "(all genders)"): a job posting's mark (also noise.ts). */
export const GENDER_RE = new RegExp(GENDER, "iu");

/**
 * Words that make a phrase a sentence or a status line rather than a role: "Wir haben Ihre
 * Bewerbung erhalten", "Eingangsbestätigung deiner Bewerbung", "Einladung zum Teamsmeeting",
 * "Thank you". Compared after normalize(); the second list by the word's beginning.
 */
const NOT_TITLE_WORDS = new Set(
  "wir sie ihnen ihre ihr ihrer ihren ihrem du dich dir dein deine deiner deinen deinem uns unser unsere haben hat ist sind wurde wird konnen mochten dass nicht you your we our us thank thanks danke dank vielen herzlichen has have is are was next steps hi hello hallo dear liebe lieber sehr geehrte geehrter guten".split(
    " ",
  ),
);
const NOT_TITLE_STEMS =
  /^(?:bewerb|eingangsbest|bestatigung|einladung|ruckmeldung|neuigkeiten|erinnerung|absage|zusage|termin|unterlagen|willkommen|erhalten|eingegangen|vorstellungsgesprach|application|confirmation|invitation|update|reminder|feedback|status|interview|welcome|received)/;

/** A guess that can be a role: no sentence, no status line (see NOT_TITLE_WORDS). */
export function roleLike(candidate: string): boolean {
  const words = wordsOf(candidate);
  return words.length > 0 && !words.some((w) => NOT_TITLE_WORDS.has(w) || NOT_TITLE_STEMS.test(w));
}

function clean(s: string | undefined, max = 70) {
  const t = (s ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;|/–—-]+/, "")
    .replace(/[\s,.:;|/–—-]+$/, "")
    .trim();
  return t.length >= 3 && t.length <= max ? t : "";
}

/** The role in front of a gender marker, after a lead-in: "Bewerbung als X (m/w/d)". */
function markedRole(text: string): string {
  const hit = clean(text.match(LEAD_ROLE)?.[1], 90);
  return hit && roleLike(hit) ? hit : "";
}

/** A subject that is the role itself, or ends with it: "Data Engineer (m/w/d) – Standort Köln". */
function markedSubject(subject: string): string {
  const at = subject.search(GENDER_RE);
  if (at <= 0) return "";
  const before = subject.slice(0, at);
  const cuts = [0, before.lastIndexOf(": ") + 2, Math.max(before.lastIndexOf(" – "), before.lastIndexOf(" | ")) + 3];
  for (const cut of cuts) {
    if (cut !== 0 && cut <= 2) continue;
    const hit = clean(before.slice(cut), 90);
    if (hit && /^[\p{Lu}\p{N}(]/u.test(hit) && roleLike(hit)) return hit;
  }
  return "";
}

export interface TitleGuess {
  title: string;
  /**
   * The role stood where roles stand ("Bewerbung als …", "the … position", in front of a
   * gender marker), not merely at the end of the subject. Only such a guess creates a job from
   * mail that is not a confirmation, or a second job at a company (decide.ts).
   */
  anchored: boolean;
}

/**
 * Best guess of the role, and how it was found. In this order: in front of a gender marker
 * after a lead-in, in the subject, then the body ("Deine Bewerbung als IT-Operations Engineer
 * (m/w/d) (40021)", "für die Stelle Fullstack Developer (m/w/d) KI-Fokus": the marker and what
 * follows it are left out); a subject that carries a marker without a lead-in; the end of the
 * subject after a dash or colon, when it reads like a role ("Thank you for applying – Frontend
 * Engineer", not "Ihre Bewerbung - Eingangsbestätigung"); then the patterns without a marker.
 */
export function guessTitleDetail(email: Pick<GuessSource, "subject" | "body">): TitleGuess {
  const subject = email.subject.replace(/^((re|fwd?|aw|wg)\s*:\s*)+/i, "").trim();
  const anchored = (title: string): TitleGuess => ({ title, anchored: true });

  const marked = markedRole(subject) || markedRole(email.body);
  if (marked) return anchored(marked);
  const bare = markedSubject(subject);
  if (bare) return { title: bare, anchored: false };

  // "Thank you for applying – Frontend Engineer", "Interview invitation: Software Engineer"
  const tail = subject.split(/\s[–—-]\s|:\s/).slice(1).join(" ").trim();
  if (tail && /^\p{Lu}/u.test(tail) && tail.split(/\s+/).length <= 6 && roleLike(tail)) {
    return { title: clean(tail), anchored: false };
  }

  // "Update on your Frontend Developer application"; one word is the company ("Your Pallas application").
  const your = subject.match(/\byour\s+(.+?)\s+application\b/i)?.[1];
  if (your && /^\p{Lu}/u.test(your) && /\s/.test(your.trim()) && clean(your)) return anchored(clean(your));

  const text = `${subject}\n${email.body}`;
  const patterns = [
    // "for the Frontend Engineer role"
    /\bthe\s+(\p{Lu}[\p{L}\p{N}/&(), -]+?)\s+(?:role|position)\b/u,
    // "für die Position Frontend Consultant kennenlernen", "position as Data Engineer"
    new RegExp(String.raw`\b(?:[Pp]osition|[Ss]telle|[Rr]ole)(?:[^\S\n]+(?:als|as|of))?[^\S\n]+${CAP_RUN}`, "u"),
    // "Ihre Bewerbung als Werkstudent Softwareentwicklung", "Sie haben sich als Data Analyst
    // beworben". Not any "als": German capitalises nouns, so "Ihr Interesse an uns als
    // Arbeitgeber" or "Ihre Zeugnisse als PDF" would name the role "Arbeitgeber" or "PDF".
    new RegExp(String.raw`\b(?:[Bb]ewerbung|sich)[^\S\n]+als[^\S\n]+${CAP_RUN}`, "u"),
  ];
  for (const re of patterns) {
    // A run of capitalised words runs into the next sentence ("… Developer. Über dein Interesse").
    const hit = clean(text.match(re)?.[1]?.split(/[.!?]\s/)[0]);
    if (hit && roleLike(hit)) return anchored(hit);
  }
  return { title: "", anchored: false };
}

/** Best guess of the role from the subject, then the body; "" when none is found. */
export function guessTitle(email: Pick<GuessSource, "subject" | "body">): string {
  return guessTitleDetail(email).title;
}
