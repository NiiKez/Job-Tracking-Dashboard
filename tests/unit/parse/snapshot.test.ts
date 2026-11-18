import { describe, expect, it } from "vitest";
import { jobKeys } from "@/lib/domain/normalize";
import { MAX_DESCRIPTION, MAX_FIELD } from "@/lib/server/parse/limits";
import { MIN_SELECTION, readSnapshot } from "@/lib/server/parse/snapshot";
import { extensionReadSchema, pageSnapshotSchema } from "@/lib/server/schemas";
import type { PageSnapshot, SiteFields } from "@/lib/types";

// POST /api/extension/read's merge (docs/plan/4-chrome-extension.md, "How the fields are
// chosen"): per field the first source with a value wins. Invented companies and example.com
// links only.

const TAB = "https://careers.example.com/jobs/4711-backend-engineer";

/** A snapshot as the extension sends it, through the route's schema (defaults filled). */
function snapshot(page: Partial<PageSnapshot> & { url?: string } = {}): PageSnapshot {
  return pageSnapshotSchema.parse({ url: TAB, ...page });
}

const read = (page: Partial<PageSnapshot> = {}) => readSnapshot(snapshot(page));

function posting(fields: Record<string, unknown> = {}) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Senior Backend Engineer",
    hiringOrganization: { "@type": "Organization", name: "Quillfeather Systems GmbH" },
    jobLocation: { "@type": "Place", address: { addressLocality: "Berlin", addressCountry: "DE" } },
    description: "<p>Route planning for bike couriers.</p>",
    ...fields,
  });
}

const reader = (fields: SiteFields) => ({ reader: "invented-board", fields });

const OG = {
  "og:title": "Data Analyst | Fernwood Labs",
  "og:site_name": "Fernwood Labs",
  "og:description": "Fernwood Labs is hiring a data analyst.",
};

const long = (word: string, length = MIN_SELECTION) => `${word} `.repeat(Math.ceil(length / (word.length + 1))).slice(0, length);

describe("readSnapshot: title, company and location", () => {
  it("takes JSON-LD first, over the site reader and OpenGraph", () => {
    const result = read({
      jsonLd: [posting()],
      site: reader({ title: "Reader Title", company: "Reader Company", location: "Hamburg" }),
      meta: OG,
      title: "Page title | Fernwood Labs",
    });
    expect(result).toMatchObject({
      title: "Senior Backend Engineer",
      company: "Quillfeather Systems GmbH",
      location: "Berlin, DE",
    });
  });

  it("takes the site reader where JSON-LD has nothing, field by field", () => {
    const result = read({
      jsonLd: [posting({ jobLocation: undefined, hiringOrganization: undefined })],
      site: reader({ title: "Reader Title", company: "Reader Company", location: "Hamburg" }),
      meta: OG,
    });
    expect(result).toMatchObject({ title: "Senior Backend Engineer", company: "Reader Company", location: "Hamburg" });
  });

  // On a search page with a posting open (LinkedIn's currentJobId, Indeed's vjk), the reader's
  // link names the open posting, while the page's JSON-LD may be another one, e.g. in a list.
  it("takes the site reader first when its link names another page than the tab", () => {
    const list = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: [{ "@type": "ListItem", position: 1, item: JSON.parse(posting()) }],
    });
    const page = {
      url: "https://www.linkedin.com/jobs/search/?currentJobId=4711&keywords=engineer",
      jsonLd: [list],
      meta: OG,
      title: "Page title | Fernwood Labs",
    };
    const site = reader({
      url: "https://www.linkedin.com/jobs/view/4711/",
      title: "Reader Title",
      company: "Reader Company",
      location: "Hamburg",
      description: "From the reader.",
    });
    expect(read({ ...page, site })).toMatchObject({
      url: "https://www.linkedin.com/jobs/view/4711/",
      title: "Reader Title",
      company: "Reader Company",
      location: "Hamburg",
      description: "From the reader.",
    });
    // Field by field: JSON-LD, then OpenGraph, fill in what the reader did not find.
    const titleOnly = reader({ url: "https://www.linkedin.com/jobs/view/4711/", title: "Reader Title" });
    expect(read({ ...page, site: titleOnly })).toMatchObject({
      title: "Reader Title",
      company: "Quillfeather Systems GmbH",
      location: "Berlin, DE",
      description: "Route planning for bike couriers.",
    });
    // A selection still comes first.
    const selection = long("Selected");
    expect(read({ ...page, site, selection }).description).toBe(selection);
  });

  it("keeps JSON-LD first when the reader's link is the tab's page, or not http(s)", () => {
    const fields = { title: "Reader Title", company: "Reader Company", location: "Hamburg", description: "From the reader." };
    const fromLd = {
      title: "Senior Backend Engineer",
      company: "Quillfeather Systems GmbH",
      location: "Berlin, DE",
      description: "Route planning for bike couriers.",
    };
    for (const url of [
      // The same page without tracking parameters (normalizeUrl's key).
      "https://www.linkedin.com/jobs/view/4711/",
      "/jobs/view/4711",
      "javascript:void(0)",
      undefined,
    ]) {
      const result = read({
        url: "https://www.linkedin.com/jobs/view/4711/?trackingId=abc&refId=def",
        jsonLd: [posting()],
        site: reader({ ...fields, url }),
      });
      expect(result, String(url)).toMatchObject(fromLd);
    }
  });

  it("then OpenGraph and <title> by extract.ts's rules", () => {
    expect(read({ meta: OG })).toMatchObject({ title: "Data Analyst", company: "Fernwood Labs" });
    expect(read({ title: "Platform Engineer | Careers" })).toMatchObject({ title: "Platform Engineer" });
  });

  it("then the link heuristics", () => {
    const result = read({ url: "https://boards.greenhouse.io/larkspur-analytics/jobs/123-staff-engineer-remote" });
    expect(result).toMatchObject({ title: "Staff Engineer Remote", company: "Larkspur Analytics", location: "Remote" });
  });

  it("splits a job board's title for the employer, unless the site reader named the company", () => {
    const board = {
      url: "https://www.linkedin.com/jobs/view/4711",
      title: "Senior Engineer at Ironbark Robotics | LinkedIn",
    };
    expect(read(board)).toMatchObject({ title: "Senior Engineer", company: "Ironbark Robotics" });
    // The reader's company ranks above the title's employer, and is cut from the title too.
    expect(read({ ...board, site: reader({ company: "Ironbark Robotics GmbH" }) })).toMatchObject({
      title: "Senior Engineer",
      company: "Ironbark Robotics GmbH",
    });
  });

  it("cleans the site reader's text to one line", () => {
    const result = read({ site: reader({ title: "  Backend\n  Engineer\t(m/f/d) ", company: "Halyard\u0007 Cloud" }) });
    expect(result).toMatchObject({ title: "Backend Engineer (m/f/d)", company: "Halyard Cloud" });
  });

  it("reads meta names in any case", () => {
    expect(read({ meta: { "OG:Title": "Data Analyst | Fernwood Labs", "Og:Site_Name": "Fernwood Labs" } })).toMatchObject({
      title: "Data Analyst",
      company: "Fernwood Labs",
    });
  });
});

