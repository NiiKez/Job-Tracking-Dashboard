import { blockOf, first, found, lineOf, onHost, type SiteReader } from "./common";

/**
 * XING job ads: /jobs/<city>-<title>-<id>. The page is built from hashed styled-components
 * classes, so only data-testid hooks and the heading are used. Of all readers this one rests on
 * the least certain markup; the server reads XING's JSON-LD JobPosting first anyway, and a
 * hook that is not there leaves its field to it.
 */

const MAIN = ['[data-testid="job-details"]', "main", '[role="main"]'];

const TITLE = ['[data-testid="job-details-title"]', '[data-testid="job-title"]', "h1"];

const COMPANY = [
  '[data-testid="job-details-company-info-name"]',
  '[data-testid="job-details-company-name"]',
  '[data-testid="company-name"]',
];

const LOCATION = [
  '[data-testid="job-details-location"]',
  '[data-testid="job-fact-location"]',
  '[data-testid="job-location"]',
];

const DESCRIPTION = [
  '[data-testid="job-description-content"]',
  '[data-testid="expandable-content"]',
  '[data-testid="job-description"]',
];

export const xing: SiteReader = {
  name: "xing",
  matches: (url) => onHost(url, "xing.com") && /^\/jobs\/[^/]+-\d+\/?$/.test(url.pathname),
  read(doc) {
    const main = first(doc, MAIN) ?? doc;
    return found({
      title: lineOf(main, TITLE),
      company: lineOf(main, COMPANY),
      location: lineOf(main, LOCATION),
      description: blockOf(main, DESCRIPTION),
    });
  },
};
