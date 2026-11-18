import "server-only";
import { clampText } from "./headers";

/**
 * A mail body as it is classified and stored (docs/plan/2-gmail-ingest.md, "Reading a message"
 * and "What is stored"): preheader padding and quoted replies removed, line endings normalised,
 * whitespace and blank lines collapsed, then cut at MAX_BODY characters.
 *
 * Quoted replies are cut at the first reply header ("On … wrote:", "Am … schrieb …:", the
 * French, Spanish and Dutch forms, Outlook's "-----Original Message-----" and its "From: … Sent:"
 * or "Von: … Gesendet:" block, Outlook for Mac's "From: … Date:" or "Von: … Datum:" block) that
 * has the sender's own text above it; lines starting with ">" are removed wherever they are. A header wrapped over several lines must name an address ("@"
 * or "<"), so that two sentences in a row ("Am 14. März … einladen." / "… schrieb uns dazu:")
 * are not taken for one. Forwarded messages are content, not quotes, and stay: Gmail's
 * "---------- Forwarded message ---------" (and Apple Mail's and Thunderbird's forms, in the
 * languages above: a "From: … Date:" block below such a line is the forwarded message's
 * header), and Outlook's separators and header blocks in a mail whose subject marks a forward
 * (isForwardSubject: "FW:", "Fwd:", "WG:", "TR:", "RV:", "Doorst:"). When stripping would leave
 * nothing, the text is kept.
 */

/** The stored body is cut to this many characters (UTF-16 units). */
export const MAX_BODY = 20_000;

// Invisible characters mail templates pad preheaders with, and soft hyphens (which would split
// "Bewer­bung" for the keyword matcher). U+200D (zero-width joiner) is handled apart: it
// holds emoji sequences together.
const INVISIBLE =
  /[­͏؜ᅟᅠ឴឵᠎​‌‎‏‪-‮⁠-⁤⁪-⁯ㅤ﻿ﾠ]/g;
// A joiner after a pictograph (with its variation selector or skin tone) and before one stays.
const LONE_ZWJ = /(?<!\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)\u{200D}|\u{200D}(?!\p{Extended_Pictographic})/gu;
// Space-like characters, including the braille blank some templates pad with.
const SPACES = /[   -   ⠀　]/g;
// The same padding as literal entities, which plain-text parts made from HTML templates carry.
const ENTITY_PADDING = /&(?:zwnj|shy|#8204|#x200c|#847|#x34f|#173|#xad);/gi;
const ENTITY_SPACE = /&(?:nbsp|#160|#xa0);/gi;
// C0 and C1 controls except tab and line feed. NUL above all: PostgreSQL text cannot hold it.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Removes preheader padding and control characters; space-like characters become spaces. */
export function stripPadding(text: string): string {
  return text
    .replace(ENTITY_PADDING, "")
    .replace(ENTITY_SPACE, " ")
    .replace(INVISIBLE, "")
    .replace(LONE_ZWJ, "")
    .replace(SPACES, " ")
    .replace(CONTROLS, "");
}

/**
 * Undoes format=flowed (RFC 3676): a line ending in a space continues on the next line, a
 * leading space is stuffing. With delsp=yes the space at a soft break is not part of the text.
 * Quoted lines are left alone (they are removed later). Expects "\n" line endings.
 */
export function unflowText(text: string, delsp: boolean): string {
  const out: string[] = [];
  let buffer: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith(">")) {
      if (buffer !== null) out.push(buffer);
      buffer = null;
      out.push(line);
      continue;
    }
    let l = line.startsWith(" ") ? line.slice(1) : line;
    const soft = l.endsWith(" ") && l !== "-- ";
    if (soft && delsp) l = l.slice(0, -1);
    buffer = (buffer ?? "") + l;
    if (!soft) {
      out.push(buffer);
      buffer = null;
    }
  }
  if (buffer !== null) out.push(buffer);
  return out.join("\n");
}

/* ---------------------------------------------------------------- quoted replies */

