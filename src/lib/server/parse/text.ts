import "server-only";
import type { ParseResult } from "@/lib/types";
import { MAX_DESCRIPTION, MAX_FIELD, fit } from "./limits";

/**
 * The heuristics of the old mock parser (src/lib/server/parse.ts until 1.6). Pasted text uses
 * them; a link uses them to fill blanks and as the fallback when the page cannot be fetched, so a
 * failed fetch gives today's result. Changed from the mock only where it broke: a malformed `%`
 * escape in a link threw, `%00` put a NUL into a field (which PostgreSQL refuses), the slug test
 * took seconds on a long path segment, and fields were not cut to the job input limits.
 */

export type ParsedJobInput = Omit<ParseResult, "duplicateOf">;

const CITIES = [
  "Berlin",
  "Munich",
  "München",
  "Hamburg",
  "Cologne",
  "Köln",
  "Frankfurt",
  "Stuttgart",
  "Leipzig",
  "Düsseldorf",
  "Vienna",
  "Wien",
  "Zurich",
  "Zürich",
  "Amsterdam",
  "Rotterdam",
  "London",
  "Paris",
  "Stockholm",
  "Lisbon",
  "Barcelona",
];

function titleCase(s: string) {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 && w !== "ui" ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/\bUi\b/g, "UI")
    .replace(/\bUx\b/g, "UX");
}

/** decodeURIComponent, or the text as it is when an escape is malformed (it throws then). */
function decodeSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function fromSlug(s: string) {
  return titleCase(
    decodeSafe(s)
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/[-_+]+/g, " ")
      .replace(/\b\d{3,}\b/g, "")
      .trim(),
  );
}

/**
 * A letter, later a hyphen, later a letter: what /[a-z].*-.*[a-z]/i tests, in one pass. That
 * expression backtracks quadratically, about two seconds on a 50,000-character segment.
 */
function looksLikeSlug(segment: string) {
  const firstLetter = segment.search(/[a-z]/i);
  if (firstLetter < 0) return false;
  const hyphen = segment.indexOf("-", firstLetter + 1);
  return hyphen >= 0 && /[a-z]/i.test(segment.slice(hyphen + 1));
}

export function parseUrl(raw: string): Partial<ParseResult> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return {};
  }
  const host = url.hostname.replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  const out: Partial<ParseResult> = { url: url.toString() };

  const jobSlug = [...parts]
    .reverse()
    .find((p) => looksLikeSlug(p) && !/^jobs?$/i.test(p));

  if (host.endsWith("greenhouse.io") && parts[0]) {
    out.company = fromSlug(parts[0]);
  } else if (host.endsWith("lever.co") && parts[0]) {
    out.company = fromSlug(parts[0]);
  } else if (host.endsWith("myworkdayjobs.com")) {
    out.company = fromSlug(host.split(".")[0]);
  } else if (host.endsWith("jobs.personio.de") || host.endsWith("jobs.personio.com")) {
    out.company = fromSlug(host.split(".")[0]);
  } else if (/linkedin\.com|indeed\.|stepstone\.|xing\.com|glassdoor\./.test(host)) {
    // Job boards: company is not in the URL.
  } else {
    const labels = host.split(".");
    const name = labels.length > 2 ? labels[labels.length - 2] : labels[0];
    out.company = fromSlug(name);
  }
  if (jobSlug) out.title = fromSlug(jobSlug);
  const city = CITIES.find((c) => url.pathname.toLowerCase().includes(c.toLowerCase()));
  if (city) out.location = city;
  if (/remote/i.test(url.pathname)) out.location = "Remote";
  return out;
}

export function parseText(raw: string): Partial<ParseResult> {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: Partial<ParseResult> = { description: raw.trim() };

  const field = (label: RegExp) => {
    for (const l of lines) {
      const m = l.match(label);
      if (m?.[1]) return m[1].trim();
    }
    return undefined;
  };

  out.title =
    field(/^(?:job title|title|position|stelle)\s*[:\-–]\s*(.+)$/i) ??
    lines.find((l) => l.length <= 80 && !/^https?:/i.test(l));
  out.company =
    field(/^(?:company|employer|unternehmen|firma)\s*[:\-–]\s*(.+)$/i) ??
    raw.match(/\b(?:at|bei|@)\s+([A-Z][\w&.\- ]{1,40}?)(?:[,.\n]| in | is | ist |$)/)?.[1]?.trim();
  out.location =
    field(/^(?:location|ort|standort|arbeitsort)\s*[:\-–]\s*(.+)$/i) ??
    (/\bremote\b/i.test(raw) ? "Remote" : CITIES.find((c) => raw.includes(c)));
  const link = raw.match(/https?:\/\/\S+/)?.[0];
  if (link) {
    const fromLink = parseUrl(link);
    out.url = fromLink.url;
    out.company ??= fromLink.company;
  }
  return out;
}

/** True when the input is a single http(s) link (anything else is treated as pasted text). */
export function isSingleLink(input: string) {
  return /^https?:\/\/\S+$/i.test(input.trim());
}

/**
 * Fills in empty strings and computes `missing`, as the mock does. Every text field is cut to
 * the job input limits here, whatever it came from (a page, a link, a paste), so the add-job
 * dialog can always save the result. The link is the user's own and is not cut.
 */
export function toResult(p: Partial<ParseResult>): ParsedJobInput {
  const result = {
    title: fit(p.title, MAX_FIELD),
    company: fit(p.company, MAX_FIELD),
    location: fit(p.location, MAX_FIELD),
    url: p.url ?? null,
    description: fit(p.description, MAX_DESCRIPTION),
  };
  const missing = (Object.keys(result) as Array<keyof typeof result>).filter(
    (k) => !result[k],
  );
  return { ...result, missing };
}

/** Today's parser, unchanged: no network. */
export function parseWithHeuristics(input: string): ParsedJobInput {
  const trimmed = input.trim();
  return toResult(isSingleLink(trimmed) ? parseUrl(trimmed) : parseText(trimmed));
}
