import { blockOf, first, firstPart, found, lineOf, onHost, type SiteReader } from "./common";

/**
 * LinkedIn: a posting's own page (/jobs/view/<id>/, also with a slug before the id, and
 * /comm/jobs/view/<id>/, where the links in LinkedIn's job-alert emails open) and every page that
 * shows one next to a list (/jobs/search/, /jobs/collections/…) with `?currentJobId=<id>`. The
 * link is always the clean /jobs/view/<id>/ address, without the tracking parameters and
 * email tokens LinkedIn adds and without the list around it.
 *
 * Signed in, LinkedIn shows the "unified top card" (job-details-jobs-unified-top-card__…,
 * before 2023 jobs-unified-top-card__…) and the description in #job-details. Signed out, the
 * guest page has top-card-layout / topcard__… and .show-more-less-html__markup (it also carries
 * JSON-LD, which the server reads first). On a list page the job cards hold other jobs' titles
 * and companies, so the lookups stay inside the detail pane when there is one.
 */

const DETAIL_PANE = [
  ".jobs-search__job-details--wrapper",
  ".jobs-search__job-details--container",
  ".jobs-search__job-details",
  ".scaffold-layout__detail",
  ".jobs-details",
];

const TITLE = [
  ".job-details-jobs-unified-top-card__job-title h1",
  ".job-details-jobs-unified-top-card__job-title",
  ".jobs-unified-top-card__job-title",
  ".top-card-layout__title",
  ".topcard__title",
];

const COMPANY = [
  ".job-details-jobs-unified-top-card__company-name a",
  ".job-details-jobs-unified-top-card__company-name",
  ".jobs-unified-top-card__company-name a",
  ".jobs-unified-top-card__company-name",
  ".topcard__org-name-link",
  ".top-card-layout__second-subline .topcard__flavor:not(.topcard__flavor--bullet)",
];

// "Berlin, Germany · Reposted 2 weeks ago · Over 100 applicants": the place is the first part.
const LOCATION = [
  ".job-details-jobs-unified-top-card__primary-description-container",
  ".job-details-jobs-unified-top-card__tertiary-description-container",
  ".job-details-jobs-unified-top-card__bullet",
  ".jobs-unified-top-card__bullet",
  ".topcard__flavor--bullet",
];

const DESCRIPTION = [
  "#job-details",
  ".jobs-description-content__text",
  ".jobs-box__html-content",
  ".show-more-less-html__markup",
  ".description__text",
];

export const linkedin: SiteReader = {
  name: "linkedin",
  matches: (url) => onHost(url, "linkedin.com") && jobId(url) !== null,
  read(doc, url) {
    const id = jobId(url);
    const pane = first(doc, DETAIL_PANE) ?? doc;
    return found({
      url: id ? `https://www.linkedin.com/jobs/view/${id}/` : undefined,
      title: lineOf(pane, TITLE),
      company: lineOf(pane, COMPANY),
      location: firstPart(lineOf(pane, LOCATION)),
      // #job-details opens with an "About the job" heading of LinkedIn's own.
      description: blockOf(pane, DESCRIPTION, { skip: "#job-details > h2:first-child" }),
    });
  },
};

/**
 * The posting's id: from /jobs/view/<id> or /jobs/view/<slug>-<id> (either with /comm before
 * it), else from currentJobId.
 */
function jobId(url: URL): string | null {
  const path = url.pathname.match(/^(?:\/comm)?\/jobs\/view\/(?:[^/]*-)?(\d{5,20})\/?$/);
  if (path) return path[1];
  const current = url.searchParams.get("currentJobId");
  return current && /^\d{5,20}$/.test(current) ? current : null;
}
