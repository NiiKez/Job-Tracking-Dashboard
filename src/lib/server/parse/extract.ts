import "server-only";
import { Parser, type Handler } from "htmlparser2";
import { slug } from "@/lib/domain/normalize";
import { MAX_DESCRIPTION, MAX_FIELD, clamp } from "./limits";

/**
 * Reads job fields out of a page. Order: a JSON-LD JobPosting, then OpenGraph tags, then
 * `<title>`. The caller fills what is still empty from the link heuristics.
 *
 * API
 *   extractJobPage(html, hints)        a fetched page (src/lib/server/parse/link.ts): the fields,
 *                                      JSON-LD first, then OpenGraph and <title>
 *   readPageParts(parts, hints)        the same reading from parts already taken out of a page
 *                                      (the Chrome extension's snapshot: JSON-LD texts, meta tags,
 *                                      the title), with what JSON-LD gave and what OpenGraph and
 *                                      <title> gave kept apart, so the caller can rank another
 *                                      source in between (src/lib/server/parse/snapshot.ts)
 *   htmlToText(html, max, opts)        HTML to readable plain text
 *   plain(raw, max) / plainLines(raw, max)
 *                                      one line of text / text that keeps its line breaks:
 *                                      whitespace collapsed, control characters dropped, cut
 */

export interface PageFields {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
}

export interface ExtractHints {
  /** The company the link heuristics found, used to strip it from page titles. */
  company?: string;
  /**
   * A company found by a source that ranks after JSON-LD and before OpenGraph (the extension's
   * site reader). It counts as the page naming its company: it is cut from titles, and a job
   * board's "Engineer at Acme" title is then not split for the employer.
   */
  knownCompany?: string;
}

/** What readPageParts() reads: the parts of a page that scan() takes out of its HTML. */
export interface PageParts {
  /** The text of each `<script type="application/ld+json">`, in page order. */
  jsonLd: readonly string[];
  /**
   * Meta tags by lower-case name: og:title, og:site_name, og:description and description. Others
   * are ignored. scan() collects only the OpenGraph ones, so a fetched page never reads
   * `description`.
   */
  meta: ReadonlyMap<string, string>;
  /** The page's `<title>` (document.title). */
  title?: string;
}

/** readPageParts(): the fields by where they came from. */
export interface PageSources {
  /** From a JSON-LD JobPosting. */
  jsonLd: PageFields;
  /**
   * From OpenGraph and `<title>`: title, company (og:site_name, or the employer in a job board's
   * title) and description (og:description, else the description meta). Never a location.
   */
  page: PageFields;
}

export function extractJobPage(html: string, hints: ExtractHints = {}): PageFields {
  const { jsonLd, page } = readPageParts(scan(html), hints);
  return {
    title: jsonLd.title ?? page.title,
    company: jsonLd.company ?? page.company,
    location: jsonLd.location,
    description: jsonLd.description ?? page.description,
  };
}

export function readPageParts(parts: PageParts, hints: ExtractHints = {}): PageSources {
  const roots = parts.jsonLd.map(parseJson);
  const posting = findJobPosting(roots);
  const fromLd = posting ? readPosting(posting, references(roots)) : {};

  const rawSiteName = plain(parts.meta.get("og:site_name"), MAX_FIELD);
  const site = siteName(rawSiteName);
  const known = plain(hints.knownCompany, MAX_FIELD);
  const company = fromLd.company ?? known ?? site;
  const context: TitleContext = {
    names: [company, site, rawSiteName, plain(hints.company, MAX_FIELD), known],
    onBoard: !!rawSiteName && PLATFORMS.test(rawSiteName),
    hasCompany: !!company,
  };
  const fromTitle = cleanTitle(parts.meta.get("og:title"), context) ?? cleanTitle(parts.title, context);
  return {
    jsonLd: fromLd,
    page: {
      title: fromTitle?.title,
      // On a job board, "Senior Engineer at Acme | LinkedIn" names the employer.
      company: site ?? fromTitle?.employer,
      description:
        plain(parts.meta.get("og:description"), MAX_DESCRIPTION) ??
        plain(parts.meta.get("description"), MAX_DESCRIPTION),
    },
  };
}

