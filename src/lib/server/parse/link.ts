import "server-only";
import { extractJobPage } from "./extract";
import { createRateLimiter, type RateLimiter } from "./rate-limit";
import { safeFetch, type SafeFetchOptions } from "./safe-fetch";
import { isSingleLink, parseText, parseUrl, toResult, type ParsedJobInput } from "./text";

/**
 * The parse step of "Add job". Pasted text uses the heuristics only. A single link is
 * fetched and read; whatever the page does not give is filled from the link heuristics, and
 * any failure falls back to exactly what the heuristics give for that link.
 */

export type { ParsedJobInput };

export interface ParseOptions {
  /** Whose fetch budget this counts against: the signed-in user's id. Without one, a shared budget. */
  rateLimitKey?: string;
}

/** Test seams. Set only by code (tests); the default instance below uses none of them. */
export interface ParserDeps {
  fetch?: SafeFetchOptions;
  limiter?: RateLimiter;
  /** One short line per skipped fetch: host and reason, never page content. */
  log?: (line: string) => void;
}

const SHARED_KEY = "(no key)";

export function createJobInputParser(deps: ParserDeps = {}) {
  const limiter = deps.limiter ?? createRateLimiter();
  const log = deps.log ?? ((line: string) => console.warn(line));

  return async function parseJobInput(
    input: string,
    opts: ParseOptions = {},
  ): Promise<ParsedJobInput> {
    const trimmed = input.trim();
    if (!isSingleLink(trimmed)) return toResult(parseText(trimmed));

    const fromLink = parseUrl(trimmed);
    const fallback = (host: string, reason: string) => {
      log(`[parse] link not read: ${host || "-"} ${reason}`);
      return toResult(fromLink);
    };

    try {
      // Every request counts, redirects included: each one can go to another host.
      const key = opts.rateLimitKey ?? SHARED_KEY;
      const page = await safeFetch(trimmed, { ...deps.fetch, take: () => limiter.take(key) });
      if (!page.ok) return fallback(page.host, page.reason);
      // A closed posting often redirects to the board's index (/acme/jobs/4711 -> /acme), whose
      // title and description are not this job's.
      if (isParentPage(trimmed, page.url)) return fallback(hostOf(page.url), "redirected-to-parent");

      const found = extractJobPage(page.html, { company: fromLink.company });
      // The page wins; the heuristics fill blanks. `url` stays the link the user gave.
      return toResult({
        url: fromLink.url,
        title: found.title || fromLink.title,
        company: found.company || fromLink.company,
        location: found.location || fromLink.location,
        description: found.description || fromLink.description,
      });
    } catch {
      // Not expected (safeFetch does not throw); the message is not logged as it could quote the page.
      return fallback(hostOf(trimmed), "error");
    }
  };
}

/** True when `final` is on the same host as `link` and its path is a parent of the link's path. */
function isParentPage(link: string, final: string) {
  try {
    const from = new URL(link);
    const to = new URL(final);
    if (from.hostname !== to.hostname) return false;
    const fromPath = from.pathname.replace(/\/+$/, "");
    const toPath = to.pathname.replace(/\/+$/, "");
    return fromPath !== toPath && (toPath === "" || fromPath.startsWith(`${toPath}/`));
  } catch {
    return false;
  }
}

function hostOf(link: string) {
  try {
    return new URL(link).hostname;
  } catch {
    return "(invalid)";
  }
}

/** The production parser: the guarded agent, the real block list and the default rate limit. */
export const parseJobInput = createJobInputParser();
