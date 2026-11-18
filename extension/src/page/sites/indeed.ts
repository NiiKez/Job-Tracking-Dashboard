import { lineText } from "../text";
import { blockOf, first, found, lineOf, onBrand, type SiteReader } from "./common";

/**
 * Indeed, in every country (indeed.com, de.indeed.com, uk.indeed.com, indeed.co.uk …): a
 * posting's own page (/viewjob?jk=<id>) and a search page with a posting open in the right
 * pane (?vjk=<id>). The link is always the clean /viewjob?jk=<id> on the same host, without
 * the search around it and the tracking parameters.
 *
 * Indeed's markup has data-testid hooks (jobsearch-JobInfoHeader-title, inlineHeader-
 * companyName, inlineHeader-companyLocation) and the long-lived #jobDescriptionText; older
 * pages had jobsearch-… classes, kept as fallbacks. The job cards of a search page use other
 * hooks (company-name, text-location), and the lookups stay inside the right pane when there
 * is one.
 */

const PANE = ["#jobsearch-ViewjobPaneWrapper", ".jobsearch-RightPane", "#vjs-container"];

const TITLE = [
  '[data-testid="jobsearch-JobInfoHeader-title"]',
  ".jobsearch-JobInfoHeader-title",
];

const COMPANY = [
  '[data-testid="inlineHeader-companyName"]',
  '[data-company-name="true"]',
  ".jobsearch-InlineCompanyRating > div:first-child",
];

const LOCATION = [
  '[data-testid="inlineHeader-companyLocation"]',
  '[data-testid="jobsearch-JobInfoHeader-companyLocation"]',
  '[data-testid="job-location"]',
  ".jobsearch-JobInfoHeader-subtitle > div:last-child",
];

const DESCRIPTION = ["#jobDescriptionText", ".jobsearch-jobDescriptionText"];

export const indeed: SiteReader = {
  name: "indeed",
  matches: (url) => onBrand(url, "indeed") && jobKey(url) !== null,
  read(doc, url) {
    const key = jobKey(url);
    const pane = first(doc, PANE) ?? doc;
    return found({
      url: key ? `${url.origin}/viewjob?jk=${key}` : undefined,
      title: title(first(pane, TITLE)),
      company: lineOf(pane, COMPANY),
      location: lineOf(pane, LOCATION),
      description: blockOf(pane, DESCRIPTION),
    });
  },
};

/** The posting's key: `jk` on a /viewjob page, `vjk` on a search page. */
function jobKey(url: URL): string | null {
  const viewjob = /(?:^|\/)viewjob\/?$/.test(url.pathname);
  const key = (viewjob && url.searchParams.get("jk")) || url.searchParams.get("vjk");
  return key && /^[a-z0-9]{8,32}$/i.test(key) ? key : null;
}

/**
 * The heading ends in a span for screen readers, "- job post" (in the page's language). It is
 * dropped when the heading's last span starts with a dash.
 */
function title(heading: Element | null): string | undefined {
  const text = lineText(heading);
  if (!heading || !text) return undefined;
  const spans = heading.querySelectorAll("span");
  const suffix = spans.length > 1 ? lineText(spans[spans.length - 1]) : "";
  if (/^[-–]\s*\S/.test(suffix) && text.endsWith(suffix) && text.length > suffix.length) {
    return text.slice(0, -suffix.length).trim();
  }
  return text;
}
