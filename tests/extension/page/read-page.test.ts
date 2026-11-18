// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageSnapshot } from "@/lib/types";
import {
  LIMITS,
  MAX_BODY_BYTES,
  bodyBytes,
  cut,
  cutToBytes,
  jsonBytes,
  readPage,
  withinBudget,
} from "../../../extension/src/page/read-page";
import { normalizeUrl } from "@/lib/domain/normalize";
import { linkedin } from "../../../extension/src/page/sites/linkedin";
import { fixture, page } from "./load";

// readPage(): the generic parts of the snapshot, and the limits it cuts to so that the server
// never refuses it (docs/plan/4-chrome-extension.md, "Snapshot limits").

const URL_ = new URL("https://careers.example.com/jobs/42?ref=list");

function jsonLd(value: unknown) {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

/** A JSON-LD script of exactly `length` characters. */
function script(type: string, length: number) {
  const empty = JSON.stringify({ "@type": type, pad: "" });
  return `<script type="application/ld+json">${JSON.stringify({ "@type": type, pad: "x".repeat(length - empty.length) })}</script>`;
}

const EMOJI = "😀"; // two UTF-16 units: a surrogate pair

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readPage on a page with nothing to read", () => {
  it("gives empty fields and no site", () => {
    expect(readPage(fixture("none.html"), new URL("https://example.com/"), "")).toEqual({
      url: "https://example.com/",
      canonicalUrl: null,
      title: "",
      meta: {},
      jsonLd: [],
      site: null,
      selection: "",
    });
  });

  it("does not trip over an empty document", () => {
    const doc = document.implementation.createHTMLDocument("");
    expect(readPage(doc, URL_, "").site).toBeNull();
  });
});

describe("the generic parts", () => {
  it("passes the tab's address and the selection through", () => {
    const snapshot = readPage(page(""), URL_, "  Selected text  ");
    expect(snapshot.url).toBe("https://careers.example.com/jobs/42?ref=list");
    expect(snapshot.selection).toBe("  Selected text  ");
  });

  it("reads the title with its whitespace collapsed", () => {
    expect(readPage(page("", "<title>\n  Backend   Engineer\n  | Acme </title>"), URL_, "").title).toBe(
      "Backend Engineer | Acme",
    );
  });

  it("resolves the canonical link against the page, or its <base>", () => {
    const relative = page("", '<link rel="canonical" href="/jobs/42">');
    expect(readPage(relative, URL_, "").canonicalUrl).toBe("https://careers.example.com/jobs/42");

    const based = page("", '<base href="https://jobs.example.com/de/"><link rel="Canonical" href="stelle-42">');
    expect(readPage(based, URL_, "").canonicalUrl).toBe("https://jobs.example.com/de/stelle-42");
  });

  it("uses the first canonical link, and only when it is http(s) and short enough", () => {
    const two = page("", '<link rel="canonical" href="https://a.example.com/1"><link rel="canonical" href="https://b.example.com/2">');
    expect(readPage(two, URL_, "").canonicalUrl).toBe("https://a.example.com/1");

    const script = page("", '<link rel="canonical" href="javascript:alert(1)">');
    expect(readPage(script, URL_, "").canonicalUrl).toBeNull();

    const long = page("", `<link rel="canonical" href="https://a.example.com/${"x".repeat(2100)}">`);
    expect(readPage(long, URL_, "").canonicalUrl).toBeNull();

    const other = page("", '<link rel="alternate" href="https://a.example.com/en">');
    expect(readPage(other, URL_, "").canonicalUrl).toBeNull();
  });

  it("reads the first value of each of the four meta tags, by property or name", () => {
    const head = [
      '<meta name="viewport" content="width=device-width">',
      '<meta property="OG:Title" content="  First title ">',
      '<meta property="og:title" content="Second title">',
      '<meta name="og:site_name" content="Acme Careers">',
      '<meta property="og:description" content="">',
      '<meta property="og:description" content="The real description">',
      '<meta name="description" content="Plain description">',
      '<meta name="twitter:title" content="Not read">',
    ].join("");
    expect(readPage(page("", head), URL_, "").meta).toEqual({
      "og:title": "First title",
      "og:site_name": "Acme Careers",
      "og:description": "The real description",
      description: "Plain description",
    });
  });

  it("collects the JSON-LD scripts in page order, whatever the case of their type", () => {
    const head = [
      jsonLd({ "@type": "Organization", name: "Acme" }),
      '<script type="application/json">{"not":"ld"}</script>',
      '<script type="Application/LD+JSON; charset=utf-8">{"@type":"JobPosting"}</script>',
      "<script>var x = 1;</script>",
      '<script type="application/ld+json">   </script>',
    ].join("");
    expect(readPage(page("", head), URL_, "").jsonLd).toEqual([
      '{"@type":"Organization","name":"Acme"}',
      '{"@type":"JobPosting"}',
    ]);
  });
});

