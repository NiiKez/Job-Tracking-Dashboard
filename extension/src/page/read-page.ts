import type { PageSnapshot, SiteFields } from "@/lib/types";
import { readerFor } from "./sites";
import { collapse } from "./text";

/**
 * Turns the open job page into a PageSnapshot for POST /api/extension/read: text only, never
 * the page's HTML. It takes what every page may have (the canonical link, the title, four meta
 * tags, the JSON-LD scripts) plus what the page's site reader finds, and the user's selection.
 * The server merges these into the job's fields (docs/plan/4-chrome-extension.md, "How the
 * fields are chosen"), so nothing is chosen or parsed here beyond what a site reader does.
 *
 * Everything is cut to the snapshot limits the server checks, so a big or odd page gives a
 * smaller snapshot rather than a refused one. It never throws for what is on the page: a site
 * reader that fails leaves `site` empty, and the rest is still sent. U+0000 is removed from all
 * the text (the server refuses a request with one anywhere, and a page's scripts can put one into
 * its text). The tab's address becomes the job's link when nothing else names the posting, so
 * one over the limit first loses what does not identify the page (see tabUrl()) and is cut only
 * when that is not enough.
 *
 * The limits count characters, but the server reads at most 1 MiB of request body, and a
 * character can take up to six bytes in JSON (CJK text three, an escaped quote or backslash
 * two). So the whole request body, `{ "page": snapshot }` as JSON in UTF-8, is also kept within
 * MAX_BODY_BYTES (900,000, a margin under 1 MiB). A snapshot over it sheds, in this order and
 * only until it fits: JSON-LD scripts that do not mention JobPosting (largest first), the
 * selection (cut, but a selection long enough to be the description keeps at least that), the
 * site reader's description (cut), the remaining JSON-LD scripts (largest first), and last the
 * meta values and the title (cut). A page of ordinary size is never touched.
 *
 * Pure DOM, no `chrome.*`: entry.ts calls it in the tab, the tests call it on fixtures.
 */

export const LIMITS = {
  url: 2_048,
  title: 1_000,
  metaValue: 5_000,
  jsonLdScript: 200_000,
  jsonLdTotal: 600_000,
  jsonLdCount: 20,
  field: 1_000,
  description: 100_000,
  selection: 100_000,
} as const;

/** The most the request body may take: JSON in UTF-8, under the server's 1 MiB. */
export const MAX_BODY_BYTES = 900_000;

/** A selection of this many characters (trimmed) becomes the job's description on the server. */
const MIN_SELECTION = 200;

/** The meta tags the server reads, by `property` or `name`. */
const META_KEYS = new Set(["og:title", "og:site_name", "og:description", "description"]);

export function readPage(doc: Document, url: URL, selection: string): PageSnapshot {
  return withinBudget({
    url: tabUrl(url),
    canonicalUrl: canonicalUrl(doc, url),
    title: cut(collapse(withoutNul(doc.title ?? "")), LIMITS.title),
    meta: meta(doc),
    jsonLd: jsonLd(doc),
    site: site(doc, url),
    selection: cut(withoutNul(selection), LIMITS.selection),
  });
}

/**
 * Cuts to `max` UTF-16 units without leaving the first half of a surrogate pair at the end
 * (an emoji cut in two). Shorter text is returned as it is.
 */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max);
}

/**
 * `text` without U+0000. Addresses never need this: the URL parser writes a NUL as %00, so
 * everything that comes out of `new URL()` is free of it.
 */
function withoutNul(text: string): string {
  return text.replaceAll("\u0000", "");
}

/* ------------------------------------------------------------ the parts */

/**
 * The tab's address within LIMITS.url. A longer one sheds, until it fits: a fragment that is not
 * a client-side route ("#apply" goes, "#/jobs/1" and "#!/jobs/1" stay, as in the server's link
 * key), then the tracking parameters the link key leaves out anyway, each other parameter kept
 * as it is written. Only what is still too long after that is cut.
 */
function tabUrl(url: URL): string {
  if (url.href.length <= LIMITS.url) return url.href;
  const shorter = new URL(url.href);
  if (!/^#!?\//.test(shorter.hash)) shorter.hash = "";
  if (shorter.href.length > LIMITS.url) shorter.search = withoutTracking(shorter.search);
  return cut(shorter.href, LIMITS.url);
}

/**
 * Tracking parameters, as normalizeUrl() in src/lib/domain/normalize.ts leaves them out of the
 * link key: utm_* and these names, in any case (the tests check that the two agree).
 */
const TRACKING_PARAMS = new Set(["ref", "refid", "referrer", "source", "gh_src", "trk", "trackingid"]);

/**
 * A query (`?a=1&b=2`, or "") without its tracking parameters, every other pair as written; ""
 * when none is left.
 */
function withoutTracking(search: string): string {
  const query = search
    .slice(1)
    .split("&")
    .filter((pair) => !isTrackingParam(queryName(pair)))
    .join("&");
  return query ? `?${query}` : "";
}

function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase();
  return key.startsWith("utm_") || TRACKING_PARAMS.has(key);
}

