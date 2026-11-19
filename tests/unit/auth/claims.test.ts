import { describe, expect, it } from "vitest";
import { validateIdTokenClaims } from "@/lib/server/auth/google";

const CLIENT_ID = "1234-test.apps.googleusercontent.com";
const NOW = new Date("2026-11-16T12:00:00Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

/** Claims as Google issues them for this client, with overrides (undefined removes a claim). */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    iss: "https://accounts.google.com",
    azp: CLIENT_ID,
    aud: CLIENT_ID,
    sub: "110169484474386276334",
    email: "Owner@Example.com",
    email_verified: true,
    name: "Olive Owner",
    picture: "https://lh3.googleusercontent.com/a/photo",
    iat: nowSeconds - 10,
    exp: nowSeconds + 3600,
  };
  const merged = { ...base, ...overrides };
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  return merged;
}

const check = (c: unknown) => validateIdTokenClaims(c, { clientId: CLIENT_ID, now: NOW });
const problem = (c: unknown) => {
  const result = check(c);
  return result.ok ? "ok" : result.problem;
};

describe("validateIdTokenClaims", () => {
  it("accepts Google's claims and returns the profile with the email lower-cased", () => {
    expect(check(claims())).toEqual({
      ok: true,
      profile: {
        sub: "110169484474386276334",
        email: "owner@example.com",
        name: "Olive Owner",
        picture: "https://lh3.googleusercontent.com/a/photo",
      },
    });
  });

  it("trims the email and defaults a missing name and picture", () => {
    const result = check(claims({ email: "  owner@example.com ", name: undefined, picture: undefined }));
    expect(result).toEqual({
      ok: true,
      profile: { sub: "110169484474386276334", email: "owner@example.com", name: "", picture: null },
    });
  });

  it("drops a picture that is not an https URL", () => {
    for (const picture of ["http://example.com/a.png", "javascript:alert(1)", "not a url", 42]) {
      const result = check(claims({ picture }));
      expect(result.ok && result.profile.picture).toBeNull();
    }
  });

  describe("iss", () => {
    it.each(["https://accounts.google.com", "accounts.google.com"])("accepts %s", (iss) => {
      expect(problem(claims({ iss }))).toBe("ok");
    });

    it.each([
      "https://accounts.google.com/",
      "http://accounts.google.com",
      "https://evil.example.com",
      "",
      undefined,
      42,
    ])("refuses %s", (iss) => {
      expect(problem(claims({ iss }))).toBe("issuer");
    });
  });

  describe("aud and azp", () => {
    it("accepts aud equal to the client id without azp", () => {
      expect(problem(claims({ azp: undefined }))).toBe("ok");
    });

    it("refuses another client's token", () => {
      expect(problem(claims({ aud: "other.apps.googleusercontent.com", azp: undefined }))).toBe("audience");
    });

    it("refuses a missing or non-string aud", () => {
      expect(problem(claims({ aud: undefined }))).toBe("audience");
      expect(problem(claims({ aud: 1234 }))).toBe("audience");
    });

    it("accepts an aud array that contains the client id when azp is the client id", () => {
      expect(problem(claims({ aud: [CLIENT_ID, "other"], azp: CLIENT_ID }))).toBe("ok");
    });

    it("refuses an aud array without the client id", () => {
      expect(problem(claims({ aud: ["other"], azp: CLIENT_ID }))).toBe("audience");
    });

    it("refuses an aud array without azp, or with another azp", () => {
      expect(problem(claims({ aud: [CLIENT_ID, "other"], azp: undefined }))).toBe("audience");
      expect(problem(claims({ aud: [CLIENT_ID, "other"], azp: "other" }))).toBe("audience");
    });

    it("refuses a string aud with a different azp", () => {
      expect(problem(claims({ azp: "other" }))).toBe("audience");
    });
  });

  describe("exp", () => {
    it("refuses an expired token", () => {
      expect(problem(claims({ exp: nowSeconds - 3600 }))).toBe("expired");
    });

    it("allows a little clock skew, but not more", () => {
      expect(problem(claims({ exp: nowSeconds - 30 }))).toBe("ok");
      expect(problem(claims({ exp: nowSeconds - 61 }))).toBe("expired");
    });

    it("refuses a missing or non-numeric exp", () => {
      expect(problem(claims({ exp: undefined }))).toBe("expired");
      expect(problem(claims({ exp: String(nowSeconds + 3600) }))).toBe("expired");
      expect(problem(claims({ exp: Number.NaN }))).toBe("expired");
    });
  });

  describe("sub", () => {
    it.each([undefined, "", "   ", 1234, "x".repeat(256)])("refuses %s", (sub) => {
      expect(problem(claims({ sub }))).toBe("subject");
    });

    // The public demo's marker (src/lib/server/demo/marker.ts): sign-in never reaches or makes a demo user.
    it.each(["demo:0190f5a2-0000-7000-8000-000000000000", "demo:", "demo:110169484474386276334"])(
      "refuses the demo marker %s",
      (sub) => {
        expect(problem(claims({ sub }))).toBe("subject");
      },
    );

    it("accepts a sub that only contains the marker, or spells it otherwise", () => {
      for (const sub of ["110169484474386276334demo:", "Demo:1101", "demo1101"]) {
        expect(problem(claims({ sub })), sub).toBe("ok");
      }
    });
  });

  describe("email", () => {
    it.each([undefined, "", "   ", 42, "no-at-sign", "two@@example.com"])("refuses %s", (email) => {
      expect(problem(claims({ email }))).toBe("email");
    });

    it("requires email_verified to be the boolean true", () => {
      expect(problem(claims({ email_verified: false }))).toBe("email_unverified");
      expect(problem(claims({ email_verified: undefined }))).toBe("email_unverified");
      expect(problem(claims({ email_verified: "true" }))).toBe("email_unverified");
      expect(problem(claims({ email_verified: 1 }))).toBe("email_unverified");
    });
  });

  it("refuses something that is not a claims object", () => {
    for (const value of [null, undefined, "token", 42, [claims()]]) expect(problem(value)).toBe("malformed");
  });
});
