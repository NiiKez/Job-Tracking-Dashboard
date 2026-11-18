import type { SiteFields } from "@/lib/types";
import { blockText, lineText, type TextOptions } from "../text";

/**
 * What every site reader is built from: the reader shape, host tests that a look-alike domain
 * cannot pass, and "try these selectors in turn" lookups for sites whose markup has changed
 * over the years.
 */

export interface SiteReader {
  /** Sent as `site.reader`: `[a-z0-9-]{1,40}`. */
  name: string;
  /** True when this reader is meant for the page at `url`. Host and path only. */
  matches(url: URL): boolean;
  /** What the page shows, only the fields the reader is sure of; null when it finds nothing. */
  read(doc: Document, url: URL): SiteFields | null;
}

/** Anything selectors can run on: the document, or the part of it that holds the posting. */
export type Scope = Document | Element;

/**
 * `url` is on `domain` itself or a subdomain of it. Compared by whole labels, so
 * "evil-linkedin.com" and "linkedin.com.evil.example" are not on "linkedin.com".
 */
export function onHost(url: URL, ...domains: string[]): boolean {
  const host = hostOf(url);
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * `url` is on a brand's site in any country: "stepstone.de", "www.stepstone.at",
 * "uk.indeed.com", "glassdoor.co.uk", "glassdoor.com.au". The brand must be a whole label right
 * before the public suffix, so "stepstone.de.evil.example" and "notstepstone.de" are not.
 */
export function onBrand(url: URL, brand: string): boolean {
  return new RegExp(`(?:^|\\.)${brand}\\.(?:[a-z]{2,3}|(?:co|com)\\.[a-z]{2})$`).test(hostOf(url));
}

/** The host in lower case, without a trailing dot ("example.com." is "example.com"). */
function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

/** The first element any of the selectors finds, trying them in order. */
export function first(scope: Scope, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const found = scope.querySelector(selector);
    if (found) return found;
  }
  return null;
}

/**
 * The first non-empty one-line text the selectors find, in order: an element that is there but
 * empty (a placeholder still loading) moves on to the next selector.
 */
export function lineOf(scope: Scope, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    for (const el of scope.querySelectorAll(selector)) {
      const text = lineText(el);
      if (text) return text;
    }
  }
  return undefined;
}

/** As lineOf(), with the text's line structure: for descriptions. */
export function blockOf(
  scope: Scope,
  selectors: string[],
  options: TextOptions = {},
): string | undefined {
  for (const selector of selectors) {
    const el = scope.querySelector(selector);
    const text = blockText(el, { max: MAX_DESCRIPTION, ...options });
    if (text) return text;
  }
  return undefined;
}

/** Several parts of a page as one description, a blank line between them. */
export function joinBlocks(
  elements: Iterable<Element>,
  options: TextOptions = {},
): string | undefined {
  const parts: string[] = [];
  let length = 0;
  for (const el of elements) {
    if (length > MAX_DESCRIPTION) break;
    const text = blockText(el, { max: MAX_DESCRIPTION, ...options });
    if (!text) continue;
    parts.push(text);
    length += text.length + 2;
  }
  return parts.join("\n\n") || undefined;
}

/** `site.fields.description`'s limit; longer text is cut by readPage(). */
export const MAX_DESCRIPTION = 100_000;

/** The fields that have a value; null when none does. */
export function found(fields: SiteFields): SiteFields | null {
  const out: SiteFields = {};
  for (const key of ["url", "title", "company", "location", "description"] as const) {
    const value = fields[key]?.trim();
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The first `·`-separated part: "Berlin, Germany · 2 weeks ago" -> "Berlin, Germany". */
export function firstPart(text: string | undefined): string | undefined {
  return text?.split("·")[0].trim() || undefined;
}
