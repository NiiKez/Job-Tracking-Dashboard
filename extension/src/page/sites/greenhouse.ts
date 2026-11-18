import { collapse } from "../text";
import { blockOf, found, lineOf, onHost, type SiteReader } from "./common";

/**
 * Greenhouse job boards: boards.greenhouse.io (the classic layout: #header with .app-title,
 * .company-name "at Acme" and .location, the text in #content) and job-boards.greenhouse.io
 * (since 2024: .job__title h1, .job__location, .job__description), with their .eu variants
 * and the /embed/job_app pages. The new layout shows the company only in the page title,
 * "Job Application for <title> at <company>", read only when the title part is the posting's.
 *
 * A company page that embeds its Greenhouse board (?gh_jid=…) shows the posting in a frame
 * from another origin, which this script cannot read: such a page falls to the generic parts.
 */

const TITLE = [".job__title h1", "#header .app-title", ".app-title", "h1.section-header"];

const COMPANY = ["#header .company-name", ".company-name"];

const LOCATION = [".job__location", "#header .location", ".location"];

const DESCRIPTION = [".job__description", "#content"];

export const greenhouse: SiteReader = {
  name: "greenhouse",
  matches: (url) =>
    onHost(
      url,
      "boards.greenhouse.io",
      "job-boards.greenhouse.io",
      "boards.eu.greenhouse.io",
      "job-boards.eu.greenhouse.io",
    ),
  read(doc) {
    const title = lineOf(doc, TITLE);
    return found({
      title,
      company: atCompany(lineOf(doc, COMPANY)) ?? fromPageTitle(doc, title),
      location: lineOf(doc, LOCATION),
      description: blockOf(doc, DESCRIPTION),
    });
  },
};

/** "at Acme" -> "Acme". */
function atCompany(text: string | undefined): string | undefined {
  return text?.replace(/^at\s+/i, "").trim() || undefined;
}

/** "Job Application for Senior Engineer at Acme" -> "Acme", when "Senior Engineer" is `title`. */
function fromPageTitle(doc: Document, title: string | undefined): string | undefined {
  const prefix = `Job Application for ${title} at `;
  const page = collapse(doc.title);
  if (!title || !page.startsWith(prefix)) return undefined;
  return page.slice(prefix.length).trim() || undefined;
}
