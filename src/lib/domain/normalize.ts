/**
 * Text and URL keys used to match emails, find duplicate jobs and search.
 * Pure: imported by client components, the classifier and the server.
 */

/**
 * Strip accents (ü → u) and compatibility forms (™ → tm, ﬁ → fi), lowercase, collapse
 * whitespace. Idempotent: NFKD runs before lowercasing, so a decomposition that yields capitals
 * ("™" → "TM") is lowercased in the same pass. U+0000 is dropped: PostgreSQL text cannot hold
 * it, so no stored key contains one, and a search for it would fail in the database.
 */
export function normalize(s: string) {
  return s
    .replaceAll("\u0000", "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Company key: "Acme GmbH", "ACME" and "Acme™" all become "acme". Symbols (Unicode "Other
 * Symbol": ™ ® © ℠ №, emoji) are removed before normalize(), which would otherwise turn "™" into
 * "tm"; so are the circled and parenthesized letters (Ⓐ, ⒜), which are symbols too. Then "&"
 * becomes "and", the legal-form words (gmbh, ag, inc, ltd, llc, co, se, bv) go, and only a-z
 * and 0-9 are kept.
 */
export function slug(s: string) {
  return normalize(s.replace(/\p{So}/gu, ""))
    .replace(/&/g, "and")
    .replace(/\b(gmbh|ag|inc|ltd|llc|co|se|bv)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Tracking parameters left out of the link key, matched by exact name in any case. */
const TRACKING_PARAMS = new Set(["ref", "refid", "referrer", "source", "gh_src", "trk", "trackingid"]);

function isTrackingParam(name: string) {
  const key = name.toLowerCase();
  // utm_* is a namespace, so it is the only prefix match: "referenceId" or "sourceId" can name the posting.
  return key.startsWith("utm_") || TRACKING_PARAMS.has(key);
}

/** A query name or value decoded as a form field ("+" is a space); null when its %-escapes are not valid UTF-8. */
function decodeQueryPart(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return null; // "%E4" (Latin-1 "ä"), "%zz", a lone "%"
  }
}

/**
 * The query part of the link key (no "?"). Each name=value pair whose name and value both decode
 * as UTF-8 is re-serialised as URLSearchParams would ("a%20b" and "a+b" → "a+b"). Any other pair
 * keeps its text: URLSearchParams would turn every invalid byte into U+FFFD, so "?id=%E4" and
 * "?id=%FC" would share a key. Tracking parameters are dropped and the pairs are sorted by
 * name, using the decoded name where there is one; the sort is stable, so a repeated name keeps
 * its order. Empty pairs ("a=1&&b=2") are dropped.
 */
function queryKey(search: string) {
  const pairs: { name: string; text: string }[] = [];
  for (const text of search.replace(/^\?/, "").split("&")) {
    if (!text) continue;
    const eq = text.indexOf("=");
    const rawName = eq === -1 ? text : text.slice(0, eq);
    const name = decodeQueryPart(rawName);
    const value = decodeQueryPart(eq === -1 ? "" : text.slice(eq + 1));
    if (isTrackingParam(name ?? rawName)) continue;
    pairs.push({
      name: name ?? rawName,
      text: name !== null && value !== null ? new URLSearchParams([[name, value]]).toString() : text,
    });
  }
  pairs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return pairs.map((p) => p.text).join("&");
}

/**
 * URL key, which decides "the same job" (unique per user, see jobKeys): the host lowercased and
 * without "www.", the path without a trailing slash, then the query without tracking parameters
 * (utm_*, ref, refId, referrer, source, gh_src, trk, trackingId), sorted by name and
 * re-serialised so equivalent links ("?q=a%20b" and "?q=a+b", "?b=2&a=1" and "?a=1&b=2") give
 * one key; no "?" when nothing is left. A pair that is not valid UTF-8 ("?id=%E4") keeps its
 * text (see queryKey). Then the fragment, kept only when it is a client-side route ("#/job/1",
 * "#!/job/1"): single-page career sites put the posting there. Any other fragment ("#apply",
 * "#top"), the scheme and the port are dropped. Path, query and route keep their case: job ids
 * can be case-sensitive. A string that is not a URL is trimmed and lowercased.
 */
export function normalizeUrl(u: string) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const query = queryKey(url.search);
    const route = /^#!?\//.test(url.hash) ? url.hash : "";
    return `${host}${url.pathname.replace(/\/$/, "")}${query ? `?${query}` : ""}${route}`;
  } catch {
    return u.trim().toLowerCase();
  }
}

/**
 * Longest link key stored, in UTF-8 bytes. jobs_user_id_url_norm_key refuses an index row over
 * 2704 bytes (the save would fail), so a longer key is not stored and that link is not deduped.
 */
export const MAX_URL_KEY_BYTES = 2048;

const utf8 = new TextEncoder();

function urlKey(url: string | null) {
  // A link that normalizes to "" (e.g. "file:///") has no key: the column rejects ''.
  const key = url ? normalizeUrl(url) : "";
  if (!key || utf8.encode(key).length > MAX_URL_KEY_BYTES) return null;
  return key;
}

export interface JobKeys {
  urlNorm: string | null;
  companySlug: string;
  titleNorm: string;
  searchText: string;
}

/** The derived key columns stored with every job (url_norm, company_slug, title_norm, search_text). */
export function jobKeys(job: { url: string | null; company: string; title: string }): JobKeys {
  return {
    urlNorm: urlKey(job.url),
    companySlug: slug(job.company),
    titleNorm: normalize(job.title),
    searchText: normalize(`${job.company} ${job.title}`),
  };
}