/** A query pair's name, decoded as a form field ("+" is a space); as written when it does not decode. */
function queryName(pair: string): string {
  const eq = pair.indexOf("=");
  const raw = eq === -1 ? pair : pair.slice(0, eq);
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/**
 * The first `<link rel="canonical">`, as an absolute http(s) address; null when there is none,
 * or it is something else, or too long to send (cutting would change where it points).
 */
function canonicalUrl(doc: Document, url: URL): string | null {
  for (const link of doc.querySelectorAll("link[rel][href]")) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("canonical")) continue;
    const href = httpUrl(link.getAttribute("href") ?? "", baseUrl(doc, url));
    return href && href.length <= LIMITS.url ? href : null;
  }
  return null;
}

/** What relative links resolve against: the page's `<base href>`, else its address. */
function baseUrl(doc: Document, url: URL): URL {
  const base = doc.querySelector("base[href]")?.getAttribute("href");
  if (!base) return url;
  try {
    return new URL(base, url);
  } catch {
    return url;
  }
}

/** `raw` as an absolute http(s) address, or null. */
function httpUrl(raw: string, base?: URL): string | null {
  try {
    const parsed = new URL(raw.trim(), base);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** The first non-empty value of each of META_KEYS, keys in lower case. */
function meta(doc: Document): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of doc.querySelectorAll("meta[content]")) {
    const key = (el.getAttribute("property") || el.getAttribute("name") || "").trim().toLowerCase();
    if (!META_KEYS.has(key) || Object.hasOwn(out, key)) continue;
    const value = withoutNul(el.getAttribute("content") ?? "").trim();
    if (value) out[key] = cut(value, LIMITS.metaValue);
  }
  return out;
}

/**
 * The JSON-LD scripts, in page order, within the limits: a script over the size limit is
 * dropped (cut JSON is no JSON), and scripts are added, those mentioning JobPosting first,
 * until the next one would take the total over its limit or the count is reached.
 */
function jsonLd(doc: Document): string[] {
  const scripts = [...doc.querySelectorAll("script[type]")]
    .filter((script) => isJsonLdType(script.getAttribute("type")))
    .map((script, index) => ({ index, text: withoutNul(script.textContent ?? "") }))
    .filter(({ text }) => /\S/.test(text) && text.length <= LIMITS.jsonLdScript);
  const byPreference = [
    ...scripts.filter(({ text }) => mentionsJobPosting(text)),
    ...scripts.filter(({ text }) => !mentionsJobPosting(text)),
  ];

  const chosen: typeof scripts = [];
  let total = 0;
  for (const script of byPreference) {
    if (chosen.length >= LIMITS.jsonLdCount) break;
    if (total + script.text.length > LIMITS.jsonLdTotal) continue;
    chosen.push(script);
    total += script.text.length;
  }
  return chosen.sort((a, b) => a.index - b.index).map(({ text }) => text);
}

/** "application/ld+json", in any case, with parameters or without (as the server reads it). */
function isJsonLdType(type: string | null) {
  return (type ?? "").split(";")[0].trim().toLowerCase() === "application/ld+json";
}

/** What the page's site reader found; null when it found nothing or failed. */
function site(doc: Document, url: URL): PageSnapshot["site"] {
  try {
    const reader = readerFor(url);
    const fields = siteFields(reader.read(doc, url));
    return fields ? { reader: reader.name, fields } : null;
  } catch {
    return null;
  }
}

/**
 * A reader's fields within the limits: one-line fields collapsed, U+0000 removed, a non-http
 * link dropped.
 */
function siteFields(fields: SiteFields | null): SiteFields | null {
  if (!fields) return null;
  const out: SiteFields = {};
  const url = fields.url ? httpUrl(fields.url) : null;
  if (url && url.length <= LIMITS.url) out.url = url;
  for (const key of ["title", "company", "location"] as const) {
    const value = cut(collapse(withoutNul(fields[key] ?? "")), LIMITS.field).trim();
    if (value) out[key] = value;
  }
  const description = cut(withoutNul(fields.description ?? "").trim(), LIMITS.description).trimEnd();
  if (description) out.description = description;
  return Object.keys(out).length > 0 ? out : null;
}

/* ----------------------------------------------------------- byte budget */

const encoder = new TextEncoder();

/** The request body's size: `{ "page": snapshot }` as JSON, in UTF-8 bytes. */
export function bodyBytes(snapshot: PageSnapshot): number {
  return encoder.encode(JSON.stringify({ page: snapshot })).length;
}

/**
 * Sheds parts of `snapshot` (in place) until its request body takes at most `maxBytes`, in the
 * order the header gives. Each step works out what to drop or cut from the sizes of the parts;
 * the whole body is measured again only between steps.
 */
export function withinBudget(snapshot: PageSnapshot, maxBytes = MAX_BODY_BYTES): PageSnapshot {
  const steps = [
    (excess: number) => dropJsonLd(snapshot, excess, { postings: false }),
    (excess: number) => cutSelection(snapshot, excess),
    (excess: number) => cutSiteDescription(snapshot, excess),
    (excess: number) => dropJsonLd(snapshot, excess, { postings: true }),
    (excess: number) => cutMetaAndTitle(snapshot, excess),
  ];
  for (const step of steps) {
    const excess = bodyBytes(snapshot) - maxBytes;
    if (excess <= 0) break;
    step(excess);
  }
  return snapshot;
}

