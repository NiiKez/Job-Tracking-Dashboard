import { blockText } from "../text";
import { MAX_DESCRIPTION, type SiteReader } from "./common";

/**
 * Any page no site reader is for, such as a company's own career site: the text of its main
 * content as the description, nothing else. The main content is `<main>`, `[role=main]`, or
 * the page's one `<article>` (with several, none of them is the posting for sure), the first of
 * these whose text is a plausible posting: 200 to 100,000 characters. Shorter is a shell still
 * loading or a menu; longer is a whole site in one element. Title, company and place come from
 * the generic parts the server reads (JSON-LD, OpenGraph, the title).
 */

export const MIN_GENERIC = 200;

export const generic: SiteReader = {
  name: "generic",
  matches: () => true,
  read(doc) {
    for (const el of mainCandidates(doc)) {
      const text = blockText(el, { max: MAX_DESCRIPTION });
      const plausible = text.length >= MIN_GENERIC && text.length <= MAX_DESCRIPTION;
      if (plausible) return { description: text };
    }
    return null;
  },
};

/**
 * The elements that may hold the main content, in the order they are tried, each once:
 * `<main role="main">` is both of the first two.
 */
export function mainCandidates(doc: Document): Element[] {
  const articles = doc.querySelectorAll("article");
  const found = [
    doc.querySelector("main:not([hidden])"),
    doc.querySelector('[role="main"]:not([hidden])'),
    articles.length === 1 ? articles[0] : null,
  ].filter((el): el is Element => el !== null);
  return [...new Set(found)];
}