/* ------------------------------------------------------------------ scan */

const META_KEYS = new Set(["og:title", "og:site_name", "og:description"]);
const MAX_SCRIPTS = 20;

/** One pass over the page: JSON-LD scripts, the OpenGraph tags and the first `<title>`. */
function scan(html: string): PageParts {
  const jsonLd: string[] = [];
  const meta = new Map<string, string>();
  let title: string | undefined;
  let script: string | null = null;
  let titleText: string | null = null;
  let svgDepth = 0; // an SVG can carry its own <title>

  parseHtml(html, {
    onopentag(name, attrs) {
      if (name === "svg") {
        svgDepth++;
      } else if (name === "script" && isJsonLdType(attrs.type)) {
        script = "";
      } else if (name === "title" && svgDepth === 0 && title === undefined) {
        titleText = "";
      } else if (name === "meta") {
        const key = (attrs.property || attrs.name || "").trim().toLowerCase();
        const content = attrs.content?.trim();
        if (META_KEYS.has(key) && content && !meta.has(key)) meta.set(key, content);
      }
    },
    ontext(text) {
      if (script !== null) script += text;
      else if (titleText !== null) titleText += text;
    },
    onclosetag(name) {
      if (name === "svg") {
        svgDepth = Math.max(0, svgDepth - 1);
      } else if (name === "script" && script !== null) {
        if (jsonLd.length < MAX_SCRIPTS) jsonLd.push(script);
        script = null;
      } else if (name === "title" && titleText !== null) {
        title = titleText;
        titleText = null;
      }
    },
  });
  return { jsonLd, meta, title };
}

function isJsonLdType(type: string | undefined) {
  return (type ?? "").split(";")[0].trim().toLowerCase() === "application/ld+json";
}

/* --------------------------------------------------------------- JSON-LD */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** A broken script tag is skipped; the others are still read. */
function parseJson(text: string): unknown {
  const body = text
    .trim()
    .replace(/^<!--|-->$/g, "")
    .replace(/^\s*\/\/\s*<!\[CDATA\[|\/\/\s*\]\]>\s*$/g, "")
    .trim();
  try {
    return JSON.parse(body);
  } catch {
    // Raw line breaks and tabs inside strings are the most common breakage.
  }
  try {
    return JSON.parse(body.replace(/[\u0000-\u001f]+/g, " "));
  } catch {
    return undefined;
  }
}

/** Objects and arrays visited per page, over all its scripts (5,000 for each of MAX_SCRIPTS). */
const MAX_NODES = 100_000;

function isNode(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * Level by level over all the page's scripts, so a posting at the top wins over one nested
 * deeper, such as a "similar jobs" list, whichever script comes first. At the same level the
 * first in the page wins. Arrays and `@graph` add no level: their items are as top level as the
 * object or script holding them. Iterative, with a stack per level that keeps page order.
 */
function findJobPosting(roots: unknown[]): JsonObject | undefined {
  let level: unknown[] = roots.filter(isNode).reverse(); // the next node is last
  let budget = MAX_NODES;
  while (level.length > 0) {
    const below: unknown[] = [];
    while (level.length > 0) {
      if (budget-- <= 0) return undefined;
      const node = level.pop();
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) if (isNode(node[i])) level.push(node[i]);
      } else if (isObject(node)) {
        if (isJobPosting(node)) return node;
        for (const [key, value] of Object.entries(node)) {
          if (isNode(value)) (key === "@graph" ? level : below).push(value);
        }
      }
    }
    level = below.reverse();
  }
  return undefined;
}

type Deref = (value: unknown) => unknown;

/**
 * Follows a reference such as `{"@id": "#org"}` to the node with that `@id` anywhere on the page,
 * as `@graph` pages link their nodes. One level only: the node found is used as it is, so a
 * cycle cannot loop. The index is built on first use.
 */
