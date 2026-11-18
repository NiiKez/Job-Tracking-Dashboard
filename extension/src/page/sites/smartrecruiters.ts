import { collapse } from "../text";
import { blockOf, found, lineOf, onHost, type SiteReader } from "./common";

/**
 * SmartRecruiters job pages: jobs.smartrecruiters.com/<Company>/<id>-<title>. The page is
 * marked up with schema.org microdata (itemprop title, hiringOrganization, jobLocation,
 * description), which is the most stable hook it has. The place is also in the
 * `formattedaddress` attribute of its <spl-job-location> element; the description is the
 * sections #st-companyDescription, #st-jobDescription, #st-qualifications and
 * #st-additionalInformation, each with its heading.
 */

const TITLE = ['[itemprop="title"]', "h1.job-title"];

const COMPANY = [
  '[itemprop="hiringOrganization"] [itemprop="name"]',
  'meta[itemprop="hiringOrganization"]',
];

const LOCATION = ['[itemprop="jobLocation"]', ".job-detail-location", ".job-location"];

// The posting's own description: hiringOrganization can carry an itemprop="description" too.
const DESCRIPTION = [
  '.job-sections[itemprop="description"]',
  ".job-sections",
  '[itemprop="description"]',
];

export const smartrecruiters: SiteReader = {
  name: "smartrecruiters",
  matches: (url) => onHost(url, "jobs.smartrecruiters.com"),
  read(doc) {
    return found({
      title: lineOf(doc, TITLE),
      company: lineOf(doc, COMPANY),
      location: splLocation(doc) ?? lineOf(doc, LOCATION),
      description: blockOf(doc, DESCRIPTION),
    });
  },
};

/** <spl-job-location formattedaddress="Berlin, Germany">: a web component with no text inside. */
function splLocation(doc: Document): string | undefined {
  const element = doc.querySelector("spl-job-location[formattedaddress]");
  return collapse(element?.getAttribute("formattedaddress") ?? "") || undefined;
}
