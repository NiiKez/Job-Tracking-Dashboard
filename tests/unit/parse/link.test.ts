import { readFileSync } from "node:fs";
import path from "node:path";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobInputParser, parseJobInput } from "@/lib/server/parse/link";
import { MAX_DESCRIPTION, MAX_FIELD } from "@/lib/server/parse/limits";
import { createRateLimiter } from "@/lib/server/parse/rate-limit";
import { MAX_BODY_BYTES } from "@/lib/server/parse/safe-fetch";
import { parseWithHeuristics } from "@/lib/server/parse/text";
import { jobInputSchema } from "@/lib/server/schemas";

const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, "../../fixtures/pages", name), "utf8");

const HTML = { "content-type": "text/html; charset=utf-8" };
const ORIGIN = "https://jobs.example.com";
const LINK = `${ORIGIN}/careers/berlin/product-designer-4411`;
const LINK_PATH = "/careers/berlin/product-designer-4411";

let mock: MockAgent;
let log: ReturnType<typeof vi.fn<(line: string) => void>>;

function parser(opts: { limit?: number; timeoutMs?: number } = {}) {
  return createJobInputParser({
    fetch: { dispatcher: mock, timeoutMs: opts.timeoutMs },
    limiter: createRateLimiter({ limit: opts.limit ?? 100 }),
    log,
  });
}

function serve(body: string, headers: Record<string, string> = HTML, status = 200, at = LINK_PATH) {
  return mock.get(ORIGIN).intercept({ path: at }).reply(status, body, { headers });
}

beforeEach(() => {
  mock = new MockAgent();
  mock.disableNetConnect();
  log = vi.fn<(line: string) => void>();
});

afterEach(() => mock.close());

describe("the link heuristics (today's parser)", () => {
  it("pins what the fallback returns for the test link", () => {
    expect(parseWithHeuristics(LINK)).toEqual({
      title: "Product Designer",
      company: "Example",
      location: "Berlin",
      url: LINK,
      description: "",
      missing: ["description"],
    });
  });
});

