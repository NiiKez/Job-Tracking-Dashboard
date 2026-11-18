import { blockOf, found, lineOf, onHost, type SiteReader } from "./common";

/**
 * Bundesagentur für Arbeit, Jobsuche: a posting's page, /jobsuche/jobdetail/<reference>. The
 * Angular app gives its parts German ids: detail-kopfbereich-titel / -firma for the header,
 * detail-arbeitsorte-… for the places and detail-beschreibung-… for the text. The ids of the
 * older version (jobdetails-titel, -arbeitgeber, -arbeitsort, -beschreibung) are kept as
 * fallbacks. The description is the employer's plain text, shown with its own line breaks
 * (CSS white-space), so those are kept. An ad that only links to the employer's site has no
 * description here.
 */

const TITLE = ["#detail-kopfbereich-titel", "#jobdetails-titel"];

const COMPANY = [
  "#detail-kopfbereich-firma",
  "#detail-arbeitgeber-name",
  "#jobdetails-arbeitgeber",
];

const LOCATION = [
  "#detail-kopfbereich-arbeitsort",
  '[id^="detail-arbeitsorte-arbeitsort"]',
  "#jobdetails-arbeitsort",
];

const DESCRIPTION = [
  "#detail-beschreibung-beschreibung",
  "#detail-beschreibung-text-container",
  "#jobdetails-beschreibung",
];

export const arbeitsagentur: SiteReader = {
  name: "arbeitsagentur",
  matches: (url) =>
    onHost(url, "arbeitsagentur.de") && url.pathname.startsWith("/jobsuche/jobdetail/"),
  read(doc) {
    return found({
      title: lineOf(doc, TITLE),
      company: lineOf(doc, COMPANY),
      location: lineOf(doc, LOCATION),
      description: blockOf(doc, DESCRIPTION, { keepLines: true }),
    });
  },
};