function references(roots: unknown[]): Deref {
  let index: Map<string, JsonObject> | undefined;
  return (value) => {
    if (!isReference(value)) return value;
    index ??= indexIds(roots);
    return index.get(value["@id"] as string) ?? value;
  };
}

/** An object with an `@id` and nothing else but a `@type`. */
function isReference(value: unknown): value is JsonObject {
  return (
    isObject(value) &&
    typeof value["@id"] === "string" &&
    Object.keys(value).every((key) => key === "@id" || key === "@type")
  );
}

/** Every node with an `@id` that is more than a reference; the first in the page wins. */
function indexIds(roots: unknown[]) {
  const index = new Map<string, JsonObject>();
  const stack: unknown[] = roots.filter(isNode).reverse();
  for (let budget = MAX_NODES; stack.length > 0 && budget > 0; budget--) {
    const node = stack.pop();
    const children = Array.isArray(node) ? node : isObject(node) ? Object.values(node) : [];
    if (isObject(node) && typeof node["@id"] === "string" && !isReference(node)) {
      if (!index.has(node["@id"])) index.set(node["@id"], node);
    }
    for (let i = children.length - 1; i >= 0; i--) if (isNode(children[i])) stack.push(children[i]);
  }
  return index;
}

function isJobPosting(node: JsonObject) {
  // "JobPosting", "schema:JobPosting", "https://schema.org/JobPosting", alone or in an array.
  return toArray(node["@type"]).some(
    (type) => typeof type === "string" && /(?:^|[/#:])JobPosting$/i.test(type.trim()),
  );
}

/**
 * A string, the first string of an array, or a `{"@value": ...}` object. Undefined when blank,
 * so the next property in line is read instead (`title: ""` falls back to `name`).
 */
function str(value: unknown): string | undefined {
  const first = toArray(value)[0];
  const text = isObject(first) ? first["@value"] : first;
  return typeof text === "string" && /\S/.test(text) ? text : undefined;
}

const noDeref: Deref = (value) => value;

/** A plain string, or the `name` of an object (Organization, Country, Place). */
function nameOf(value: unknown, deref = noDeref): string | undefined {
  const first = deref(toArray(value)[0]);
  return isObject(first) ? (str(first.name) ?? str(first.legalName)) : str(first);
}

function readPosting(posting: JsonObject, deref: Deref): PageFields {
  return {
    title: fromHtml(str(posting.title)) ?? fromHtml(str(posting.name)),
    company: fromHtml(nameOf(posting.hiringOrganization, deref)),
    location: locationOf(posting, deref),
    description: descriptionOf(str(posting.description)),
  };
}

function locationOf(posting: JsonObject, deref: Deref): string | undefined {
  const types = toArray(posting.jobLocationType).map((t) => String(t).toUpperCase());
  if (types.some((t) => t.includes("TELECOMMUTE"))) return "Remote";

  const places = toArray(posting.jobLocation)
    .map((place) => placeText(deref(place), deref))
    .filter(Boolean);
  return fromHtml(unique(places).join("; "));
}

function placeText(place: unknown, deref: Deref): string {
  if (typeof place === "string") return place;
  if (!isObject(place)) return "";
  const address = deref(toArray(place.address)[0]);
  if (typeof address === "string") return address;
  if (!isObject(address)) return str(place.name) ?? "";
  const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
    .map((part) => nameOf(part, deref))
    .filter((p): p is string => !!p?.trim())
    .map((p) => p.trim());
  // Berlin, Berlin, DE -> Berlin, DE
  return unique(parts).join(", ");
}

function unique(items: string[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A JSON-LD string is read as HTML only when it holds one of these tags, so a "<" in plain text
// ("Salary <EUR 60k", "Engineer <Backend>") stays text. `[^<>]*` keeps the test linear.
const HTML_TAG = new RegExp(
  "<\\/?(?:a|abbr|address|article|aside|b|blockquote|br|center|cite|code|dd|del|div|dl|dt|em|" +
    "figcaption|figure|font|footer|h[1-6]|header|hr|i|iframe|img|ins|li|main|mark|nav|noscript|ol|" +
    "p|pre|s|script|section|small|span|strong|style|sub|sup|svg|table|tbody|td|tfoot|th|thead|tr|" +
    "u|ul)\\b[^<>]*>",
  "i",
);
// Tags that start a new line (BLOCK_TAGS, br, li, tr). HTML without any keeps its text's line breaks.
const LINE_TAG = new RegExp(
  "<\\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|" +
    "form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul)\\b[^<>]*>",
  "i",
);

function descriptionOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let html = raw;
  if (!HTML_TAG.test(html)) {
    // Plain text keeps its own line breaks. Some sites escape the HTML once more
    // ("&lt;p&gt;Hello&lt;/p&gt;"): that is HTML once decoded.
    html = decodeEntities(raw);
    if (html === raw || !HTML_TAG.test(html)) return plainLines(html) || undefined;
  }
  // "Tasks\n- Own the <b>database</b>" has no tag that breaks lines: it keeps its own.
  const keepLines = !LINE_TAG.test(html);
  if (keepLines) html = html.replace(/\r\n?/g, "\n");
  return htmlToText(html, MAX_DESCRIPTION, { keepLines }) || undefined;
}

/** Text that keeps its line breaks: each line's whitespace collapsed, at most one blank line in a row, cut to `max`. */
export function plainLines(text: string, max = MAX_DESCRIPTION) {
  const lines = text
    .split(/\r\n?|\n/)
    .map((line) => line.replace(/\s+/g, " ").replace(CONTROL, "").trim());
  return clamp(lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), max);
}

/* ---------------------------------------------------------------- titles */

// Job boards and applicant tracking systems: their name is never the employer.
const PLATFORM_NAMES = [
  "linkedin",
  "indeed",
  "stepstone",
  "xing",
  "glassdoor",
  "greenhouse",
  "lever",
  "workday",
  "personio",
  "smartrecruiters",
  "ashby",
  "recruitee",
  "workable",
  "jobvite",
  "teamtailor",
  "softgarden",
];
const PLATFORMS = new RegExp(`^(?:${PLATFORM_NAMES.join("|")})(?:\\.[a-z]{2,})*$`, "i");
const GENERIC_WORDS = "careers?|jobs?|karriere|stellenangebote|job openings?|open positions?";
const GENERIC = new RegExp(`^(?:${GENERIC_WORDS})$`, "i");
// A career site's own name: "Careers at Acme", "Karriere bei Acme GmbH". Not "Jobs at Acme: Engineer".
const GENERIC_AT = new RegExp(`^(?:${GENERIC_WORDS})\\s+(?:at|bei|@)\\s+[^:]+$`, "i");
const CAREERS_SUFFIX = /\s+(?:careers?|jobs?|karriere)$/i;
// " | ", " - ", " – ", " — ", " · " with spaces around, so "Front-end" stays whole.
const SEPARATOR = /(\s+[|–—·-]\s+)/;
const AT = /\s+(?:at|bei|@)\s+/gi;
// Legal forms slug() keeps; it drops gmbh, ag, inc, ltd, llc, co, se and bv itself.
const LEGAL_FORMS =
  /(?<![\p{L}\p{N}])(?:&\s*co|sa|nv|plc|corp|corporation|limited|ug|kg|oy|ab|pty)(?![\p{L}\p{N}])/giu;

/** Compares company names: "Acme", "ACME GmbH", "Acme S.A." and "Acme Inc." are one company. */
function companyKey(name: string) {
  return slug(name.replace(/\./g, "").replace(LEGAL_FORMS, ""));
}

/** og:site_name as a company: "Acme Careers" -> "Acme"; job boards and ATS names are dropped. */
function siteName(raw: string | undefined): string | undefined {
  const name = plain(raw, MAX_FIELD)?.replace(CAREERS_SUFFIX, "");
  return name && !PLATFORMS.test(name) && !GENERIC.test(name) ? name : undefined;
}

interface TitleContext {
  /** Company names to cut from the title. */
  names: Array<string | undefined>;
  /** og:site_name is a job board. */
  onBoard: boolean;
  /** The page names the company. */
  hasCompany: boolean;
}

interface Title {
  title: string;
  /** "Acme" from "Senior Engineer at Acme | LinkedIn": set on a job board only. */
  employer?: string;
}

/**
 * "Backend Engineer | Acme Careers" -> "Backend Engineer". Undefined when only the site's own
 * name is left ("Careers at Acme"). On a job board (`onBoard`, or a board's name cut from the
 * title) that does not name the company, the employer in "Senior Engineer at Acme" is split off.
 */
function cleanTitle(
  raw: string | undefined,
  { names, onBoard, hasCompany }: TitleContext,
): Title | undefined {
  const title = plain(raw, MAX_FIELD * 4);
  if (!title) return undefined;
  const known = new Set(names.map((name) => (name ? companyKey(name) : "")).filter(Boolean));
  const isKnown = (s: string) =>
    known.has(companyKey(s)) || known.has(companyKey(s.replace(CAREERS_SUFFIX, "")));
  let board = onBoard;
  const isNoise = (segment: string) => {
    const s = segment.trim();
    if (PLATFORMS.test(s)) board = true; // a noise segment is always cut
    return GENERIC.test(s) || GENERIC_AT.test(s) || PLATFORMS.test(s) || isKnown(s);
  };

  const parts = title.split(SEPARATOR); // [segment, separator, segment, ...]
  while (parts.length >= 3 && isNoise(parts[parts.length - 1])) parts.splice(-2);
  while (parts.length >= 3 && isNoise(parts[0])) parts.splice(0, 2);

  let cleaned = parts.join("").replace(/^job application for\s+/i, "");
  let employer: string | undefined;
  const ats = [...cleaned.matchAll(AT)];
  // "Backend Engineer at Acme AG" -> "Backend Engineer"
  const own = ats.find((at) => isKnown(cleaned.slice(at.index + at[0].length)));
  if (own) {
    cleaned = cleaned.slice(0, own.index);
  } else if (board && !hasCompany && ats.length > 0) {
    const last = ats[ats.length - 1];
    const name = cleaned.slice(last.index + last[0].length);
    if (!isNoise(name) && !SEPARATOR.test(name)) {
      employer = clamp(name, MAX_FIELD);
      cleaned = cleaned.slice(0, last.index);
    }
  }
  cleaned = clamp(cleaned.trim(), MAX_FIELD);
  return cleaned && !isNoise(cleaned) ? { title: cleaned, employer } : undefined;
}

/* ------------------------------------------------------------------ text */

const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f]/g;

/** One line of plain text (already decoded, e.g. an attribute), trimmed and capped. */
export function plain(raw: string | undefined, max: number): string | undefined {
  if (!raw) return undefined;
  return clamp(raw.replace(/\s+/g, " ").replace(CONTROL, "").trim(), max) || undefined;
}

/** One line from a JSON-LD string, which may hold tags or entities. */
function fromHtml(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = HTML_TAG.test(raw) ? htmlToText(raw).replace(/\n/g, " ") : decodeEntities(raw);
  return plain(text, MAX_FIELD);
}

/** Decodes entities and nothing else: a "<" stays text. */
function decodeEntities(s: string) {
  if (!s.includes("&")) return s;
  let out = "";
  parseHtml(s.replace(/</g, "&lt;"), {
    ontext(text) {
      out += text;
    },
  });
  return out;
}

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);
const SKIP_TAGS = new Set([
  "head",
  "iframe",
  "noscript",
  "object",
  "script",
  "style",
  "svg",
  "template",
]);

