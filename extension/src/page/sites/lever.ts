import { collapse } from "../text";
import { found, joinBlocks, lineOf, onHost, type SiteReader } from "./common";

/**
 * Lever job pages: jobs.lever.co/<company>/<id> (and jobs.eu.lever.co). The header holds the
 * title (.posting-headline h2) and category chips (.location, .department, .commitment); the
 * text is a run of .section.page-centered blocks after it: the description, one block per
 * list ("What you'll do", …), the closing words, and a last block with the Apply button,
 * which is left out. The company is only in the page title, "<company> - <title>".
 */

const TITLE = [".posting-headline h2", ".posting-header h2"];

const LOCATION = [".posting-categories .location", ".posting-category.location"];

const SECTIONS = ".section-wrapper .section.page-centered";
const NOT_TEXT = ".posting-header, .last-section-apply, [data-qa='btn-apply-bottom']";

export const lever: SiteReader = {
  name: "lever",
  matches: (url) => onHost(url, "jobs.lever.co", "jobs.eu.lever.co"),
  read(doc) {
    const title = lineOf(doc, TITLE);
    const sections = [...doc.querySelectorAll(SECTIONS)].filter((el) => !el.matches(NOT_TEXT));
    return found({
      title,
      company: fromPageTitle(doc, title),
      location: lineOf(doc, LOCATION)?.replace(/\s*[/–-]$/, ""),
      description: joinBlocks(sections),
    });
  },
};

/** "Acme - Senior Engineer" -> "Acme", when "Senior Engineer" is `title`. */
function fromPageTitle(doc: Document, title: string | undefined): string | undefined {
  const suffix = ` - ${title}`;
  const page = collapse(doc.title);
  if (!title || !page.endsWith(suffix)) return undefined;
  return page.slice(0, -suffix.length).trim() || undefined;
}