describe("readSnapshot: the description", () => {
  const ld = posting({ description: "From JSON-LD." });

  it("takes a selection of at least 200 characters, trimmed, over everything else", () => {
    const selection = `\n  ${long("Selected", MIN_SELECTION)}  \n`;
    const result = read({ selection, jsonLd: [ld], site: reader({ description: "From the reader." }), meta: OG });
    expect(result.description).toBe(selection.trim());

    // 199 characters once trimmed: too short to be a description.
    const short = `   ${long("Selected", MIN_SELECTION - 1)}   `;
    expect(read({ selection: short, jsonLd: [ld] }).description).toBe("From JSON-LD.");
  });

  it("keeps a selection's line breaks", () => {
    const selection = `Tasks\r\n\r\n\r\n- ${long("Build", 120)}\n- ${long("Own", 120)}`;
    expect(read({ selection }).description).toBe(`Tasks\n\n- ${long("Build", 120).trim()}\n- ${long("Own", 120).trim()}`);
  });

  it("then JSON-LD, the site reader, og:description and the description meta", () => {
    const site = reader({ description: "From the reader.\n\nSecond paragraph." });
    expect(read({ jsonLd: [ld], site, meta: OG }).description).toBe("From JSON-LD.");
    expect(read({ site, meta: OG }).description).toBe("From the reader.\n\nSecond paragraph.");
    expect(read({ meta: OG }).description).toBe("Fernwood Labs is hiring a data analyst.");
    expect(read({ meta: { description: "From the description meta." } }).description).toBe("From the description meta.");
    expect(read({ meta: { ...OG, description: "From the description meta." } }).description).toBe(
      "Fernwood Labs is hiring a data analyst.",
    );
    expect(read({}).description).toBe("");
  });
});

