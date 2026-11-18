import { blockOf, first, found, lineOf, onBrand, type SiteReader } from "./common";

/**
 * Glassdoor, in every country (glassdoor.com, .de, .co.uk, .com.au …): a posting's page
 * (/job-listing/…) and a search page with a posting open next to the list. Since 2023 the
 * markup is CSS-module classes (JobDetails_jobDescription__<hash>), matched by their stable
 * prefix, plus `data-test` hooks and the title's id (jd-job-title-<id>); the older
 * data-test="jobTitle" / "employerName" and #JobDescriptionContainer are kept as fallbacks.
 * The list's job cards also use data-test="job-title", so the lookups stay inside the detail
 * column when there is one.
 *
 * The link is the page's address with only its `jl` parameter, the posting's id: a search page
 * keeps the same path for every posting opened from it, and only `jl` tells them apart. Without
 * a `jl` of digits there is no link, and the server takes the canonical link or the tab's address.
 */

const DETAILS = [
  '[class*="JobDetails_jobDetailsContainer__"]',
  '[class*="TwoColumnLayout_jobDetailsContainer__"]',
  '[data-test="job-details"]',
  "#JDCol",
];

const TITLE = [
  '[id^="jd-job-title-"]',
  'h1[data-test="job-title"]',
  '[data-test="jobTitle"]',
];

const COMPANY = [
  '[data-test="employer-name"]',
  '[class*="EmployerProfile_employerName__"]',
  '[class*="EmployerProfile_profileContainer__"] h4',
  '[data-test="employerName"]',
];

const LOCATION = ['[data-test="location"]', '[data-test="emp-location"]'];

const DESCRIPTION = [
  '[class*="JobDetails_jobDescription__"]',
  "#JobDescriptionContainer",
  '[data-test="jobDescriptionContent"]',
  ".jobDescriptionContent",
];

export const glassdoor: SiteReader = {
  name: "glassdoor",
  matches: (url) => onBrand(url, "glassdoor"),
  read(doc, url) {
    const id = listingId(url);
    const details = first(doc, DETAILS) ?? doc;
    return found({
      url: id ? `${url.origin}${url.pathname}?jl=${id}` : undefined,
      title: lineOf(details, TITLE),
      company: withoutRating(lineOf(details, COMPANY)),
      location: lineOf(details, LOCATION),
      description: blockOf(details, DESCRIPTION),
    });
  },
};

/** The posting's id: the `jl` parameter, when it is all digits. */
function listingId(url: URL): string | null {
  const jl = url.searchParams.get("jl");
  return jl && /^\d+$/.test(jl) ? jl : null;
}

/**
 * "Acme GmbH 4.1 ★" -> "Acme GmbH": older pages put the employer's rating inside its name
 * element. Ratings always have one decimal, so "Studio 3" keeps its 3.
 */
function withoutRating(name: string | undefined): string | undefined {
  return name?.replace(/\s*\d[.,]\d\s*★?$/, "").trim() || undefined;
}