const SEPARATOR =
  /^-{2,}\s*(original message|ursprüngliche nachricht|originalnachricht|message d'origine|mensaje original|oorspronkelijk bericht)\s*-{2,}$/i;
// "On <date>, <person> wrote:" and its translations. A reply header always holds a date or time.
const ATTRIBUTION = [
  /^on\s.{1,300}\swrote:$/i,
  /^am\s.{1,300}\sschrieb\b.{0,300}:$/i,
  /^le\s.{1,300}\sa écrit\s?:$/i,
  /^el\s.{1,300}\sescribió:$/i,
  /^op\s.{1,300}\sschreef\b.{0,300}:$/i,
];
const ATTRIBUTION_START = /^(on|am|le|el|op)\s/i;
// Outlook's header block: "From: …" then, within a few lines, "Sent: …" (bold in HTML: "*From:*").
const OUTLOOK_FROM = /^\*?(from|von|de|van)\*?\s*:\s*\S/i;
const OUTLOOK_SENT = /^\*?(sent|gesendet|envoyé|enviado(?: el)?|verzonden)\*?\s*:/i;
const OUTLOOK_ONE_LINE = /^\*?(from|von)\*?\s*:.*\s\*?(sent|gesendet)\*?\s*:/i;
// Outlook for Mac's block: "From: …" then "Date: …" ("Datum", "Fecha") on one of the next two
// lines, with a date in it (a digit), so that "From: the team" / "Date: soon" is not one.
const OUTLOOK_DATE = /^\*?(date|datum|fecha)\*?\s*:.*\d/i;
// The line above a forwarded message's own "From: … Date:" header: Gmail's, Thunderbird's
// ("---------- Forwarded message ---------") and Apple Mail's ("Begin forwarded message:").
const FORWARDED =
  /^(-{2,}\s*(forwarded message|weitergeleitete nachricht|message transféré|mensaje reenviado|doorgestuurd bericht)\s*-{2,}|(begin forwarded message|anfang der weitergeleiteten nachricht|début du message réexpédié|inicio del mensaje reenviado|begin doorgestuurd bericht)\s*:)$/i;
const RULE = /^[_-]{5,}$/;

function isQuoteLine(line: string) {
  return line.trimStart().startsWith(">");
}

function isAttribution(lines: string[], i: number): boolean {
  const first = lines[i].trim();
  if (!ATTRIBUTION_START.test(first) || first.length > 500) return false;
  // Mail clients wrap a long header line: try it with up to two following lines.
  let joined = first;
  for (let k = 0; k < 3 && i + k < lines.length; k++) {
    if (k > 0) {
      const next = lines[i + k].trim();
      if (!next || isQuoteLine(next)) break;
      joined += ` ${next}`;
    }
    // A wrapped header names an address; sentences that happen to start and end right do not.
    if (k > 0 && !/[@<]/.test(joined)) continue;
    if (joined.length <= 600 && /\d/.test(joined) && ATTRIBUTION.some((re) => re.test(joined))) return true;
  }
  return false;
}

function isOutlookBlock(lines: string[], i: number): boolean {
  const line = lines[i].trim();
  if (OUTLOOK_ONE_LINE.test(line)) return true;
  if (!OUTLOOK_FROM.test(line)) return false;
  for (let k = 1; k <= 4 && i + k < lines.length; k++) {
    if (OUTLOOK_SENT.test(lines[i + k].trim())) return true;
  }
  return false;
}

function isMacBlock(lines: string[], i: number): boolean {
  if (!OUTLOOK_FROM.test(lines[i].trim())) return false;
  for (let k = 1; k <= 2 && i + k < lines.length; k++) {
    if (OUTLOOK_DATE.test(lines[i + k].trim())) return true;
  }
  return false;
}

// The forward prefixes of the languages above: en "FW:"/"Fwd:", de "WG:", fr "TR:", es "RV:",
// nl "Doorst:". Only the first prefix counts: "RE: FW: …" is a reply.
const FORWARD_SUBJECT = /^\s*(fwd?|wg|tr|rv|doorst)\s*:/i;

/** The subject marks a forwarded message. */
export function isForwardSubject(subject: string): boolean {
  return FORWARD_SUBJECT.test(subject);
}

export interface QuoteOptions {
  /** The mail is a forward (isForwardSubject): Outlook's separators and header blocks stay. */
  forwarded?: boolean;
}

/** Index of the first line of the first reply header with own text above it, or -1. */
function quoteStart(lines: string[], opts: QuoteOptions): number {
  let contentAbove = false;
  let forwardAbove = false;
  const outlook = (i: number) =>
    !opts.forwarded &&
    (SEPARATOR.test(lines[i].trim()) || isOutlookBlock(lines, i) || (!forwardAbove && isMacBlock(lines, i)));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (FORWARDED.test(line)) forwardAbove = true;
    if (contentAbove && (isAttribution(lines, i) || outlook(i))) {
      // Take an Outlook rule ("_____") right above along.
      let start = i;
      while (start > 0 && (!lines[start - 1].trim() || RULE.test(lines[start - 1].trim()))) start--;
      return start;
    }
    if (line && !isQuoteLine(line) && !RULE.test(line)) contentAbove = true;
  }
  return -1;
}

/** Removes quoted replies (see the top of this file). Expects "\n" line endings. */
export function stripQuoted(text: string, opts: QuoteOptions = {}): string {
  const lines = text.split("\n");
  const start = quoteStart(lines, opts);
  const own = start >= 0 ? lines.slice(0, start) : lines;
  const unquoted = own.filter((l) => !isQuoteLine(l));
  if (unquoted.some((l) => l.trim())) return unquoted.join("\n");
  return own.join("\n");
}

/* ---------------------------------------------------------------- the whole body */

/** Normalised text without padding and quotes, cut to `max` (see the top of this file). */
export function cleanBody(text: string, max = MAX_BODY, opts: QuoteOptions = {}): { body: string; truncated: boolean } {
  let s = stripPadding(text.replace(/\r\n?/g, "\n")).toWellFormed();
  s = stripQuoted(s, opts);
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (s.length <= max) return { body: s, truncated: false };
  return { body: clampText(s, max).trimEnd(), truncated: true };
}
