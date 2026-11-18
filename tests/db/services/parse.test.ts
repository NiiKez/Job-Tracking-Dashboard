import { readFileSync } from "node:fs";
import path from "node:path";
import { MockAgent } from "undici";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDb } from "@/lib/server/db/client";
import { FETCHES_PER_WINDOW } from "@/lib/server/parse/rate-limit";
import { setDispatcherForTests } from "@/lib/server/parse/safe-fetch";
import { parseWithHeuristics } from "@/lib/server/parse/text";
import { jobInputSchema } from "@/lib/server/schemas";
import { upsertJob } from "@/lib/server/services/jobs";
import { parseInput } from "@/lib/server/services/parse";
import type { ParseResult } from "@/lib/types";
import { createUser, makeJob } from "../../helpers/factories";
import { describeDb } from "../../helpers/test-db";

// Links are fetched from an undici MockAgent installed as the parser's dispatcher: nothing here
// reaches the network.

const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, "../../fixtures/pages", name), "utf8");

const HTML = { "content-type": "text/html; charset=utf-8" };
const ORIGIN = "https://jobs.example.com";

let mock: MockAgent;

function serve(at: string, body: string) {
  return mock.get(ORIGIN).intercept({ path: at }).reply(200, body, { headers: HTML });
}

/** What the add-job dialog sends back after the user saves the parsed fields unchanged. */
function asJobInput(result: ParseResult) {
  return jobInputSchema.parse({
    title: result.title.trim(),
    company: result.company.trim(),
    location: result.location.trim(),
    url: result.url,
    description: result.description.trim(),
    status: "saved",
  });
}

