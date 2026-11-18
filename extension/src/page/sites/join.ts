import { blockOf, first, found, lineOf, onHost, type SiteReader } from "./common";

/**
 * JOIN job pages: join.com/companies/<company>/<id>-<title>. The page is built from hashed
 * styled-components classes; only its data-testid hooks and the one `h1` are used. Like XING,
 * this reader rests on less certain markup than the others; JOIN's JSON-LD JobPosting, which
 * the server reads first, covers what it misses.
 */

const MAIN = ["main", '[role="main"]'];

const TITLE = ['[data-testid="JobTitle"]', '[data-testid="job-title"]', "h1"];

const COMPANY = ['[data-testid="CompanyName"]', '[data-testid="company-name"]'];

const LOCATION = ['[data-testid="JobLocation"]', '[data-testid="job-location"]'];

const DESCRIPTION = [
  '[data-testid="JobDescription"]',
  '[data-testid="job-description"]',
  '[data-testid="Description"]',
];

export const join: SiteReader = {
  name: "join",
  matches: (url) =>
    onHost(url, "join.com") && /^\/companies\/[^/]+\/\d+(?:-[^/]*)?\/?$/.test(url.pathname),
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
