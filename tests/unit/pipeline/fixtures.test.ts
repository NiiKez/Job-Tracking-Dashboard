import { describe, expect, it } from "vitest";
import { RULE_FIXTURES } from "../../fixtures/rules/mail";
import { classify, effectOf } from "./support";

// Every invented mail in tests/fixtures/rules, end to end. The rule tests (rules.test.ts) say
// why each one comes out as it does.

describe("rule fixtures", () => {
  it("cover English, German and other languages, with unique keys", () => {
    const written = new Set(RULE_FIXTURES.map((f) => f.written));
    expect([...written]).toEqual(expect.arrayContaining(["en", "de"]));
    expect([...written].filter((l) => l !== "en" && l !== "de").length).toBeGreaterThanOrEqual(2);
    expect(new Set(RULE_FIXTURES.map((f) => f.key)).size).toBe(RULE_FIXTURES.length);
  });

  it.each(RULE_FIXTURES.map((f) => [f.key, f] as const))("%s", (_key, fixture) => {
    const result = classify(fixture.mail, fixture.context);
    expect({
      outcome: result.outcome,
      status: result.status,
      reviewReason: result.reviewReason,
      language: result.language,
      effect: effectOf(result),
    }).toEqual(fixture.expected);
  });
});
