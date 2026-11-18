import { blockOf, first, found, lineOf, onHost, type SiteReader } from "./common";

/**
 * Personio career pages: <company>.jobs.personio.de or .com, a posting at /job/<id>. The page
 * names the job in its one `h1`, the place and contract next to it, and the text in sections
 * below; data-test-id hooks are tried before the classes of the older layout. The company is
 * left to JSON-LD and the page title: the subdomain is a slug, not the name.
 */

const MAIN = ['[data-test-id="job-details"]', "#job-details", ".job-details", "main"];

const TITLE = ['[data-test-id="job-title"]', ".detail-header h1", "h1"];

const LOCATION = ['[data-test-id="job-location"]', ".job-location", ".detail-header .location"];

const DESCRIPTION = [
  '[data-test-id="job-description"]',
  "#job-descriptions",
  ".job-descriptions",
  ".job-description",
];

export const personio: SiteReader = {
  name: "personio",
  matches: (url) =>
    onHost(url, "jobs.personio.de", "jobs.personio.com") && /^\/job\/\d+\/?$/.test(url.pathname),
  read(doc) {
    const main = first(doc, MAIN) ?? doc;
    return found({
      title: lineOf(main, TITLE),
      location: lineOf(main, LOCATION),
      description: blockOf(main, DESCRIPTION),
    });
  },
};
