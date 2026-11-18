import "server-only";
import { normalizeUrl } from "@/lib/domain/normalize";
import type { PageSnapshot } from "@/lib/types";
import { plain, plainLines, readPageParts } from "./extract";
import { MAX_FIELD } from "./limits";
import { parseUrl, toResult, type ParsedJobInput } from "./text";

/**
 * POST /api/extension/read: the job fields in what the Chrome extension read from the open tab
 * (a PageSnapshot, already validated by pageSnapshotSchema). Nothing is fetched: the page in the
 * user's browser is what counts. The rules are docs/plan/4-chrome-extension.md, "How the fields
 * are chosen". Per field, the first source with a value wins:
 *
 *   link                       the site reader's url; else the canonical link when it names the
 *                              same page as the tab; else the tab's address
 *   title, company, location   JSON-LD JobPosting → site reader → OpenGraph / <title> (the rules
 *                              of extract.ts) → the link heuristics (parseUrl)
 *   description                a selection of at least MIN_SELECTION characters (trimmed) →
 *                              JSON-LD → site reader → og:description / description → the link
 *
 * When the site reader's url names another page than the tab (a search page with a posting
 * open: LinkedIn's currentJobId, Indeed's vjk), the reader ranks above JSON-LD for title,
 * company, location and description: the page's JSON-LD may describe another posting, such as
 * the first of a list.
 *
 * The canonical link only ever makes the link cleaner (no utm_*), never names another job: it is
 * taken when its link key (normalizeUrl) is the tab's, and not when it would turn https into
 * http. Canonical links are often less specific than the tab (a plugin that drops ?gh_jid=, a
 * single-page site's static "/", a Glassdoor search without ?jl=), and the link decides "the
 * same job", so such a link would merge different postings into one.
 *
 * The JSON-LD, OpenGraph and title rules are extract.ts's own (readPageParts), so a page reads
 * the same here as when the server fetches it. A link that is not http(s) (a site reader's or
 * the canonical one) is ignored; a relative one is read against the tab's address. The site
 * reader's text is cleaned like the page's: one line for title, company and location, line
 * breaks kept in a description. toResult() then cuts every field to the job input limits and
 * lists the empty ones in `missing`.
 *
 * API
 *   readSnapshot(page)   the fields and `missing` (the service adds duplicateOf)
 *   MIN_SELECTION        200
 */

/** A selection at least this long (after trimming) is taken as the description. */
export const MIN_SELECTION = 200;

export function readSnapshot(page: PageSnapshot): ParsedJobInput {
  const tab = new URL(page.url);
  const fields = page.site?.fields ?? {};
  const readerLink = httpUrl(fields.url, tab);
  const link = readerLink?.href ?? chooseCanonical(page, tab);
  const fromLink = parseUrl(link);
  const reader = {
    title: plain(fields.title, MAX_FIELD),
    company: plain(fields.company, MAX_FIELD),
    location: plain(fields.location, MAX_FIELD),
    description: fields.description ? plainLines(fields.description) || undefined : undefined,
  };
  const { jsonLd, page: tags } = readPageParts(
    { jsonLd: page.jsonLd, meta: metaTags(page.meta), title: page.title },
    // The link's company is cut from titles, as for a fetched page; the reader's ranks above
    // OpenGraph, so a board's "Engineer at Acme" title is not split for the employer.
    { company: fromLink.company, knownCompany: reader.company },
  );
  // The reader read the posting its link names; when that is not the tab's page, the page's
  // JSON-LD may be about another posting, so the reader goes first.
  const [high, low] =
    readerLink && normalizeUrl(readerLink.href) !== normalizeUrl(tab.href) ? [reader, jsonLd] : [jsonLd, reader];
  const selection = page.selection.trim();

  return toResult({
    url: fromLink.url ?? link,
    title: first(high.title, low.title, tags.title, fromLink.title),
    company: first(high.company, low.company, tags.company, fromLink.company),
    location: first(high.location, low.location, tags.location, fromLink.location),
    description: first(
      selection.length >= MIN_SELECTION ? plainLines(selection) : undefined,
      high.description,
      low.description,
      tags.description,
      fromLink.description,
    ),
  });
}

/**
 * The canonical link when it is the tab's page by the link key (see the top of this file) and
 * keeps https; else the tab's address.
 */
function chooseCanonical(page: PageSnapshot, tab: URL): string {
  const canonical = httpUrl(page.canonicalUrl, tab);
  if (!canonical || normalizeUrl(canonical.href) !== normalizeUrl(tab.href)) return page.url;
  if (tab.protocol === "https:" && canonical.protocol !== "https:") return page.url;
  return canonical.href;
}

/** `raw` as an http(s) URL, read against the tab's address; null for anything else. */
function httpUrl(raw: string | null | undefined, base: URL): URL | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The snapshot's meta tags by lower-case name; the first non-blank value of a name wins. */
function metaTags(meta: Record<string, string>): Map<string, string> {
  const tags = new Map<string, string>();
  for (const [name, value] of Object.entries(meta)) {
    const key = name.trim().toLowerCase();
    if (value.trim() && !tags.has(key)) tags.set(key, value.trim());
  }
  return tags;
}

/** The first value that is not empty. */
function first(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => !!value);
}
