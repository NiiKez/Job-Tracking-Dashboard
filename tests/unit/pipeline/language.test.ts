import { describe, expect, it } from "vitest";
import { detectLanguage, primarySubtag, stopwordLanguage } from "@/lib/inbox/pipeline/language";
import type { KeywordHit } from "@/lib/types";

const hit = (language: string): KeywordHit => ({ phrase: `x-${language}`, status: "interview", language });

describe("primarySubtag", () => {
  it.each([
    ["de", "de"],
    ["de-DE", "de"],
    [" EN_us ", "en"],
    ["fr, en", "fr"],
    ["", null],
    [null, null],
    ["x-klingon", null],
    ["english", null],
  ])("%s -> %s", (value, expected) => {
    expect(primarySubtag(value)).toBe(expected);
  });
});

describe("stopwordLanguage", () => {
  const de = "Vielen Dank für Ihr Interesse. Wir melden uns bei Ihnen.";
  const en = "Thank you for your interest. We will get back to you.";

  it("names the language with clearly the most stopwords, among the given ones", () => {
    expect(stopwordLanguage(de, ["en", "de"])).toBe("de");
    expect(stopwordLanguage(en, ["en", "de"])).toBe("en");
    expect(stopwordLanguage(de, ["en"])).toBeNull();
    expect(stopwordLanguage(de, ["xx"])).toBeNull();
  });

  it("needs two stopwords and a lead", () => {
    expect(stopwordLanguage("Danke!", ["en", "de"])).toBeNull();
    expect(stopwordLanguage("the und", ["en", "de"])).toBeNull();
  });
});

describe("detectLanguage", () => {
  const base = { text: "Vielen Dank, wir melden uns bei Ihnen.", languages: ["en", "de"] };

  it("takes the majority of the hits first", () => {
    expect(detectLanguage({ ...base, hits: [hit("en"), hit("de"), hit("en")], contentLanguage: "de" })).toBe("en");
  });

  it("breaks a tie with the later steps, among the tied languages", () => {
    const hits = [hit("en"), hit("fr")];
    expect(detectLanguage({ ...base, hits, contentLanguage: "fr" })).toBe("fr");
    expect(detectLanguage({ ...base, hits, contentLanguage: "de" })).toBe("en"); // de is not tied; first in settings
    expect(detectLanguage({ ...base, hits: [hit("de"), hit("en")], contentLanguage: null })).toBe("de"); // stopwords
    expect(detectLanguage({ ...base, text: "", hits: [hit("fr"), hit("es")], languages: [] })).toBe("fr");
  });

  it("then Content-Language, then stopwords, then the first language in settings", () => {
    expect(detectLanguage({ ...base, hits: [], contentLanguage: "fr-FR" })).toBe("fr");
    expect(detectLanguage({ ...base, hits: [], contentLanguage: "??" })).toBe("de");
    expect(detectLanguage({ ...base, hits: [], text: "OK" })).toBe("en");
    expect(detectLanguage({ hits: [], text: "OK", languages: [] })).toBeNull();
  });
});