/**
 * HTML to readable plain text: paragraphs become blank lines, `<br>` a line break, list items
 * "• " lines; entities are decoded and other whitespace collapsed. Capped at `max` characters.
 * With `keepLines`, each "\n" in the text counts as a `<br>`.
 */
export function htmlToText(
  html: string,
  max = MAX_DESCRIPTION,
  { keepLines = false }: { keepLines?: boolean } = {},
): string {
  let out = "";
  let pending = 0; // line breaks owed before the next text (2 = paragraph)
  let bullet = false;
  let skip = 0;
  const lineBreak = (n: number) => {
    pending = Math.max(pending, n);
  };
  const addText = (raw: string) => {
    if (out.length > max) return;
    let text = raw.replace(/\s+/g, " ").replace(CONTROL, "");
    if (pending || !out) text = text.trimStart();
    if (!text) return;
    if (out && pending) out = out.trimEnd() + "\n".repeat(pending);
    if (bullet) {
      out += "• ";
      bullet = false;
    }
    pending = 0;
    if (out.endsWith(" ") && text.startsWith(" ")) text = text.slice(1);
    out += text;
  };

  parseHtml(html, {
    onopentag(name) {
      if (SKIP_TAGS.has(name)) skip++;
      if (skip) return;
      if (name === "br") {
        pending = Math.min(pending + 1, 2);
      } else if (name === "li") {
        lineBreak(1);
        bullet = true;
      } else if (name === "tr") {
        lineBreak(1);
      } else if (BLOCK_TAGS.has(name)) {
        lineBreak(2);
      }
    },
    onclosetag(name) {
      if (SKIP_TAGS.has(name)) {
        skip = Math.max(0, skip - 1);
        return;
      }
      if (skip) return;
      if (name === "li" || name === "tr") {
        lineBreak(1);
        bullet = false;
      } else if (BLOCK_TAGS.has(name)) {
        lineBreak(2);
      } else if ((name === "td" || name === "th") && out && !out.endsWith(" ")) {
        out += " ";
      }
    },
    ontext(raw) {
      if (skip) return;
      if (!keepLines) return addText(raw);
      // A line break counts as a <br>, two or more (blank lines between) as a paragraph.
      const breaks = /\n\s*/g;
      let start = 0;
      for (let at = breaks.exec(raw); at && out.length <= max; at = breaks.exec(raw)) {
        addText(raw.slice(start, at.index));
        pending = Math.min(pending + (at[0].includes("\n", 1) ? 2 : 1), 2);
        start = breaks.lastIndex;
      }
      addText(raw.slice(start));
    },
  });
  return clamp(out.replace(/ +\n/g, "\n").trim(), max);
}