describe("snapshot limits", () => {
  it("drops a JSON-LD script over 200,000 characters and keeps the others", () => {
    const head = script("JobPosting", LIMITS.jsonLdScript + 1) + script("Organization", 100);
    const scripts = readPage(page("", head), URL_, "").jsonLd;
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("Organization");
    expect(readPage(page("", script("JobPosting", LIMITS.jsonLdScript)), URL_, "").jsonLd).toHaveLength(1);
  });

  it("keeps JSON-LD scripts under 600,000 characters together, JobPosting first", () => {
    // Four big scripts that are not a posting come first in the page; the posting is last.
    const head =
      script("BreadcrumbList", 190_000).repeat(4) + script("JobPosting", 190_000) + script("WebSite", 50);
    const scripts = readPage(page("", head), URL_, "").jsonLd;
    const total = scripts.reduce((sum, s) => sum + s.length, 0);
    expect(total).toBeLessThanOrEqual(LIMITS.jsonLdTotal);
    expect(scripts.some((s) => s.includes('"JobPosting"'))).toBe(true);
    // The posting, two of the big ones, and the small one still fit; in page order.
    expect(scripts.map((s) => JSON.parse(s)["@type"])).toEqual([
      "BreadcrumbList",
      "BreadcrumbList",
      "JobPosting",
      "WebSite",
    ]);
  });

  it("sends at most 20 JSON-LD scripts, preferring those that mention JobPosting", () => {
    const head =
      Array.from({ length: 25 }, (_, i) => jsonLd({ "@type": "Thing", i })).join("") +
      jsonLd({ "@type": "JobPosting", title: "Last in the page" });
    const scripts = readPage(page("", head), URL_, "").jsonLd;
    expect(scripts).toHaveLength(LIMITS.jsonLdCount);
    expect(scripts.at(-1)).toContain("Last in the page");
  });

  it("cuts the title, meta values and the selection to their limits", () => {
    const head = `<title>${"t".repeat(1_500)}</title><meta name="description" content="${"d".repeat(6_000)}">`;
    const snapshot = readPage(page("", head), URL_, "s".repeat(150_000));
    expect(snapshot.title).toHaveLength(LIMITS.title);
    expect(snapshot.meta.description).toHaveLength(LIMITS.metaValue);
    expect(snapshot.selection).toHaveLength(LIMITS.selection);
  });


  it("never cuts an emoji in half", () => {
    const head = `<title>${"t".repeat(LIMITS.title - 1)}${EMOJI}</title>`;
    const selection = "s".repeat(LIMITS.selection - 1) + EMOJI;
    const snapshot = readPage(page("", head), URL_, selection);
    expect(snapshot.title).toBe("t".repeat(LIMITS.title - 1));
    expect(snapshot.selection).toBe("s".repeat(LIMITS.selection - 1));
    expect(snapshot.selection.isWellFormed()).toBe(true);
  });
});

