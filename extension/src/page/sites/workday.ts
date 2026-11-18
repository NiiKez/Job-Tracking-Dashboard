import { lineText } from "../text";
import { blockOf, found, lineOf, onHost, type SiteReader } from "./common";

/**
 * Workday career sites: <company>.wd<n>.myworkdayjobs.com (and myworkdaysite.com), a posting
 * at …/job/<place>/<title>_<id> or open in the side panel of a search at …/details/…. Workday
 * marks its parts with data-automation-id, which has stayed the same for years:
 * jobPostingHeader, locations (a dl: "locations" / the place), jobPostingDescription. The
 * company is not on the page as text; JSON-LD names it.
 */

const TITLE = ['[data-automation-id="jobPostingHeader"]'];

// The <dt> says "locations"; the <dd> next to it is the place (one or several).
const LOCATION = ['[data-automation-id="locations"] dd', '[data-automation-id="location"] dd'];

const DESCRIPTION = ['[data-automation-id="jobPostingDescription"]'];

export const workday: SiteReader = {
  name: "workday",
  matches: (url) => onHost(url, "myworkdayjobs.com", "myworkdaysite.com"),
  read(doc) {
    return found({
      title: lineOf(doc, TITLE),
      location: places(doc) ?? lineOf(doc, LOCATION),
      description: blockOf(doc, DESCRIPTION),
    });
  },
};

/** Several places, each in its own <dd>: "Berlin, Germany; Hamburg, Germany". */
function places(doc: Document): string | undefined {
  const all = [...doc.querySelectorAll(LOCATION[0])].map(lineText).filter(Boolean);
  return all.length > 1 ? all.join("; ") : undefined;
}