/* ---------------------------------------------------------------- parser */

/**
 * How deep open elements may nest before the rest of the input is left unread. htmlparser2 keeps
 * the open elements in an array it grows with unshift, so every unclosed tag costs as much as the
 * tags open around it: a page of 300,000 unclosed `<b>` took over a minute. Real pages nest a few
 * dozen levels (browsers stop building deeper than 512).
 */
export const MAX_DEPTH = 256;

type Handlers = Pick<Partial<Handler>, "onopentag" | "onclosetag" | "ontext">;

/** htmlparser2 over `html`, stopped where elements nest deeper than MAX_DEPTH. */
function parseHtml(html: string, cbs: Handlers) {
  // The open and close callbacks mirror the parser's stack: implied closes are reported too,
  // and a void element is closed right after it opens.
  let depth = 0;
  let stopped = false;
  const parser = new Parser({
    onopentag(name, attrs, isImplied) {
      if (stopped) return;
      if (++depth > MAX_DEPTH) {
        stopped = true;
        parser.pause(); // write() returns after this tag, and end() then reads nothing more
        return;
      }
      cbs.onopentag?.(name, attrs, isImplied);
    },
    onclosetag(name, isImplied) {
      if (stopped) return;
      depth--;
      cbs.onclosetag?.(name, isImplied);
    },
    ontext(text) {
      if (!stopped) cbs.ontext?.(text);
    },
  });
  parser.write(html);
  parser.end();
}