describe("pasted text", () => {
  it.each([
    "Senior Backend Engineer\nCompany: Quillfeather Systems\nLocation: Berlin\n\nWe build things.",
    `Product Designer at Fernwood Labs\n${LINK}`,
    `${LINK} ${LINK}`,
  ])("uses the heuristics only and never fetches: %j", async (text) => {
    const dispatch = vi.spyOn(mock, "dispatch");
    expect(await parser()(text)).toEqual(parseWithHeuristics(text));
    expect(dispatch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("a link that is not opened (fetchLink: false)", () => {
  it("takes the fields from the link's own text, without a request, a log line or the budget", async () => {
    // A page is there to be read: the option alone keeps the parser from asking for it.
    serve(fixture("jsonld-top-level.html")).persist();
    const dispatch = vi.spyOn(mock, "dispatch");
    const parse = parser({ limit: 1 });

    expect(await parse(LINK, { fetchLink: false, rateLimitKey: "u" })).toEqual({
      title: "Product Designer",
      company: "Example",
      location: "Berlin",
      url: LINK,
      description: "",
      missing: ["description"],
    });
    expect(await parse(`${ORIGIN}/r0`, { fetchLink: false, rateLimitKey: "u" })).toEqual(
      parseWithHeuristics(`${ORIGIN}/r0`),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();

    // The one fetch the budget allows is still there.
    expect((await parse(LINK, { rateLimitKey: "u" })).title).toBe("Senior Backend Engineer");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("reads job-board links as the fallback does", async () => {
    const dispatch = vi.spyOn(mock, "dispatch");
    const link = "https://boards.greenhouse.io/northwind-labs/jobs/4821930-senior-frontend-engineer";
    expect(await parser()(link, { fetchLink: false })).toMatchObject({
      company: "Northwind Labs",
      title: "Senior Frontend Engineer",
      url: link,
    });
    expect(await parser()(link, { fetchLink: false })).toEqual(parseWithHeuristics(link));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("changes nothing for pasted text", async () => {
    const text = `Product Designer at Fernwood Labs\n${LINK}`;
    expect(await parser()(text, { fetchLink: false })).toEqual(parseWithHeuristics(text));
  });
});

describe("a link that is read", () => {
  it("takes the fields from the page", async () => {
    serve(fixture("jsonld-top-level.html"));
    const result = await parser()(LINK);
    expect(result).toMatchObject({
      title: "Senior Backend Engineer",
      company: "Quillfeather Systems GmbH",
      location: "Berlin, DE",
      url: LINK,
      missing: [],
    });
    expect(result.description).toMatch(/^We build route planning/);
    expect(log).not.toHaveBeenCalled();
  });

  it("fills blanks from the link heuristics", async () => {
    serve(fixture("opengraph-only.html"));
    expect(await parser()(LINK)).toEqual({
      title: "Product Designer",
      company: "Fernwood Labs",
      location: "Berlin", // not on the page: from the link
      url: LINK,
      description: "Fernwood Labs is hiring a product designer for its planning tools & dashboards.",
      missing: [],
    });
  });

  it("uses <title> and keeps what the page lacks missing", async () => {
    serve(fixture("title-only.html"));
    expect(await parser()(LINK)).toEqual({
      title: "Data Analyst - Brightmoor Analytics",
      company: "Example",
      location: "Berlin",
      url: LINK,
      description: "",
      missing: ["description"],
    });
  });

  it("keeps the link the user gave after redirects", async () => {
    mock
      .get(ORIGIN)
      .intercept({ path: LINK_PATH })
      .reply(301, "", { headers: { location: "https://apply.example.com/j/77" } });
    mock.get("https://apply.example.com").intercept({ path: "/j/77" }).reply(200, fixture("jsonld-graph.html"), {
      headers: HTML,
    });
    const result = await parser()(`  ${LINK}  `);
    expect(result.url).toBe(LINK);
    expect(result.title).toBe("Warehouse Data Analyst (m/f/d)");
  });

  it("returns the heuristics when the page has no job data", async () => {
    serve("<!doctype html><p>Nothing here</p>");
    expect(await parser()(LINK)).toEqual(parseWithHeuristics(LINK));
  });
});

describe("any failure falls back to exactly the heuristics", () => {
  const SECRET = "PAGE-TEXT-THAT-MUST-NOT-LEAK";

  it.each([
    ["HTTP error", () => serve(`<title>${SECRET}</title>`, HTML, 404), "http-status"],
    ["server error", () => serve(SECRET, HTML, 500), "http-status"],
    ["not HTML", () => serve(`{"title":"${SECRET}"}`, { "content-type": "application/json" }), "content-type"],
    ["too large", () => serve(`<title>${SECRET}</title>`.padEnd(MAX_BODY_BYTES + 10, " "), HTML), "too-large"],
    [
      "redirect to a private address",
      () => serve("", { location: "http://192.168.0.1/admin" }, 302),
      "blocked-address",
    ],
    [
      "redirect to another scheme",
      () => serve("", { location: "file:///etc/passwd" }, 302),
      "scheme",
    ],
    [
      "too many redirects",
      () => {
        serve("", { location: "/r1" }, 302);
        for (let i = 1; i <= 4; i++) serve("", { location: `/r${i + 1}` }, 302, `/r${i}`);
      },
      "too-many-redirects",
    ],
    ["network error", () => mock.get(ORIGIN).intercept({ path: LINK_PATH }).replyWithError(new Error(SECRET)), "network"],
  ])("%s", async (_name, setup, reason) => {
    setup();
    expect(await parser()(LINK)).toEqual(parseWithHeuristics(LINK));
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0];
    expect(line).toMatch(new RegExp(`^\\[parse\\] link not read: [\\w.\\[\\]:-]+ ${reason}$`));
    expect(line).not.toContain(SECRET);
  });

  it("timeout", async () => {
    serve(`<title>${SECRET}</title>`).delay(2_000);
    expect(await parser({ timeoutMs: 100 })(LINK)).toEqual(parseWithHeuristics(LINK));
    expect(log).toHaveBeenCalledExactlyOnceWith("[parse] link not read: jobs.example.com timeout");
  });

  it.each([
    ["http://127.0.0.1/jobs/backend-engineer", "blocked-address"],
    ["http://2130706433/jobs/backend-engineer", "blocked-address"],
    ["http://[::1]/jobs/backend-engineer", "blocked-address"],
    ["http://169.254.169.254/latest/meta-data", "blocked-address"],
    ["https://user:pw@jobs.example.com/backend-engineer", "credentials"],
    ["https://jobs.example.com:8443/backend-engineer", "port"],
    ["http://localhost/backend-engineer", "blocked-address"],
    ["https://[fe80::1%25eth0]/backend-engineer", "invalid-link"],
  ])("refuses %s before any request", async (link, reason) => {
    const dispatch = vi.spyOn(mock, "dispatch");
    expect(await parser()(link)).toEqual(parseWithHeuristics(link));
    expect(dispatch).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toMatch(new RegExp(` ${reason}$`));
  });
});

describe("a hostile page or link still gives a result the dialog can save", () => {
  function expectSavable(result: Awaited<ReturnType<ReturnType<typeof parser>>>) {
    for (const field of ["title", "company", "location"] as const) {
      expect(result[field].length, field).toBeLessThanOrEqual(MAX_FIELD);
    }
    expect(result.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(JSON.stringify(result)).not.toContain("\\u0000");
    expect(jobInputSchema.safeParse({ ...result, status: "saved" }).error).toBeUndefined();
  }

  it("caps every field read from a page", async () => {
    const posting = {
      "@type": "JobPosting",
      // A NUL, and an emoji across the 200-character boundary.
      title: `\u0000${"a".repeat(MAX_FIELD - 1)}😀 and more`,
      hiringOrganization: { name: "Acme\u0000 ".repeat(10_000) },
      jobLocation: Array.from({ length: 2_000 }, (_, i) => ({ address: { addressLocality: `Town ${i}` } })),
      description: `<p>${"word ".repeat(250_000)}</p>`,
    };
    const html = [
      `<title>${"T".repeat(100_000)}</title>`,
      `<meta property="og:site_name" content="${"S".repeat(100_000)}">`,
      `<meta property="og:title" content="${"O".repeat(100_000)} | ${"S".repeat(100_000)}">`,
      `<script type="application/ld+json">${JSON.stringify(posting)}</script>`,
    ].join("");
    expect(html.length).toBeLessThan(MAX_BODY_BYTES);
    serve(html);
    const result = await parser()(LINK);
    expect(result.title).toBe("a".repeat(MAX_FIELD - 1));
    expect(result.company).toMatch(/^Acme Acme /);
    expect(result.company.length).toBeGreaterThan(MAX_FIELD - 5); // cut, then trimmed
    expect(result.location).toMatch(/^Town 0; Town 1; /);
    expect(result.description.length).toBeGreaterThan(MAX_DESCRIPTION - 10);
    expectSavable(result);
  });

  it("caps OpenGraph and <title> fields", async () => {
    serve(
      `<title>${"T ".repeat(50_000)}</title><meta property="og:description" content="${"D ".repeat(100_000)}">`,
    );
    const result = await parser()(LINK);
    expect(result.title).toHaveLength(MAX_FIELD - 1); // the trailing space is trimmed
    expectSavable(result);
  });

  it("caps fields the link heuristics fill", async () => {
    const at = `/careers/${"backend-".repeat(500)}engineer`;
    serve("<p>Nothing to read</p>", HTML, 200, at);
    const result = await parser()(`${ORIGIN}${at}`);
    expect(result.title).toMatch(/^Backend Backend /);
    expectSavable(result);
  });

  it("does not throw on a link with a malformed %% escape, and still reads it", async () => {
    const at = "/careers/backend-%E0%A4%A-engineer";
    serve(fixture("jsonld-top-level.html"), HTML, 200, at);
    const result = await parser()(`${ORIGIN}${at}`);
    expect(result.title).toBe("Senior Backend Engineer");
  });
});

describe("the production parser under Vitest", () => {
  it("fetches nothing and falls back to the heuristics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await parseJobInput(LINK, { rateLimitKey: "test-user" })).toEqual(parseWithHeuristics(LINK));
      expect(warn).toHaveBeenCalledExactlyOnceWith("[parse] link not read: jobs.example.com offline");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("rate limit", () => {
  it("skips the fetch over the limit, per key", async () => {
    serve(fixture("jsonld-top-level.html")).persist();
    const parse = parser({ limit: 1 });

    expect((await parse(LINK, { rateLimitKey: "user-a" })).title).toBe("Senior Backend Engineer");
    expect(await parse(LINK, { rateLimitKey: "user-a" })).toEqual(parseWithHeuristics(LINK));
    expect(log).toHaveBeenLastCalledWith("[parse] link not read: jobs.example.com rate-limited");
    expect((await parse(LINK, { rateLimitKey: "user-b" })).title).toBe("Senior Backend Engineer");
  });

  it("shares one budget when no key is given", async () => {
    serve(fixture("jsonld-top-level.html")).persist();
    const parse = parser({ limit: 1 });
    await parse(LINK);
    expect(await parse(LINK)).toEqual(parseWithHeuristics(LINK));
  });

  it("does not count pasted text", async () => {
    serve(fixture("jsonld-top-level.html"));
    const parse = parser({ limit: 1 });
    await parse("Some pasted job text", { rateLimitKey: "u" });
    expect((await parse(LINK, { rateLimitKey: "u" })).title).toBe("Senior Backend Engineer");
  });

  it("counts every redirect as a request", async () => {
    // Each hop could go to another host, so a budget of 3 allows the link and two redirects.
    mock.get(ORIGIN).intercept({ path: "/r0" }).reply(302, "", { headers: { location: "/r1" } });
    mock.get(ORIGIN).intercept({ path: "/r1" }).reply(302, "", { headers: { location: "/r2" } });
    mock.get(ORIGIN).intercept({ path: "/r2" }).reply(302, "", { headers: { location: LINK_PATH } });
    const dispatch = vi.spyOn(mock, "dispatch");
    const parse = parser({ limit: 3 });

    expect(await parse(`${ORIGIN}/r0`, { rateLimitKey: "u" })).toEqual(parseWithHeuristics(`${ORIGIN}/r0`));
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenLastCalledWith("[parse] link not read: jobs.example.com rate-limited");
  });
});

describe("a redirect to a parent page (a closed posting)", () => {
  it.each(["/careers", "/careers/berlin/", "/"])("falls back to the heuristics: %s", async (parent) => {
    mock.get(ORIGIN).intercept({ path: LINK_PATH }).reply(302, "", { headers: { location: parent } });
    serve("<title>Jobs at Example</title><meta property='og:description' content='All our openings'>", HTML, 200, parent);

    expect(await parser()(LINK)).toEqual(parseWithHeuristics(LINK));
    expect(log).toHaveBeenLastCalledWith("[parse] link not read: jobs.example.com redirected-to-parent");
  });

  it.each([`${LINK_PATH}/`, `${LINK_PATH}?lang=en`, `/en${LINK_PATH}`])("still reads a moved posting: %s", async (to) => {
    mock.get(ORIGIN).intercept({ path: LINK_PATH }).reply(301, "", { headers: { location: to } });
    serve(fixture("jsonld-top-level.html"), HTML, 200, to);

    expect((await parser()(LINK)).title).toBe("Senior Backend Engineer");
  });
});
