import { describe, expect, it } from "vitest";
import { extractJobPage } from "@/lib/server/parse/extract";
import { MAX_DESCRIPTION, MAX_FIELD, clamp, fit } from "@/lib/server/parse/limits";
import { toResult } from "@/lib/server/parse/text";
import { jobInputSchema } from "@/lib/server/schemas";

const job = (fields: Record<string, string>) => ({
  title: "Engineer",
  company: "Acme",
  status: "saved",
  ...fields,
});

describe("the parser's limits", () => {
  it.each(["title", "company", "location"])("are the job input limit for %s", (field) => {
    expect(jobInputSchema.safeParse(job({ [field]: "x".repeat(MAX_FIELD) })).success).toBe(true);
    expect(jobInputSchema.safeParse(job({ [field]: "x".repeat(MAX_FIELD + 1) })).success).toBe(false);
  });

  it("are the job input limit for the description", () => {
    expect(jobInputSchema.safeParse(job({ description: "x".repeat(MAX_DESCRIPTION) })).success).toBe(true);
    expect(jobInputSchema.safeParse(job({ description: "x".repeat(MAX_DESCRIPTION + 1) })).success).toBe(false);
  });

  it("count UTF-16 units like the schema, so a cut field never exceeds it", () => {
    const title = clamp("😀".repeat(MAX_FIELD), MAX_FIELD);
    expect(title).toHaveLength(MAX_FIELD);
    expect(jobInputSchema.safeParse(job({ title })).success).toBe(true);
  });
});

describe("clamp and fit", () => {
  it("never cut a surrogate pair in half", () => {
    expect(clamp(`ab😀`, 3)).toBe("ab");
    expect(clamp(`ab😀`, 4)).toBe("ab😀");
  });

  it("trim, drop NUL and cut", () => {
    expect(fit("  a\u0000b  ", 10)).toBe("ab");
    expect(fit(` ${"x".repeat(20)} `, 5)).toBe("xxxxx");
    expect(fit("abc   def", 5)).toBe("abc");
    expect(fit(undefined, 5)).toBe("");
  });

  it.each([
    ["Engineer \ud83d", 50, "Engineer \ufffd"],
    ["\ude00 Acme", 50, "\ufffd Acme"],
    ["a\ude00\ud83d b", 50, "a\ufffd\ufffd b"], // a pair the wrong way round
    [`${"x".repeat(9)}\ud83d`, 10, `${"x".repeat(9)}\ufffd`],
    [`${"x".repeat(9)}\ud83d\ude00`, 10, "x".repeat(9)],
    ["ok 😀", 50, "ok 😀"],
  ])("replace lone surrogates with U+FFFD, as the database would: %j", (value, max, expected) => {
    expect(fit(value, max)).toBe(expected);
    expect(fit(value, max).isWellFormed()).toBe(true);
  });
});

describe("a parsed page", () => {
  it("gives well-formed fields when the page has half an emoji in each", () => {
    // JSON escapes for lone surrogates in every field.
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Engineer \\ud83d","hiringOrganization":"Acme \\ude00","jobLocation":"Berlin \\ud83d","description":"<p>Hi \\ud83d</p>"}</script>`;
    const result = toResult(extractJobPage(html));
    expect(result).toMatchObject({
      title: "Engineer \ufffd",
      company: "Acme \ufffd",
      location: "Berlin \ufffd",
      description: "Hi \ufffd",
    });
    expect(jobInputSchema.safeParse({ ...result, status: "saved" }).success).toBe(true);
  });
});
