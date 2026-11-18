import { arbeitsagentur } from "./arbeitsagentur";
import type { SiteReader } from "./common";
import { generic } from "./generic";
import { glassdoor } from "./glassdoor";
import { greenhouse } from "./greenhouse";
import { indeed } from "./indeed";
import { join } from "./join";
import { lever } from "./lever";
import { linkedin } from "./linkedin";
import { personio } from "./personio";
import { smartrecruiters } from "./smartrecruiters";
import { stepstone } from "./stepstone";
import { workday } from "./workday";
import { xing } from "./xing";

/**
 * The site readers, one per job board or applicant tracking system, and `generic` for every
 * other page. readPage() runs the first reader whose matches() accepts the tab's address, and
 * `generic` only when none does.
 *
 * A word on how sure these are: the selectors are written from the sites' markup as known in
 * November 2026 and checked against the fixtures in tests/extension/page/fixtures, which copy
 * each site's structure with invented content. They were not run against the live sites, and
 * sites change their markup without notice. That is why each reader tries the hooks least
 * likely to change first (ids, data-testid, data-automation-id, data-at, itemprop), keeps the
 * selectors of earlier layouts as fallbacks, fills only what it found, and never throws for a
 * missing element: when a site has moved on, the server still has the page's JSON-LD,
 * OpenGraph tags and title. The XING, JOIN and Personio readers rest on the least certain
 * markup. A field that comes out wrong on a live page means its fixture needs updating along
 * with the selector.
 */

export type { SiteReader } from "./common";
export { generic } from "./generic";

export const SITE_READERS: readonly SiteReader[] = [
  linkedin,
  stepstone,
  indeed,
  xing,
  glassdoor,
  arbeitsagentur,
  personio,
  greenhouse,
  lever,
  workday,
  smartrecruiters,
  join,
];

/** The reader for the page at `url`: the first site reader that matches, else `generic`. */
export function readerFor(url: URL): SiteReader {
  return SITE_READERS.find((reader) => reader.matches(url)) ?? generic;
}