describeDb("parse service", () => {
  beforeEach(() => {
    mock = new MockAgent();
    mock.disableNetConnect();
    setDispatcherForTests(mock);
    // The parser logs one line per link it could not read.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    setDispatcherForTests(undefined);
    vi.restoreAllMocks();
    await mock.close();
  });

  it("reads pasted text without fetching anything", async () => {
    const user = await createUser();
    const dispatch = vi.spyOn(mock, "dispatch");
    const text = "Title: Frontend Engineer\nCompany: Parcelwerk\nLocation: Berlin\n\nBuild the parcel tracker.";
    expect(await parseInput(getDb(), user, text)).toEqual({
      title: "Frontend Engineer",
      company: "Parcelwerk",
      location: "Berlin",
      url: null,
      description: text,
      missing: ["url"],
      duplicateOf: null,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("finds the duplicate of pasted text by company and title", async () => {
    const user = await createUser();
    const job = await makeJob(user, { company: "Parcelwerk", title: "Frontend Engineer" });
    const result = await parseInput(getDb(), user, "Title: Frontend  Engineer\nCompany: PARCELWERK GmbH");
    expect(result.duplicateOf?.id).toBe(job.id);
    expect(result.duplicateOf?.history).toHaveLength(1);
  });

  it("reads a link's page", async () => {
    const user = await createUser();
    serve("/careers/7", fixture("jsonld-top-level.html"));
    const result = await parseInput(getDb(), user, `${ORIGIN}/careers/7`);
    expect(result).toMatchObject({
      title: "Senior Backend Engineer",
      company: "Quillfeather Systems GmbH",
      location: "Berlin, DE",
      url: `${ORIGIN}/careers/7`,
      missing: [],
      duplicateOf: null,
    });
  });

  it("finds the duplicate by link, whatever the page says", async () => {
    const user = await createUser();
    const job = await makeJob(user, { url: `${ORIGIN}/careers/4711`, company: "Parcelwerk", title: "Frontend Engineer" });
    serve("/careers/4711?utm_source=newsletter", fixture("jsonld-top-level.html"));
    const result = await parseInput(getDb(), user, `${ORIGIN}/careers/4711?utm_source=newsletter`);
    expect(result.title).toBe("Senior Backend Engineer"); // read from the page
    expect(result.duplicateOf?.id).toBe(job.id);
  });

  it("finds the duplicate by the company and title read from the page", async () => {
    const user = await createUser();
    // Saved earlier from pasted text: no link to match.
    const job = await makeJob(user, { company: "Quillfeather Systems", title: "Senior Backend Engineer" });
    serve("/careers/7", fixture("jsonld-top-level.html"));
    const result = await parseInput(getDb(), user, `${ORIGIN}/careers/7`);
    expect(result).toMatchObject({ company: "Quillfeather Systems GmbH", title: "Senior Backend Engineer" });
    expect(result.duplicateOf?.id).toBe(job.id);

    // Another user's job is never a duplicate.
    const other = await createUser();
    serve("/careers/7", fixture("jsonld-top-level.html"));
    expect((await parseInput(getDb(), other, `${ORIGIN}/careers/7`)).duplicateOf).toBeNull();
  });

  it("with fetchLink: false, never opens the link, and still finds its duplicate", async () => {
    const user = await createUser();
    serve("/careers/product-designer-4711", fixture("jsonld-top-level.html")).persist();
    const dispatch = vi.spyOn(mock, "dispatch");
    const link = `${ORIGIN}/careers/product-designer-4711`;

    const fresh = await parseInput(getDb(), user, link, { fetchLink: false });
    expect(fresh).toEqual({ ...parseWithHeuristics(link), duplicateOf: null });
    expect(fresh).toMatchObject({ title: "Product Designer", company: "Example", url: link });

    const job = await makeJob(user, { url: link, company: "Parcelwerk", title: "Frontend Engineer" });
    const again = await parseInput(getDb(), user, `${link}?utm_source=newsletter`, { fetchLink: false });
    expect(again.duplicateOf?.id).toBe(job.id);
    expect(dispatch).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("counts link fetches per user", async () => {
    const [ada, ben] = [await createUser(), await createUser()];
    serve("/careers/7", fixture("jsonld-top-level.html")).persist();
    const link = `${ORIGIN}/careers/7`;
    for (let i = 0; i < FETCHES_PER_WINDOW; i++) {
      expect((await parseInput(getDb(), ada, link)).title).toBe("Senior Backend Engineer");
    }
    // Over the limit: the heuristics on the link, no fetch.
    const limited = await parseInput(getDb(), ada, link);
    expect(limited).toEqual({ ...parseWithHeuristics(link), duplicateOf: null });
    expect(console.warn).toHaveBeenLastCalledWith("[parse] link not read: jobs.example.com rate-limited");
    // Another user's budget is untouched.
    expect((await parseInput(getDb(), ben, link)).title).toBe("Senior Backend Engineer");
  });

  it("returns fields that save as they are, however large the page or the paste", async () => {
    const user = await createUser();
    const posting = {
      "@type": "JobPosting",
      title: `Lead\u0000 ${"Engineer ".repeat(100)}`,
      hiringOrganization: `${"Ü".repeat(150)}😀${"Ä".repeat(150)}`,
      jobLocation: { address: `${"Platz ".repeat(100)}` },
      description: `<p>${"Some text. ".repeat(10_000)}</p>`,
    };
    serve("/careers/huge", `<script type="application/ld+json">${JSON.stringify(posting)}</script>`);
    const fromPage = await parseInput(getDb(), user, `${ORIGIN}/careers/huge`);

    const paste = `Title: Data\u0000 ${"Analyst ".repeat(100)}\nCompany: ${"Brightmoor ".repeat(50)}\nLocation: ${"Leipzig ".repeat(50)}\n\n${"More text. ".repeat(4_000)}`;
    const fromPaste = await parseInput(getDb(), user, paste);

    for (const result of [fromPage, fromPaste]) {
      const { job } = await upsertJob(user, asJobInput(result));
      expect(job).toMatchObject({ title: result.title, company: result.company, location: result.location });
      expect(job.description).toBe(result.description);
    }
  });
});