/** Drops JSON-LD scripts that mention JobPosting, or those that do not, largest first. */
function dropJsonLd(snapshot: PageSnapshot, excess: number, { postings }: { postings: boolean }) {
  const scripts = snapshot.jsonLd.map((text, index) => ({ index, bytes: jsonBytes(text), text }));
  const candidates = scripts
    .filter(({ text }) => mentionsJobPosting(text) === postings)
    .sort((a, b) => b.bytes - a.bytes);
  const dropped = new Set<number>();
  let freed = 0;
  let left = scripts.length;
  for (const script of candidates) {
    if (freed >= excess) break;
    dropped.add(script.index);
    freed += script.bytes + (left > 1 ? 1 : 0); // and the comma before or after it
    left--;
  }
  snapshot.jsonLd = snapshot.jsonLd.filter((_, index) => !dropped.has(index));
}

/**
 * Cuts the selection by `excess` bytes. One that the server would take as the description (200
 * characters or more, trimmed) keeps at least that much, so the user's choice still counts; a
 * shorter one is no description and is dropped.
 */
function cutSelection(snapshot: PageSnapshot, excess: number) {
  const text = snapshot.selection.trim();
  if (text.length < MIN_SELECTION) {
    snapshot.selection = "";
    return;
  }
  const shorter = cutToBytes(text, jsonBytes(snapshot.selection) - excess);
  const least = selectionFloor(text);
  snapshot.selection = shorter.length >= least ? shorter : text.slice(0, least);
}

/**
 * How much of a trimmed selection keeps it a description: up to and including its first
 * non-space character at or after position 200, so the server's trim leaves 200 characters.
 */
function selectionFloor(text: string): number {
  const nonSpace = /\S/g;
  nonSpace.lastIndex = MIN_SELECTION - 1;
  const at = nonSpace.exec(text)?.index ?? text.length - 1;
  return isHighSurrogate(text.charCodeAt(at)) ? at + 2 : at + 1;
}

/** Cuts the site reader's description by `excess` bytes; drops it (or `site`) when none is left. */
function cutSiteDescription(snapshot: PageSnapshot, excess: number) {
  const fields = snapshot.site?.fields;
  if (!fields?.description) return;
  const shorter = cutToBytes(fields.description, jsonBytes(fields.description) - excess).trimEnd();
  if (shorter) fields.description = shorter;
  else delete fields.description;
  if (Object.keys(fields).length === 0) snapshot.site = null;
}

/** Cuts the meta values and the title, largest first, until `excess` bytes are gone. */
function cutMetaAndTitle(snapshot: PageSnapshot, excess: number) {
  const parts = [
    ...Object.entries(snapshot.meta).map(([key, value]) => ({ key, value })),
    { key: null, value: snapshot.title },
  ].sort((a, b) => b.value.length - a.value.length);
  let left = excess;
  for (const { key, value } of parts) {
    if (left <= 0) break;
    const shorter = cutToBytes(value, jsonBytes(value) - left);
    left -= jsonBytes(value) - jsonBytes(shorter);
    if (key === null) snapshot.title = shorter;
    else if (shorter) snapshot.meta[key] = shorter;
    else delete snapshot.meta[key];
  }
}

function mentionsJobPosting(text: string) {
  return /JobPosting/i.test(text);
}

/**
 * The bytes `text` takes as a JSON string in UTF-8, quotes included: what JSON.stringify writes
 * for it, counted without building it.
 */
export function jsonBytes(text: string): number {
  let bytes = 2;
  for (let i = 0; i < text.length; i += unitsAt(text, i)) bytes += bytesAt(text, i);
  return bytes;
}

/** The longest start of `text` taking at most `maxBytes` as a JSON string; never half an emoji. */
export function cutToBytes(text: string, maxBytes: number): string {
  let bytes = 2;
  for (let i = 0; i < text.length; i += unitsAt(text, i)) {
    bytes += bytesAt(text, i);
    if (bytes > maxBytes) return text.slice(0, i);
  }
  return text;
}

/** 2 for a surrogate pair at `i`, else 1. */
function unitsAt(text: string, i: number): number {
  return isHighSurrogate(text.charCodeAt(i)) && isLowSurrogate(text.charCodeAt(i + 1)) ? 2 : 1;
}

/** The JSON bytes of the character at `i`: escapes as JSON.stringify writes them, else UTF-8. */
function bytesAt(text: string, i: number): number {
  const code = text.charCodeAt(i);
  if (code === 0x22 || code === 0x5c) return 2; // \" and \\
  if (code < 0x20) return "\b\t\n\f\r".includes(text[i]) ? 2 : 6; // \n or \u0001
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (unitsAt(text, i) === 2) return 4;
  if (isHighSurrogate(code) || isLowSurrogate(code)) return 6; // a lone half: \ud83d
  return 3;
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}
