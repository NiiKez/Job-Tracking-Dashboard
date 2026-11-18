import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EXTENSION_KEY_PREFIX,
  EXTENSION_KEY_TOUCH_AFTER_SECONDS,
  hashExtensionKey,
  newExtensionKey,
  readBearerToken,
} from "@/lib/server/auth/extension-key";

// The extension key's format and the Authorization header. Keys are made at runtime: a literal
// key of the real shape would fail the secret scan (.gitleaks.toml).

/** A key built from these 32 bytes. */
const keyOf = (bytes: Buffer) => `${EXTENSION_KEY_PREFIX}${bytes.toString("base64url")}`;

describe("extension keys", () => {
  it("are jtx_ and 32 random bytes in unpadded base64url, 47 characters", () => {
    const { token, tokenHash } = newExtensionKey();
    expect(token).toMatch(/^jtx_[A-Za-z0-9_-]{43}$/);
    expect(token).toHaveLength(47);
    const raw = Buffer.from(token.slice(4), "base64url");
    expect(raw).toHaveLength(32);
    // Only SHA-256 of the raw bytes is stored, as for sessions.
    expect(tokenHash).toEqual(createHash("sha256").update(raw).digest());
    expect(hashExtensionKey(token)).toEqual(tokenHash);
    expect(newExtensionKey().token).not.toBe(token);
  });

  it("hash only in their one canonical spelling", () => {
    const zeros = Buffer.alloc(32);
    const canonical = keyOf(zeros); // jtx_ and 43 "A"
    expect(hashExtensionKey(canonical)).toEqual(createHash("sha256").update(zeros).digest());

    const body = canonical.slice(4);
    const refused = [
      "",
      body, // no prefix: a session token's shape
      `JTX_${body}`,
      `jtx-${body}`,
      `jtx_${body}=`,
      `jtx_${body.slice(1)}`,
      `jtx_${body}A`,
      ` ${canonical}`,
      `${canonical} `,
      // The last character carries 4 bits and 2 that must be zero: "B" decodes to the same bytes
      // as "A", but is a second spelling of the key.
      `jtx_${body.slice(0, -1)}B`,
      // Standard base64, not base64url.
      `jtx_${body.slice(0, -2)}+/`,
    ];
    for (const token of refused) expect(hashExtensionKey(token), JSON.stringify(token)).toBeNull();
  });

  it("are touched at most every 5 minutes", () => {
    expect(EXTENSION_KEY_TOUCH_AFTER_SECONDS).toBe(300);
  });
});

describe("readBearerToken", () => {
  const withAuth = (value?: string) =>
    new Request("https://jobs.example.com/api/extension/session", {
      headers: value === undefined ? {} : { authorization: value },
    });

  it("reads the credentials of a Bearer header, whatever the scheme's case", () => {
    expect(readBearerToken(withAuth("Bearer abc"))).toBe("abc");
    expect(readBearerToken(withAuth("bearer abc"))).toBe("abc");
    expect(readBearerToken(withAuth("BEARER   abc"))).toBe("abc");
    expect(readBearerToken(withAuth("Bearer abc  "))).toBe("abc");
  });

  it("is null without one", () => {
    for (const value of [undefined, "", "Bearer", "Bearer ", "Bearerabc", "Basic YWxhZGRpbjpvcGVu", "Bearer a b", "Token abc"]) {
      expect(readBearerToken(withAuth(value)), JSON.stringify(value)).toBeNull();
    }
  });
});