describe("readSnapshot: the link", () => {
  it("takes the site reader's link first", () => {
    const result = read({
      url: "https://www.linkedin.com/jobs/search/?currentJobId=4711",
      canonicalUrl: "https://www.linkedin.com/jobs/search/",
      site: reader({ url: "https://www.linkedin.com/jobs/view/4711/" }),
    });
    expect(result.url).toBe("https://www.linkedin.com/jobs/view/4711/");
  });

  it("then the canonical link when it names the same page as the tab, only cleaner", () => {
    // Tracking parameters, www., a trailing slash, the parameters' order and a fragment that is
    // not a route are not part of the link key (normalizeUrl), so the canonical link may drop them.
    expect(read({ url: `${TAB}?utm_source=invented&utm_medium=mail`, canonicalUrl: TAB }).url).toBe(TAB);
    expect(read({ url: `${TAB}/#apply`, canonicalUrl: TAB }).url).toBe(TAB);
    expect(read({ url: TAB.replace("careers.", "www.careers."), canonicalUrl: TAB }).url).toBe(TAB);
    expect(
      read({ url: "https://careers.example.com/jobs?b=2&id=4711&a=1", canonicalUrl: "https://careers.example.com/jobs?a=1&b=2&id=4711" }).url,
    ).toBe("https://careers.example.com/jobs?a=1&b=2&id=4711");
    // Read against the tab's address.
    expect(read({ url: `${TAB}?ref=x`, canonicalUrl: "/jobs/4711-backend-engineer" }).url).toBe(TAB);
    // https is kept: an http page may name its https address, not the other way round.
    expect(read({ url: "http://careers.example.com/jobs/4711", canonicalUrl: "https://careers.example.com/jobs/4711" }).url).toBe(
      "https://careers.example.com/jobs/4711",
    );
    for (const canonicalUrl of [
      "https://other.example.com/jobs/4711-backend-engineer",
      "https://example.com/jobs/4711-backend-engineer",
      "javascript:alert(1)",
      "mailto:jobs@example.com",
      "",
      null,
    ]) {
      expect(read({ url: `${TAB}?ref=x`, canonicalUrl }).url, String(canonicalUrl)).toBe(`${TAB}?ref=x`);
    }
  });

  // A canonical link less specific than the tab would give every posting the same link, so the
  // second one saved would be taken for the first (the link decides "the same job").
  it("keeps the tab's address when the canonical link names another page", () => {
    const cases: Array<[tab: string, canonical: string]> = [
      // A CMS plugin that drops the query.
      ["https://acme.example.com/careers/job?gh_jid=4711", "https://acme.example.com/careers/job"],
      // A single-page site's static canonical link, and one left over from the first job viewed.
      ["https://careers.example.com/#/jobs/4712", "https://careers.example.com/"],
      ["https://careers.example.com/jobs/4712-data-engineer", "https://careers.example.com/jobs/4711-backend-engineer"],
      // A Glassdoor search page with a posting open: the search without ?jl= is canonical
      // (tests/extension/page/fixtures/glassdoor.html).
      [
        "https://www.glassdoor.de/Job/hamburg-data-analyst-jobs-SRCH_IL.0,7_IC2632180_KO8,20.htm?jl=1009876543210",
        "https://www.glassdoor.de/Job/hamburg-data-analyst-jobs-SRCH_IL.0,7_IC2632180_KO8,20.htm",
      ],
      // https is never given up for http.
      [`${TAB}?utm_source=invented`, TAB.replace("https:", "http:")],
      [TAB, TAB.replace("https:", "http:")],
    ];
    for (const [url, canonicalUrl] of cases) {
      expect(read({ url, canonicalUrl }).url, url).toBe(new URL(url).href);
    }

    // Two postings on one search page keep two link keys (what readPageSnapshot looks up).
    const glassdoor = (jl: string) =>
      jobKeys(
        read({
          url: `https://www.glassdoor.de/Job/hamburg-data-analyst-jobs-SRCH_IL.0,7_IC2632180_KO8,20.htm?jl=${jl}`,
          canonicalUrl: "https://www.glassdoor.de/Job/hamburg-data-analyst-jobs-SRCH_IL.0,7_IC2632180_KO8,20.htm",
        }),
      ).urlNorm;
    expect(glassdoor("1009111111111")).not.toBe(glassdoor("1009876543210"));
  });

  it("keeps the link's title when the canonical link is the site's home page", () => {
    const result = read({
      url: "https://boards.greenhouse.io/larkspur-analytics/jobs/123-staff-engineer-remote",
      canonicalUrl: "https://boards.greenhouse.io/",
    });
    expect(result).toMatchObject({
      url: "https://boards.greenhouse.io/larkspur-analytics/jobs/123-staff-engineer-remote",
      title: "Staff Engineer Remote",
      company: "Larkspur Analytics",
    });
  });

  it("ignores a site reader's link that is not http(s)", () => {
    expect(read({ canonicalUrl: TAB, site: reader({ url: "javascript:void(0)" }) }).url).toBe(TAB);
  });

  it("feeds the link it chose to the link heuristics", () => {
    const result = read({
      url: "https://www.linkedin.com/jobs/search/?currentJobId=1",
      site: reader({ url: "https://jobs.lever.co/kettle-and-co/abc-product-designer" }),
    });
    expect(result).toMatchObject({ company: "Kettle And co", title: "Abc Product Designer" });
  });
});

