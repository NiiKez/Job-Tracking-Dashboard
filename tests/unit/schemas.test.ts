import { describe, expect, it } from "vitest";
import { MAX_NAME } from "@/lib/server/inbox/parse/address";
import { MAX_BODY, MAX_SUBJECT } from "@/lib/server/inbox/parse/gmail-message";
import {
  CLASSIFY_LIMITS,
  classifyInputSchema,
  MAX_SETTINGS_LANGUAGES,
  ruleInputSchema,
  settingsPatchSchema,
} from "@/lib/server/schemas";

// The caps on the request bodies a visitor could otherwise make as large as they like: the
// settings' languages and the rule tester's input. Each is accepted at the cap and refused above.

describe("settingsPatchSchema languages", () => {
  const ok = (languages: unknown) => settingsPatchSchema.safeParse({ languages }).success;
  const codes = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);

  it("takes up to MAX_SETTINGS_LANGUAGES codes, and an empty list", () => {
    expect(MAX_SETTINGS_LANGUAGES).toBe(20);
    expect(ok([])).toBe(true);
    expect(ok(["en", "de"])).toBe(true);
    expect(ok(codes(MAX_SETTINGS_LANGUAGES))).toBe(true);
    expect(ok(codes(MAX_SETTINGS_LANGUAGES + 1))).toBe(false);
  });

  it("takes each code as a keyword rule does: 2 to 5 characters after trimming", () => {
    expect(ok(["pt-BR"])).toBe(true);
    expect(ok(["pt-BRX"])).toBe(false);
    expect(ok(["e"])).toBe(false);
    expect(ok(["   "])).toBe(false);
    expect(ok([42])).toBe(false);
    expect(settingsPatchSchema.parse({ languages: [" en ", "de"] }).languages).toEqual(["en", "de"]);
    // Same rule as the language of a new keyword rule, which joins this list.
    for (const language of ["pt-BR", "pt-BRX", "e"]) {
      expect(ruleInputSchema.safeParse({ status: "applied", phrase: "thanks", language }).success).toBe(ok([language]));
    }
  });

  it("leaves the other settings as they were", () => {
    expect(settingsPatchSchema.parse({ noResponseDays: 30 })).toEqual({ noResponseDays: 30 });
  });
});

describe("classifyInputSchema", () => {
  const ok = (fields: Record<string, unknown>) => classifyInputSchema.safeParse(fields).success;

  it("keeps its defaults", () => {
    expect(classifyInputSchema.parse({})).toEqual({ fromAddress: "", subject: "", body: "" });
  });

  it.each(Object.entries(CLASSIFY_LIMITS))("takes %s up to %i characters", (field, max) => {
    expect(ok({ [field]: "x".repeat(max) })).toBe(true);
    expect(ok({ [field]: "x".repeat(max + 1) })).toBe(false);
  });

  it("takes every field at its cap together", () => {
    const all = Object.fromEntries(Object.entries(CLASSIFY_LIMITS).map(([field, max]) => [field, "x".repeat(max)]));
    expect(ok(all)).toBe(true);
  });

  it("takes the headers the inbox keeps of a real message, and more body than it keeps", () => {
    expect(CLASSIFY_LIMITS.fromName).toBe(MAX_NAME);
    expect(CLASSIFY_LIMITS.subject).toBe(MAX_SUBJECT);
    expect(CLASSIFY_LIMITS.body).toBeGreaterThan(MAX_BODY);
  });
});
