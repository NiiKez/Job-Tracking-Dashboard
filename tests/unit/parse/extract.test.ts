import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_DEPTH, extractJobPage, htmlToText } from "@/lib/server/parse/extract";
import { MAX_DESCRIPTION, MAX_FIELD } from "@/lib/server/parse/limits";

const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, "../../fixtures/pages", name), "utf8");

function page(head: string, body = "") {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

function jsonLd(value: unknown) {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

describe("extractJobPage on saved pages", () => {
  it("reads a top-level JobPosting, ahead of OpenGraph and <title>", () => {
    expect(extractJobPage(fixture("jsonld-top-level.html"))).toEqual({
      title: "Senior Backend Engineer",
      company: "Quillfeather Systems GmbH",
      location: "Berlin, DE",
      description: [
        "We build route planning for bike couriers & small fleets.",
        "",
        "What you will do",
        "",
        "• Design APIs",
        "• Own the Postgres schema",
        "",
        "Salary: 70–85k €",
        "Start: as soon as possible",
      ].join("\n"),
    });
  });

  it("reads a JobPosting inside @graph, with @type as an array and several locations", () => {
    expect(extractJobPage(fixture("jsonld-graph.html"))).toEqual({
      title: "Warehouse Data Analyst (m/f/d)",
      company: "Copperleaf Logistics AG",
      location: "Hamburg, Germany; Leipzig, Germany",
      description:
        "Plain text description & more.\nSecond line stays a line.\n\nToo many blank lines collapse.",
    });
  });

  it("reads a JobPosting from an array, remote, with HTML escaped twice", () => {
    expect(extractJobPage(fixture("jsonld-array.html"))).toEqual({
      title: "Product Engineer & Team Lead",
      company: "Larkspur Analytics",
      location: "Remote",
      description: "Fully remote within Germany.\n\n• TypeScript\n• React",
    });
  });

  it("skips a broken JSON-LD script and reads the good one next to it", () => {
    expect(extractJobPage(fixture("jsonld-broken.html"))).toEqual({
      title: "Site Reliability Engineer",
      company: "Halyard Cloud",
      location: "Munich, Germany",
      description: "Keep the platform up. Line two had a raw line break, which is not valid JSON.",
    });
  });

  it("follows @id references into @graph, past a nested posting in an earlier script", () => {
    expect(extractJobPage(fixture("jsonld-references.html"))).toEqual({
      title: "Robotics Engineer",
      company: "Ironbark Robotics GmbH",
      location: "Stuttgart, DE",
      description: "Build the arms.\nSalary <EUR 70k depending on experience.\n\nApply by May.",
    });
  });

  it("falls back to OpenGraph", () => {
    expect(extractJobPage(fixture("opengraph-only.html"))).toEqual({
      title: "Product Designer",
      company: "Fernwood Labs",
      location: undefined,
      description: "Fernwood Labs is hiring a product designer for its planning tools & dashboards.",
    });
  });

  it("falls back to <title>, ignoring an SVG's title", () => {
    expect(extractJobPage(fixture("title-only.html"))).toEqual({
      title: "Data Analyst - Brightmoor Analytics",
      company: undefined,
      location: undefined,
      description: undefined,
    });
    // With the company known from the link, it is cut from the title.
    expect(extractJobPage(fixture("title-only.html"), { company: "Brightmoor Analytics" }).title).toBe(
      "Data Analyst",
    );
  });

  it("finds nothing on a page without job data", () => {
    expect(extractJobPage("<p>Hello</p>")).toEqual({
      title: undefined,
      company: undefined,
      location: undefined,
      description: undefined,
    });
    expect(extractJobPage("")).toEqual(extractJobPage("<p>Hello</p>"));
  });
});

describe("JSON-LD details", () => {
  const posting = (fields: Record<string, unknown>) =>
    extractJobPage(page(jsonLd({ "@context": "https://schema.org", "@type": "JobPosting", ...fields })));

  it.each([
    [{ name: "Acme Robotics" }, "Acme Robotics"],
    ["Acme Robotics", "Acme Robotics"],
    [[{ "@type": "Organization", name: "Acme Robotics" }], "Acme Robotics"],
    [{ legalName: "Acme Robotics GmbH" }, "Acme Robotics GmbH"],
    [{ name: "Acme &amp; Sons" }, "Acme & Sons"],
    [["Acme Robotics", "Other"], "Acme Robotics"],
  ])("reads hiringOrganization %j", (hiringOrganization, company) => {
    expect(posting({ title: "Engineer", hiringOrganization }).company).toBe(company);
  });

  it.each([
    [{ address: { addressLocality: "Vienna", addressCountry: { "@type": "Country", name: "Austria" } } }, "Vienna, Austria"],
    [{ address: { addressLocality: "Köln", addressRegion: "NRW", addressCountry: "DE" } }, "Köln, NRW, DE"],
    [{ address: { addressLocality: "Berlin", addressRegion: "Berlin", addressCountry: "DE" } }, "Berlin, DE"],
    [{ address: "Zurich, Switzerland" }, "Zurich, Switzerland"],
    [{ "@type": "Place", name: "Head office" }, "Head office"],
    [[{ address: { addressLocality: "Lisbon" } }, { address: { addressLocality: "Lisbon" } }], "Lisbon"],
    ["Berlin, Germany", "Berlin, Germany"],
    [{ address: [{ addressLocality: "Graz", addressCountry: "AT" }] }, "Graz, AT"],
    [{ "@type": "Place", address: { "@type": "PostalAddress", streetAddress: "Beispielweg 2" } }, undefined],
  ])("reads jobLocation %j", (jobLocation, location) => {
    expect(posting({ title: "Engineer", jobLocation }).location).toBe(location);
  });

  it.each(["TELECOMMUTE", ["TELECOMMUTE"], "telecommute", ["FULL_TIME", "TELECOMMUTE"]])(
    "reads jobLocationType %j as Remote, over an address",
    (jobLocationType) => {
      expect(
        posting({ title: "Engineer", jobLocationType, jobLocation: { address: { addressLocality: "Berlin" } } })
          .location,
      ).toBe("Remote");
    },
  );

  it.each(["schema:JobPosting", "http://schema.org/JobPosting", ["Thing", "JobPosting"]])(
    "accepts @type %j",
    (type) => {
      expect(extractJobPage(page(jsonLd({ "@type": type, title: "Engineer" }))).title).toBe("Engineer");
    },
  );

  it("finds a posting under mainEntity and prefers the shallowest one", () => {
    const html = page(
      jsonLd({
        "@type": "WebPage",
        mainEntity: {
          "@type": "JobPosting",
          title: "Main job",
          relatedLink: { "@type": "ItemList", itemListElement: [{ "@type": "JobPosting", title: "Other" }] },
        },
      }),
    );
    expect(extractJobPage(html).title).toBe("Main job");
  });

  it("uses the first script that holds a posting", () => {
    const html = page(
      jsonLd({ "@type": "Organization", name: "Acme" }) +
        jsonLd({ "@type": "JobPosting", title: "First" }) +
        jsonLd({ "@type": "JobPosting", title: "Second" }),
    );
    expect(extractJobPage(html).title).toBe("First");
  });

  it("prefers a top-level posting in a later script over one nested in an earlier script", () => {
    const similar = { "@type": "ItemList", itemListElement: [{ "@type": "JobPosting", title: "Other job" }] };
    const later = jsonLd({ "@type": "JobPosting", title: "This job" });
    expect(extractJobPage(page(jsonLd({ "@type": "WebPage", mainEntity: similar }) + later)).title).toBe(
      "This job",
    );
    expect(extractJobPage(page(jsonLd([{ "@type": "WebPage", hasPart: similar }]) + later)).title).toBe(
      "This job",
    );
  });

  it("counts postings in @graph and in arrays as top level, so the first in the page wins", () => {
    const plain = jsonLd({ "@type": "JobPosting", title: "Plain" });
    const graph = jsonLd({ "@graph": [{ "@type": "WebSite" }, { "@type": "JobPosting", title: "In graph" }] });
    const array = jsonLd([[{ "@type": "JobPosting", title: "In array" }]]);
    expect(extractJobPage(page(graph + plain)).title).toBe("In graph");
    expect(extractJobPage(page(array + plain)).title).toBe("In array");
  });

  it("follows @id references to the company and the place", () => {
    const html = page(
      jsonLd({
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "JobPosting",
            title: "Engineer",
            hiringOrganization: { "@id": "https://acme.example/#org" },
            jobLocation: [{ "@id": "#berlin" }, { "@type": "Place", "@id": "#hamburg" }],
          },
          { "@type": "Organization", "@id": "https://acme.example/#org", name: "Acme Robotics GmbH" },
          { "@type": "Place", "@id": "#berlin", address: { "@id": "#berlin-address" } },
          { "@type": "PostalAddress", "@id": "#berlin-address", addressLocality: "Berlin" },
          { "@type": "Place", "@id": "#hamburg", name: "Hamburg office" },
        ],
      }) + `<meta property="og:site_name" content="Acme Engineering Blog">`,
    );
    expect(extractJobPage(html)).toMatchObject({
      company: "Acme Robotics GmbH",
      location: "Berlin; Hamburg office",
    });
  });

  it("leaves a reference that leads nowhere, or back to itself, empty", () => {
    expect(posting({ title: "Engineer", hiringOrganization: { "@id": "#missing" } }).company).toBeUndefined();
    const html = page(
      jsonLd({
        "@graph": [
          { "@type": "JobPosting", title: "Engineer", jobLocation: { "@id": "#loop" } },
          { "@type": "Place", "@id": "#loop", address: { "@id": "#loop" } },
        ],
      }),
    );
    expect(extractJobPage(html).location).toBeUndefined();
  });

  it.each([
    [{ title: "", name: "Data Engineer" }, "Data Engineer"],
    [{ title: "  ", name: "Data Engineer" }, "Data Engineer"],
    [{ title: [""], name: { "@value": "Data Engineer" } }, "Data Engineer"],
    [{ title: { "@value": "" }, name: "Data Engineer" }, "Data Engineer"],
    [{ title: "<b></b>", name: "Data Engineer" }, "Data Engineer"],
  ])("reads the name when the title is blank: %j", (fields, title) => {
    expect(posting(fields).title).toBe(title);
  });

  it("reads the legalName when the company's name is blank", () => {
    expect(posting({ title: "Engineer", hiringOrganization: { name: "", legalName: "Acme GmbH" } }).company).toBe(
      "Acme GmbH",
    );
  });

  it("reads a plain-text description with a '<' in it as text, keeping its lines", () => {
    const description =
      "Your tasks\n- Build the API\n- Salary <EUR 60k for juniors\n- Own the database\n\nApply now";
    expect(posting({ title: "Engineer", description }).description).toBe(description);
  });

  it("keeps the line breaks of a description whose only tags are inline", () => {
    const description = "Your tasks\r\n- Build the API\n- Own the <b>database</b>\n  \n\n\nApply <a\nhref='/apply'>now</a>";
    expect(posting({ title: "Engineer", description }).description).toBe(
      "Your tasks\n- Build the API\n- Own the database\n\nApply now",
    );
  });

  it("keeps a '<' in one-line fields", () => {
    expect(posting({ title: "Engineer <Backend> (m/w/d)", hiringOrganization: "A&amp;B <Labs>" })).toMatchObject({
      title: "Engineer <Backend> (m/w/d)",
      company: "A&B <Labs>",
    });
  });

  it("tolerates comment and CDATA wrappers", () => {
    const body = JSON.stringify({ "@type": "JobPosting", title: "Wrapped" });
    expect(extractJobPage(page(`<script type="application/ld+json"><!--${body}--></script>`)).title).toBe("Wrapped");
    expect(
      extractJobPage(page(`<script type="application/ld+json">//<![CDATA[\n${body}\n//]]></script>`)).title,
    ).toBe("Wrapped");
  });

  it("ignores scripts of other types", () => {
    const html = page(`<script type="application/json">{"@type":"JobPosting","title":"No"}</script><title>Yes</title>`);
    expect(extractJobPage(html).title).toBe("Yes");
  });

  it("strips tags and control characters from one-line fields", () => {
    expect(posting({ title: "<b>Senior</b>\n\tEngineer\u0007" }).title).toBe("Senior Engineer");
  });

  it("caps title, company and location at 200 characters and the description at 50,000", () => {
    const result = posting({
      title: "T".repeat(500),
      hiringOrganization: "C".repeat(500),
      jobLocation: { address: "L".repeat(500) },
      description: `<p>${"word ".repeat(20_000)}</p>`,
    });
    expect(result.title).toHaveLength(MAX_FIELD);
    expect(result.company).toHaveLength(MAX_FIELD);
    expect(result.location).toHaveLength(MAX_FIELD);
    expect(result.description!.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(result.description!.length).toBeGreaterThan(MAX_DESCRIPTION - 10);
  });

  it("does not cut a surrogate pair in half", () => {
    const title = `${"a".repeat(MAX_FIELD - 1)}😀`;
    expect(posting({ title }).title).toBe("a".repeat(MAX_FIELD - 1));
  });
});

describe("OpenGraph and <title> details", () => {
  it.each([
    ["Backend Engineer | Acme Careers", "Backend Engineer"],
    ["Acme - Backend Engineer", "Backend Engineer"],
    ["Backend Engineer – Acme", "Backend Engineer"],
    ["Backend Engineer at Acme", "Backend Engineer"],
    ["Job Application for Backend Engineer at Acme", "Backend Engineer"],
    ["Backend Engineer - Payments | Acme | Careers", "Backend Engineer - Payments"],
    ["Front-end Engineer", "Front-end Engineer"],
    ["Backend Engineer | LinkedIn", "Backend Engineer"],
  ])("cleans %j", (ogTitle, title) => {
    const html = page(`<meta property="og:title" content="${ogTitle}"><meta property="og:site_name" content="Acme">`);
    expect(extractJobPage(html).title).toBe(title);
  });

  it.each([
    "Careers at Acme",
    "Jobs at Acme",
    "Karriere bei Acme",
    "Open positions at Acme",
    "Jobs @ Acme GmbH",
    "Jobs at Acme | Careers",
  ])("finds no title in a career site's own name %j", (title) => {
    // With the company the link gives, and without one.
    expect(extractJobPage(page(`<title>${title}</title>`), { company: "Acme" }).title).toBeUndefined();
    expect(extractJobPage(page(`<title>${title}</title>`)).title).toBeUndefined();
  });

  it("keeps a title that only starts with a career site's name", () => {
    expect(extractJobPage(page("<title>Jobs at Acme: Backend Engineer</title>")).title).toBe(
      "Jobs at Acme: Backend Engineer",
    );
    expect(extractJobPage(page("<title>Careers at Acme - Backend Engineer</title>")).title).toBe("Backend Engineer");
  });

  it.each([
    ["Backend Engineer | Acme GmbH", "Acme"],
    ["Backend Engineer - Acme Inc.", "Acme"],
    ["Backend Engineer at Acme AG", "Acme"],
    ["Backend Engineer · Acme S.A.", "Acme"],
    ["Backend Engineer bei Acme GmbH & Co. KG", "Acme"],
    ["Backend Engineer | ACME", "Acme GmbH"],
    ["Backend Engineer at Acme Robotics", "Acmerobotics"],
  ])("cuts %j, as the company %j spelt another way", (title, company) => {
    expect(extractJobPage(page(`<title>${title}</title>`), { company }).title).toBe("Backend Engineer");
  });

  it.each([
    `<meta property="og:site_name" content="LinkedIn"><meta property="og:title" content="Senior Engineer at Acme | LinkedIn">`,
    `<title>Senior Engineer at Acme | LinkedIn</title>`,
    `<meta property="og:site_name" content="Greenhouse"><title>Senior Engineer @ Acme</title>`,
  ])("splits the employer off a job board's title: %s", (head) => {
    expect(extractJobPage(page(head))).toMatchObject({ title: "Senior Engineer", company: "Acme" });
  });

  it("leaves ' at ' in the title off a job board, or when the page names the company", () => {
    expect(extractJobPage(page(`<title>Senior Engineer at Acme</title>`))).toMatchObject({
      title: "Senior Engineer at Acme",
      company: undefined,
    });
    const named = `<meta property="og:site_name" content="LinkedIn"><title>Head of Work at Height | LinkedIn</title>`;
    const posting = jsonLd({ "@type": "JobPosting", hiringOrganization: "Acme" });
    expect(extractJobPage(page(named + posting))).toMatchObject({ title: "Head of Work at Height", company: "Acme" });
  });

  it("falls through to <title> when og:title is only the site name", () => {
    const html = page(
      `<meta property="og:title" content="Acme Careers"><meta property="og:site_name" content="Acme"><title>Data Engineer | Acme</title>`,
    );
    expect(extractJobPage(html).title).toBe("Data Engineer");
  });

  it.each([
    ["Acme Careers", "Acme"],
    ["Acme Jobs", "Acme"],
    ["LinkedIn", undefined],
    ["Greenhouse", undefined],
    ["Careers", undefined],
  ])("reads og:site_name %j as company %j", (siteName, company) => {
    expect(extractJobPage(page(`<meta property="og:site_name" content="${siteName}">`)).company).toBe(company);
  });

  it("reads meta name= as well as property=, and keeps the first", () => {
    const html = page(`<meta name="og:title" content="First"><meta property="og:title" content="Second">`);
    expect(extractJobPage(html).title).toBe("First");
  });
});

describe("deeply nested tags", () => {
  // htmlparser2's cost grows with the square of the nesting depth: before the depth limit,
  // 300,000 unclosed <b> in a description took over a minute.
  const fast = (fn: () => unknown) => {
    const started = Date.now();
    fn();
    return Date.now() - started;
  };

  it("reads what comes before a 2 MB run of unclosed tags, quickly", () => {
    const html =
      `<title>Data Analyst | Brightmoor</title>${jsonLd({ "@type": "JobPosting", title: "Data Analyst", hiringOrganization: "Brightmoor" })}` +
      "<b>".repeat(690_000);
    let result: ReturnType<typeof extractJobPage> | undefined;
    expect(fast(() => (result = extractJobPage(html)))).toBeLessThan(2_000);
    expect(result).toMatchObject({ title: "Data Analyst", company: "Brightmoor" });
  });

  it("reads a JSON-LD description full of unclosed tags quickly", () => {
    const soup = `<p>Intro</p>${"<b>".repeat(300_000)}`;
    let result: ReturnType<typeof extractJobPage> | undefined;
    const html = page(jsonLd({ "@type": "JobPosting", title: `Engineer${soup}`, description: soup }));
    expect(fast(() => (result = extractJobPage(html)))).toBeLessThan(2_000);
    expect(result).toMatchObject({ title: "Engineer Intro", description: "Intro" });
  });

  it("still reads a page nested as deep as the limit, and nothing past it", () => {
    const script = jsonLd({ "@type": "JobPosting", title: "Deep" });
    // The script is the element at depth MAX_DEPTH.
    expect(extractJobPage("<div>".repeat(MAX_DEPTH - 1) + script).title).toBe("Deep");
    expect(extractJobPage("<div>".repeat(MAX_DEPTH) + script).title).toBeUndefined();
    // Balanced nesting never adds up, however many elements there are.
    expect(extractJobPage("<div><span>x</span></div>".repeat(10_000) + script).title).toBe("Deep");
  });
});

describe("htmlToText", () => {
  it.each([
    ["<p>One</p><p>Two</p>", "One\n\nTwo"],
    ["One<br>Two<br><br>Three", "One\nTwo\n\nThree"],
    ["<ul><li>a</li><li>b</li></ul>", "• a\n• b"],
    ["<p>Intro</p><ol><li><p>a</p></li></ol>", "Intro\n\n• a"],
    ["<div>  lots\n\n of   space </div>", "lots of space"],
    ["Tom &amp; Jerry &lt;3 &euro;&#8364;&#x20AC;&nbsp;!", "Tom & Jerry <3 €€€ !"],
    ["<p>a</p><script>alert(1)</script><style>p{}</style><noscript>no</noscript><p>b</p>", "a\n\nb"],
    ["<table><tr><td>Salary</td><td>80k</td></tr><tr><td>Start</td><td>May</td></tr></table>", "Salary 80k\nStart May"],
    ["<b>bold</b> <i>italic</i>", "bold italic"],
    ["plain text", "plain text"],
    ["", ""],
  ])("%j", (html, text) => {
    expect(htmlToText(html)).toBe(text);
  });

  it("caps the output", () => {
    expect(htmlToText(`<p>${"x".repeat(100)}</p>`, 10)).toBe("x".repeat(10));
  });
});