describe("readSnapshot: limits and missing", () => {
  it("cuts every field to the job input limits", () => {
    const result = read({
      site: reader({
        title: "T".repeat(1_000),
        company: "C".repeat(1_000),
        location: "L".repeat(1_000),
        description: "D".repeat(100_000),
      }),
    });
    expect(result.title).toHaveLength(MAX_FIELD);
    expect(result.company).toHaveLength(MAX_FIELD);
    expect(result.location).toHaveLength(MAX_FIELD);
    expect(result.description).toHaveLength(MAX_DESCRIPTION);
  });

  it("lists the empty fields in missing", () => {
    expect(read({ url: "https://www.linkedin.com/jobs/view/4711" })).toEqual({
      title: "",
      company: "",
      location: "",
      url: "https://www.linkedin.com/jobs/view/4711",
      description: "",
      missing: ["title", "company", "location", "description"],
    });
  });
});

describe("pageSnapshotSchema", () => {
  const ok = (page: Record<string, unknown>) => pageSnapshotSchema.safeParse({ url: TAB, ...page }).success;

  it("needs only the tab's address, and fills the rest", () => {
    expect(pageSnapshotSchema.parse({ url: TAB })).toEqual({
      url: TAB,
      canonicalUrl: null,
      title: "",
      meta: {},
      jsonLd: [],
      site: null,
      selection: "",
    });
    expect(extensionReadSchema.safeParse({}).success).toBe(false);
  });

  it("takes an http or https tab address of at most 2,048 characters", () => {
    expect(ok({ url: "http://localhost:3800/jobs/1" })).toBe(true);
    expect(ok({ url: `https://example.com/${"a".repeat(2_048 - 20)}` })).toBe(true);
    for (const url of ["ftp://example.com/x", "javascript:alert(1)", "chrome://extensions", "file:///tmp/x", "", `https://example.com/${"a".repeat(2_048)}`]) {
      expect(ok({ url }), url.slice(0, 30)).toBe(false);
    }
  });

  it("takes any canonical link up to the limit (ignored later unless http)", () => {
    expect(ok({ canonicalUrl: "javascript:alert(1)" })).toBe(true);
    expect(ok({ canonicalUrl: "x".repeat(2_048) })).toBe(true);
    expect(ok({ canonicalUrl: "x".repeat(2_049) })).toBe(false);
  });

  it("refuses text over the limits", () => {
    const meta = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ title: "t".repeat(1_000) }, { title: "t".repeat(1_001) }],
      [{ meta: meta(10) }, { meta: meta(11) }],
      [{ meta: { ["k".repeat(40)]: "v" } }, { meta: { ["k".repeat(41)]: "v" } }],
      [{ meta: { description: "v".repeat(5_000) } }, { meta: { description: "v".repeat(5_001) } }],
      [{ jsonLd: Array(20).fill("{}") }, { jsonLd: Array(21).fill("{}") }],
      [{ jsonLd: ["x".repeat(200_000)] }, { jsonLd: ["x".repeat(200_001)] }],
      [{ selection: "s".repeat(100_000) }, { selection: "s".repeat(100_001) }],
      [{ site: reader({}) }, { site: { reader: "Invented-Board", fields: {} } }],
      [{ site: { reader: "r".repeat(40), fields: {} } }, { site: { reader: "r".repeat(41), fields: {} } }],
      [{ site: reader({ url: "u".repeat(2_048) }) }, { site: reader({ url: "u".repeat(2_049) }) }],
      [{ site: reader({ title: "t".repeat(1_000) }) }, { site: reader({ title: "t".repeat(1_001) }) }],
      [{ site: reader({ company: "c".repeat(1_000) }) }, { site: reader({ company: "c".repeat(1_001) }) }],
      [{ site: reader({ location: "l".repeat(1_000) }) }, { site: reader({ location: "l".repeat(1_001) }) }],
      [
        { site: reader({ description: "d".repeat(100_000) }) },
        { site: reader({ description: "d".repeat(100_001) }) },
      ],
    ];
    for (const [fits, over] of cases) {
      expect(ok(fits), JSON.stringify(fits).slice(0, 60)).toBe(true);
      expect(ok(over), JSON.stringify(over).slice(0, 60)).toBe(false);
    }
    expect(ok({ site: { reader: "", fields: {} } })).toBe(false);
  });
});
