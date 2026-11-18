import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, DEFAULT_USER_SETTINGS } from "@/lib/domain/defaults";

// What a new user gets at first sign-in is pinned with the database: tests/db/auth/users.test.ts
// (the settings row and these rules) and tests/db/services/rules-settings.test.ts (the settings
// as the API returns them, inbox not connected).

describe("defaults", () => {
  it("has the settings a new user starts with", () => {
    expect(DEFAULT_USER_SETTINGS).toEqual({
      noResponseDays: 30,
      createFromConfirmation: true,
      reviewUncertain: true,
      languages: ["en", "de"],
      inboxIntervalMinutes: 15,
    });
  });

  it("has the 70 rules a new user starts with", () => {
    expect(DEFAULT_RULES).toEqual([
      { status: "applied", phrase: "thank you for applying", language: "en" },
      { status: "applied", phrase: "thanks for applying", language: "en" },
      { status: "applied", phrase: "thank you for your application", language: "en" },
      { status: "applied", phrase: "we received your application", language: "en" },
      { status: "applied", phrase: "we have received your application", language: "en" },
      { status: "applied", phrase: "your application has been received", language: "en" },
      { status: "applied", phrase: "dank für ihre bewerbung", language: "de" },
      { status: "applied", phrase: "dank für deine bewerbung", language: "de" },
      { status: "applied", phrase: "danke für ihre bewerbung", language: "de" },
      { status: "applied", phrase: "danke für deine bewerbung", language: "de" },
      { status: "applied", phrase: "bewerbung erhalten", language: "de" },
      { status: "applied", phrase: "wir haben ihre bewerbung", language: "de" },
      { status: "applied", phrase: "wir haben deine bewerbung", language: "de" },
      { status: "applied", phrase: "bewerbung ist eingegangen", language: "de" },
      { status: "applied", phrase: "bei uns eingegangen", language: "de" },
      { status: "applied", phrase: "eingang ihrer bewerbung", language: "de" },
      { status: "applied", phrase: "eingang deiner bewerbung", language: "de" },
      { status: "applied", phrase: "bewerbung wurde weitergeleitet", language: "de" },
      { status: "applied", phrase: "bei uns beworben", language: "de" },
      { status: "applied", phrase: "eingangsbestätigung", language: "de" },
      { status: "interview", phrase: "interview", language: "en" },
      { status: "interview", phrase: "schedule a call", language: "en" },
      { status: "interview", phrase: "availability", language: "en" },
      { status: "interview", phrase: "vorstellungsgespräch", language: "de" },
      { status: "interview", phrase: "bewerbungsgespräch", language: "de" },
      { status: "interview", phrase: "kennenlerngespräch", language: "de" },
      { status: "interview", phrase: "erstgespräch", language: "de" },
      { status: "interview", phrase: "gerne persönlich kennenlernen", language: "de" },
      { status: "interview", phrase: "gerne kennenlernen", language: "de" },
      { status: "interview", phrase: "näher kennenlernen", language: "de" },
      { status: "interview", phrase: "einladung zum", language: "de" },
      { status: "interview", phrase: "einladung zu einem", language: "de" },
      { status: "interview", phrase: "terminvorschlag", language: "de" },
      { status: "offer", phrase: "pleased to offer", language: "en" },
      { status: "offer", phrase: "offer letter", language: "en" },
      { status: "offer", phrase: "arbeitsvertrag", language: "de" },
      { status: "offer", phrase: "vertragsangebot", language: "de" },
      { status: "offer", phrase: "vertragsunterlagen", language: "de" },
      { status: "offer", phrase: "einstellungszusage", language: "de" },
      { status: "rejected", phrase: "unfortunately", language: "en" },
      { status: "rejected", phrase: "other candidates", language: "en" },
      { status: "rejected", phrase: "not moving forward", language: "en" },
      { status: "rejected", phrase: "decided to pursue", language: "en" },
      { status: "rejected", phrase: "not selected", language: "en" },
      { status: "rejected", phrase: "regret to inform", language: "en" },
      { status: "rejected", phrase: "position has been filled", language: "en" },
      { status: "rejected", phrase: "nicht weiter berücksichtigen", language: "de" },
      { status: "rejected", phrase: "nicht berücksichtigen", language: "de" },
      { status: "rejected", phrase: "nicht berücksichtigt", language: "de" },
      { status: "rejected", phrase: "anderen kandidaten", language: "de" },
      { status: "rejected", phrase: "andere kandidaten", language: "de" },
      { status: "rejected", phrase: "andere kandidat:innen", language: "de" },
      { status: "rejected", phrase: "andere kandidatinnen", language: "de" },
      { status: "rejected", phrase: "andere bewerber", language: "de" },
      { status: "rejected", phrase: "anderen bewerber", language: "de" },
      { status: "rejected", phrase: "nicht in die engere wahl", language: "de" },
      { status: "rejected", phrase: "eine absage", language: "de" },
      { status: "rejected", phrase: "unsere absage", language: "de" },
      { status: "rejected", phrase: "diese absage", language: "de" },
      { status: "rejected", phrase: "als absage", language: "de" },
      { status: "rejected", phrase: "leider mitteilen", language: "de" },
      { status: "rejected", phrase: "keine passende position", language: "de" },
      { status: "rejected", phrase: "keine passende stelle", language: "de" },
      { status: "rejected", phrase: "nicht anbieten können", language: "de" },
      { status: "rejected", phrase: "nicht fortzuführen", language: "de" },
      { status: "rejected", phrase: "nicht weiterverfolgen", language: "de" },
      { status: "rejected", phrase: "bereits besetzt", language: "de" },
      { status: "rejected", phrase: "anderweitig besetzt", language: "de" },
      { status: "rejected", phrase: "weiteren beruflichen", language: "de" },
      { status: "rejected", phrase: "weiteren berufsweg", language: "de" },
    ]);
    const keys = DEFAULT_RULES.map((r) => `${r.status}:${r.phrase}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