describe("a tab address over 2,048 characters", () => {
  // The address becomes the job's link, and its key, when nothing else names the posting, so it
  // loses what does not identify the page before anything is cut.
  const read = (href: string) => readPage(page(""), new URL(href), "").url;
  const long = "x".repeat(LIMITS.url);

  it("is sent whole while it fits, fragment and tracking parameters included", () => {
    const short = "https://careers.example.com/jobs/42?utm_source=mail&ref=list#apply";
    expect(read(short)).toBe(short);
    const base = "https://careers.example.com/jobs/42?utm_source=mail#";
    const atLimit = base + "x".repeat(LIMITS.url - base.length);
    expect(read(atLimit)).toBe(atLimit);
  });

  it("first loses a fragment that is not a client-side route", () => {
    expect(read(`https://careers.example.com/jobs/42?utm_source=mail#${long}`)).toBe(
      "https://careers.example.com/jobs/42?utm_source=mail",
    );
  });

  it("then its tracking parameters, keeping a route and every other parameter as written", () => {
    const tracking = `UTM_Campaign=${long}&Ref=x&refId=1&referrer=a&source=b&gh_src=c&trk=d&TrackingId=e`;
    const others = "id=7&q=a%20b+c&x=%E4&referenceId=8&sourceId=9";
    expect(read(`https://careers.example.com/?${tracking}&${others}#/jobs/42`)).toBe(
      `https://careers.example.com/?${others}#/jobs/42`,
    );
    expect(read(`https://careers.example.com/?${others}&${tracking}#!/jobs/42`)).toBe(
      `https://careers.example.com/?${others}#!/jobs/42`,
    );
    expect(read(`https://careers.example.com/jobs/42?utm_source=${long}`)).toBe("https://careers.example.com/jobs/42");
  });

  it("and is cut only when that is not enough", () => {
    const url = read(`https://careers.example.com/jobs?q=${long}&utm_source=mail#apply`);
    expect(url).toBe(`https://careers.example.com/jobs?q=${long}`.slice(0, LIMITS.url));
    expect(read(`https://careers.example.com/jobs?q=${"x".repeat(3_000)}`)).toHaveLength(LIMITS.url);
  });

  it("drops the parameters the server's link key leaves out, and only those", () => {
    const names = [
      ...["utm_source", "UTM_Medium", "utm_", "utm%5Fsource", "ref", "REF", "refid", "refId", "referrer"],
      ...["source", "gh_src", "trk", "trackingId", "trackingid"],
      ...["utm", "utmsource", "referenceId", "sourceId", "ref_", "ref+", "trk_info", "jk", "gh_jid", "src"],
    ];
    for (const name of names) {
      const href = `https://careers.example.com/jobs/42?${name}=${long}`;
      const dropped = read(href) === "https://careers.example.com/jobs/42";
      expect(dropped, name).toBe(normalizeUrl(href) === "careers.example.com/jobs/42");
    }
  });
});

