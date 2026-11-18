import { blockOf, found, joinBlocks, lineOf, onBrand, type SiteReader } from "./common";

/**
 * StepStone, in every country it runs in (stepstone.de, .at, .be, .nl, …). Its job ads carry
 * `data-at` test hooks: header-job-title, metadata-company-name, metadata-location, and one
 * pair per text section (section-text-<name>-title / -content: introduction, description,
 * profile, weOffer, …). The description is those sections in page order, each with its
 * heading. Older ads used listing-… classes, kept as a fallback. The "similar jobs" cards have
 * hooks of their own (job-item-…), so they are never read by mistake.
 */

const TITLE = [
  '[data-at="header-job-title"]',
  ".listing__job-title",
  ".at-listing-nav-listing-title",
];

const COMPANY = [
  '[data-at="metadata-company-name"]',
  ".listing__company-name",
  ".at-listing__list-icons_company-name",
];

const LOCATION = ['[data-at="metadata-location"]', ".at-listing__list-icons_location"];

const SECTION_PARTS = [
  '[data-at^="section-text-"][data-at$="-title"]',
  '[data-at^="section-text-"][data-at$="-content"]',
].join(", ");

const OLD_DESCRIPTION = [".listing-content", ".js-app-ld-ContentBlock"];

export const stepstone: SiteReader = {
  name: "stepstone",
  matches: (url) => onBrand(url, "stepstone"),
  read(doc) {
    return found({
      title: lineOf(doc, TITLE),
      company: lineOf(doc, COMPANY),
      location: lineOf(doc, LOCATION),
      description: sections(doc) ?? blockOf(doc, OLD_DESCRIPTION),
    });
  },
};

/** The text sections with their headings: "Your tasks\n\n• …\n\nYour profile\n\n• …". */
function sections(doc: Document): string | undefined {
  // A section's title can sit inside its content element; reading the outer one is enough then.
  const parts = [...doc.querySelectorAll(SECTION_PARTS)].filter(
    (el) => !el.parentElement?.closest(SECTION_PARTS),
  );
  return joinBlocks(parts);
}
