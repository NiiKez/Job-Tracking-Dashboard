import { describe, expect, it } from "vitest";
import { MAX_DESCRIPTION, MAX_FIELD } from "@/lib/server/parse/limits";
import { parseText, parseUrl, parseWithHeuristics } from "@/lib/server/parse/text";

describe("link heuristics on odd links", () => {
  it.each([
    "https://jobs.example.com/careers/a%E0%A4%A-engineer", // malformed UTF-8 escape
    "https://jobs.example.com/careers/backend-%-engineer",
    "https://boards.greenhouse.io/%E0%A4%A/jobs/4711",
  ])("does not throw on a malformed %% escape: %s", (link) => {
    expect(() => parseUrl(link)).not.toThrow();
    expect(parseWithHeuristics(link).url).toBe(link);
  });

  it("keeps a malformed escape as it is", () => {
    expect(parseUrl("https://jobs.example.com/careers/backend-%E0%A4%A-engineer").title).toBe(
      "Backend %E0%A4%A Engineer",
    );
  });

  it("never puts control characters (NUL above all) into a field", () => {
    const result = parseWithHeuristics("https://jobs.example.com/careers/senior%00-backend%07-engineer");
    expect(result.title).toBe("Senior Backend Engineer");
    expect(JSON.stringify(result)).not.toMatch(/\\u000/);
  });

  it("reads a 50,000-character path segment quickly", () => {
    // The mock's /[a-z].*-.*[a-z]/i took about two seconds on this.
    const started = Date.now();
    const result = parseUrl(`https://jobs.example.com/${"a".repeat(50_000)}`);
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.title).toBeUndefined();
  });

  it("picks the same slug as the mock's expression", () => {
    const mockTest = (p: string) => /[a-z].*-.*[a-z]/i.test(p) && !/^jobs?$/i.test(p);
    // A fixed pseudo-random sample of short segments over the characters that matter.
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31);
    const alphabet = "aZ1-_";
    for (let i = 0; i < 3_000; i++) {
      const segment = Array.from({ length: next() % 9 }, () => alphabet[next() % alphabet.length]).join("");
      const url = new URL(`https://jobs.example.com/${segment}`);
      const parsed = url.pathname.slice(1);
      expect("title" in parseUrl(url.href), JSON.stringify(parsed)).toBe(mockTest(parsed));
    }
  });
});

describe("caps on pasted text", () => {
  it("cuts every field to the job input limits", () => {
    const text = [
      `Title: ${"T".repeat(5_000)}`,
      `Company: ${"C".repeat(5_000)}`,
      `Location: ${"L".repeat(5_000)}`,
      "x".repeat(60_000),
    ].join("\n");
    const result = parseWithHeuristics(text);
    expect(result.title).toHaveLength(MAX_FIELD);
    expect(result.company).toHaveLength(MAX_FIELD);
    expect(result.location).toHaveLength(MAX_FIELD);
    expect(result.description).toHaveLength(MAX_DESCRIPTION);
    expect(result.missing).toEqual(["url"]);
  });

  it("drops NUL characters, which PostgreSQL text cannot hold", () => {
    const result = parseWithHeuristics("Title: Data\u0000 Analyst\nCompany: Brightmoor\n\nWe\u0000 analyse.");
    expect(result).toMatchObject({ title: "Data Analyst", company: "Brightmoor" });
    expect(result.description).toBe("Title: Data Analyst\nCompany: Brightmoor\n\nWe analyse.");
  });

  it("leaves ordinary text as the mock returned it", () => {
    const text = "Senior Backend Engineer\nCompany: Quillfeather Systems\nLocation: Berlin\n\nWe build things.";
    expect(parseWithHeuristics(text)).toEqual({
      ...parseText(text),
      url: null,
      missing: ["url"],
    });
  });
});