describe("U+0000, which the server refuses anywhere in the request", () => {
  const NUL = "\u0000";

  it("is removed from every text the snapshot carries", () => {
    // An HTML parser turns NUL into U+FFFD, but text a script puts into the page keeps it.
    const doc = page(
      "",
      '<title>x</title><meta name="description" content="x"><link rel="canonical" href="/x"><script type="application/ld+json">{}</script>',
    );
    doc.title = `Back${NUL}end Engineer`;
    doc.querySelector("meta")!.setAttribute("content", `De${NUL}scription`);
    doc.querySelector("link")!.setAttribute("href", `/jobs/4${NUL}2`);
    doc.querySelector("script")!.textContent = `{"@type":"JobPosting","title":"A${NUL}B"}`;
    vi.spyOn(linkedin, "read").mockReturnValue({
      title: `Senior${NUL} Engineer`,
      company: NUL,
      location: `Ber${NUL}lin`,
      description: `${NUL}Line one${NUL}\nLine two`,
    });
    const url = new URL(`https://www.linkedin.com/jobs/view/4012345678/?q=a${NUL}b`);

    const snapshot = readPage(doc, url, `Sel${NUL}ected`);
    expect(JSON.stringify(snapshot)).not.toContain("\\u0000");
    expect(snapshot).toEqual({
      // Addresses never hold one: the URL parser writes it as %00.
      url: "https://www.linkedin.com/jobs/view/4012345678/?q=a%00b",
      canonicalUrl: "https://www.linkedin.com/jobs/4%002",
      title: "Backend Engineer",
      meta: { description: "Description" },
      jsonLd: ['{"@type":"JobPosting","title":"AB"}'],
      site: {
        reader: "linkedin",
        fields: { title: "Senior Engineer", location: "Berlin", description: "Line one\nLine two" },
      },
      selection: "Selected",
    });
  });
});

describe("cut", () => {
  it("returns short text as it is", () => {
    expect(cut("abc", 3)).toBe("abc");
    expect(cut("", 0)).toBe("");
  });

  it("cuts to the limit, one unit shorter when that would split a surrogate pair", () => {
    expect(cut("abcdef", 4)).toBe("abcd");
    expect(cut(`ab${EMOJI}`, 3)).toBe("ab");
    expect(cut(`ab${EMOJI}c`, 4)).toBe(`ab${EMOJI}`);
  });
});

describe("what a site reader returns", () => {
  const url = new URL("https://www.linkedin.com/jobs/view/4012345678/");

  it("is cut to the limits: one line, 1,000 characters, 100,000 for the description", () => {
    vi.spyOn(linkedin, "read").mockReturnValue({
      title: `  Senior\n  Engineer ${"t".repeat(2_000)}`,
      company: "",
      location: "   ",
      description: `\n\n${"d".repeat(LIMITS.description - 1)}${EMOJI}`,
    });
    const fields = readPage(page(""), url, "").site?.fields;
    expect(fields?.title).toHaveLength(LIMITS.field);
    expect(fields?.title?.startsWith("Senior Engineer t")).toBe(true);
    expect(fields).not.toHaveProperty("company");
    expect(fields).not.toHaveProperty("location");
    expect(fields?.description).toBe("d".repeat(LIMITS.description - 1));
  });

  it("loses a link that is not http(s) or too long", () => {
    vi.spyOn(linkedin, "read").mockReturnValue({ url: "javascript:alert(1)", title: "Engineer" });
    expect(readPage(page(""), url, "").site).toEqual({ reader: "linkedin", fields: { title: "Engineer" } });

    vi.spyOn(linkedin, "read").mockReturnValue({ url: `https://www.linkedin.com/${"x".repeat(2_100)}` });
    expect(readPage(page(""), url, "").site).toBeNull();
  });

  it("is dropped when the reader throws, and the rest of the snapshot is still read", () => {
    vi.spyOn(linkedin, "read").mockImplementation(() => {
      throw new Error("markup changed");
    });
    const snapshot = readPage(page("", "<title>Engineer | LinkedIn</title>"), url, "");
    expect(snapshot.site).toBeNull();
    expect(snapshot.title).toBe("Engineer | LinkedIn");
  });
});

describe("the request body's byte budget", () => {
  const careers = new URL("https://careers.example.com/jobs/42");
  const CJK = "职"; // three bytes in UTF-8
  const ldScript = (text: string) => `<script type="application/ld+json">${text}</script>`;
  /** A JSON-LD script with `n` CJK characters in it. */
  const cjkScript = (type: string, n: number) => jsonLd({ "@type": type, text: CJK.repeat(n) });
  /** A JSON-LD script of `n` pairs of a backslash and a quote: each character is two bytes in JSON. */
  const escapingScript = (type: string, n: number) =>
    ldScript(`{"@type":"${type}","text":"${'\\"'.repeat(n)}"}`);
  const types = (snapshot: PageSnapshot) => snapshot.jsonLd.map((s) => s.match(/"@type":"(\w+)"/)?.[1]);

  it("counts a string's JSON bytes as JSON.stringify and TextEncoder do", () => {
    const encoder = new TextEncoder();
    const samples = [
      "",
      "plain ascii",
      'quotes " and \\ backslashes',
      "line\nbreak\ttab\r\b\f and \u0001\u001f\u007f controls",
      "Ä ö € 职位 ✓",
      `emoji ${EMOJI} pair`,
      "lone \ud83d high and \ude00 low halves",
      "\u2028\u2029 separators",
    ];
    for (const text of samples) {
      expect(jsonBytes(text), text).toBe(encoder.encode(JSON.stringify(text)).length);
    }
  });

  it("cuts a string to a byte size without splitting an emoji", () => {
    expect(cutToBytes("abcdef", 6)).toBe("abcd"); // 4 + 2 quotes
    expect(cutToBytes('a"b', 4)).toBe("a"); // the quote takes two
    expect(cutToBytes('a"b', 5)).toBe('a"');
    expect(cutToBytes(`ab${EMOJI}`, 7)).toBe("ab"); // the emoji takes four
    expect(cutToBytes(`ab${EMOJI}`, 8)).toBe(`ab${EMOJI}`);
    expect(cutToBytes("abc", 1)).toBe("");
  });

  it("leaves a page of ordinary size untouched", () => {
    const head =
      script("JobPosting", 150_000) + script("BreadcrumbList", 150_000) + script("WebSite", 150_000);
    const doc = page(`<main>${"Description text. ".repeat(5_500)}</main>`, head);
    const selection = "Selected text. ".repeat(6_000);
    const snapshot = readPage(doc, careers, selection);
    expect(bodyBytes(snapshot)).toBeLessThan(MAX_BODY_BYTES);
    expect(types(snapshot)).toEqual(["JobPosting", "BreadcrumbList", "WebSite"]);
    expect(snapshot.selection).toBe(cut(selection, LIMITS.selection));
    expect(snapshot.site?.fields.description).toHaveLength("Description text. ".repeat(5_500).trim().length);
  });

  it("fits a CJK page at every character limit, shedding in order", () => {
    const head = [
      `<title>${CJK.repeat(LIMITS.title)}</title>`,
      ...["og:title", "og:site_name", "og:description", "description"].map(
        (key) => `<meta property="${key}" content="${CJK.repeat(LIMITS.metaValue)}">`,
      ),
      cjkScript("JobPosting", 199_000),
      cjkScript("BreadcrumbList", 199_000),
      cjkScript("Organization", 199_000),
    ].join("");
    const doc = page(`<main>${CJK.repeat(LIMITS.description)}</main>`, head);
    const snapshot = readPage(doc, careers, CJK.repeat(LIMITS.selection));

    expect(bodyBytes(snapshot)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    // 1. The scripts that are not a posting went, the posting stayed.
    expect(types(snapshot)).toEqual(["JobPosting"]);
    // 2. The selection was cut, but is still long enough to be the description.
    expect(snapshot.selection.trim().length).toBeGreaterThanOrEqual(200);
    expect(snapshot.selection.length).toBeLessThan(1_000);
    // 3. The site reader's description was cut to what still fits.
    const description = snapshot.site?.fields.description ?? "";
    expect(description.length).toBeGreaterThan(50_000);
    expect(description.length).toBeLessThan(LIMITS.description);
    // 5. Never reached: the title and meta values are whole.
    expect(snapshot.title).toHaveLength(LIMITS.title);
    expect(snapshot.meta["og:description"]).toHaveLength(LIMITS.metaValue);
  });

  it("counts JSON escaping: quotes and backslashes in JSON-LD take two bytes each", () => {
    // 594,000 characters, within the character limits, but about 1.19 MB as JSON.
    const head =
      escapingScript("JobPosting", 99_000) +
      escapingScript("BreadcrumbList", 99_000) +
      escapingScript("Organization", 90_000);
    const snapshot = readPage(page("", head), careers, "");
    expect(snapshot.jsonLd.reduce((sum, s) => sum + s.length, 0)).toBeLessThanOrEqual(LIMITS.jsonLdTotal);
    expect(bodyBytes(snapshot)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    // The largest script that is not a posting went first, and that was enough.
    expect(types(snapshot)).toEqual(["JobPosting", "Organization"]);
  });

  it("drops postings too, largest first, when nothing else is left to shed", () => {
    const head = [75_000, 70_000, 65_000, 60_000]
      .map((n) => escapingScript("JobPosting", n).replace("JobPosting", `JobPosting","n":"${n}`))
      .join("");
    const snapshot = readPage(page("", head), careers, "");
    expect(bodyBytes(snapshot)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(snapshot.jsonLd.map((s) => JSON.parse(s).n)).toEqual(["70000", "65000", "60000"]);
  });

  describe("the order, on a smaller budget", () => {
    const snapshot = (selection = "short"): PageSnapshot => ({
      url: "https://careers.example.com/jobs/1",
      canonicalUrl: null,
      title: "T".repeat(1_000),
      meta: { "og:title": "o".repeat(3_000), description: "d".repeat(500) },
      jsonLd: [
        '{"@type":"JobPosting","p":"' + "p".repeat(2_000) + '"}',
        '{"@type":"WebSite","w":"' + "w".repeat(4_000) + '"}',
        '{"@type":"BreadcrumbList","b":"' + "b".repeat(3_000) + '"}',
      ],
      site: { reader: "generic", fields: { description: "x".repeat(5_000) } },
      selection,
    });

    it("first drops the largest script that is not a posting, and nothing else", () => {
      const full = snapshot();
      const out = withinBudget(snapshot(), bodyBytes(full) - 10);
      expect(types(out)).toEqual(["JobPosting", "BreadcrumbList"]);
      expect(out.selection).toBe("short");
      expect(out.site?.fields.description).toHaveLength(5_000);
    });

    it("then the selection: a short one goes, a long one keeps what makes it the description", () => {
      const noScripts = (s: PageSnapshot) => bodyBytes({ ...s, jsonLd: [s.jsonLd[0]] });
      const short = snapshot();
      expect(withinBudget(snapshot(), noScripts(short) - 1).selection).toBe("");

      // Cut only as far as needed …
      const selection = `  ${"a".repeat(199)}      ${"b".repeat(1_000)}  `;
      const some = withinBudget(snapshot(selection), noScripts(snapshot(selection)) - 500);
      expect(some.selection).toBe(selection.trim().slice(0, 709));
      expect(some.site?.fields.description).toHaveLength(5_000);

      // … and never below 200 characters once trimmed: the rest comes from the description.
      const most = withinBudget(snapshot(selection), noScripts(snapshot(selection)) - 3_000);
      expect(most.selection).toBe(`${"a".repeat(199)}      b`);
      expect(most.selection.trim().length).toBeGreaterThanOrEqual(200);
      expect(most.site?.fields.description?.length).toBeLessThan(5_000);
    });

    it("then the description, the postings, and last the meta values and the title", () => {
      const out = withinBudget(snapshot(), 1_500);
      expect(bodyBytes(out)).toBeLessThanOrEqual(1_500);
      expect(out.jsonLd).toEqual([]);
      expect(out.selection).toBe("");
      expect(out.site).toBeNull();
      expect(out.meta["og:title"]?.length ?? 0).toBeLessThan(3_000);
      const metaAndTitle = [out.title, ...Object.values(out.meta)].join("");
      expect(metaAndTitle.length).toBeLessThan(1_500);
    });
  });
});
