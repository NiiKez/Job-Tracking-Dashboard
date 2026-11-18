import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "@/lib/server/env";
import {
  decryptToken,
  encryptToken,
  requireTokenKeys,
  TokenCryptoError,
  tokenKeyId,
  type TokenCryptoProblem,
} from "@/lib/server/inbox/oauth/token-crypto";

const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);
const USER = "6f1c2d3e-0000-4000-8000-000000000001";
const OTHER_USER = "6f1c2d3e-0000-4000-8000-000000000002";
const TOKEN = "1//0invented-refresh-token-Abc_123-xyz";

function problemOf(fn: () => unknown): TokenCryptoProblem {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TokenCryptoError);
    const e = err as TokenCryptoError;
    // Never the token, a key or the stored text in a message.
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toContain(KEY_A.toString("hex"));
    expect(e.message).not.toContain(KEY_B.toString("hex"));
    return e.problem;
  }
  throw new Error("expected a TokenCryptoError");
}

/** Flips one bit of the decoded part `index` (2 = iv, 3 = ciphertext and tag). */
function flip(stored: string, index: number, byte = 0): string {
  const parts = stored.split(".");
  const bytes = Buffer.from(parts[index], "base64url");
  bytes[byte] ^= 1;
  parts[index] = bytes.toString("base64url");
  return parts.join(".");
}

describe("tokenKeyId", () => {
  it("is 8 hex characters, stable per key, different between keys, not the key itself", () => {
    expect(tokenKeyId(KEY_A)).toMatch(/^[0-9a-f]{8}$/);
    expect(tokenKeyId(KEY_A)).toBe(tokenKeyId(Buffer.from(KEY_A)));
    expect(tokenKeyId(KEY_A)).not.toBe(tokenKeyId(KEY_B));
    expect(KEY_A.toString("hex")).not.toContain(tokenKeyId(KEY_A));
  });
});

describe("encryptToken / decryptToken", () => {
  it("round-trips, as v1.<key id>.<iv>.<ciphertext and tag>", () => {
    const stored = encryptToken(TOKEN, USER, { current: KEY_A });
    expect(stored).toMatch(/^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    const [, keyId, iv, sealed] = stored.split(".");
    expect(keyId).toBe(tokenKeyId(KEY_A));
    expect(Buffer.from(iv, "base64url")).toHaveLength(12);
    expect(Buffer.from(sealed, "base64url")).toHaveLength(Buffer.byteLength(TOKEN) + 16);
    expect(stored).not.toContain(TOKEN);
    expect(decryptToken(stored, USER, { current: KEY_A })).toEqual({ token: TOKEN, reencrypt: false });
  });

  it("uses a new random IV for every write", () => {
    const a = encryptToken(TOKEN, USER, { current: KEY_A });
    const b = encryptToken(TOKEN, USER, { current: KEY_A });
    expect(a).not.toBe(b);
    expect(a.split(".")[2]).not.toBe(b.split(".")[2]);
  });

  it("round-trips any text, including non-ASCII", () => {
    const token = "tök€n-😀";
    expect(decryptToken(encryptToken(token, USER, { current: KEY_A }), USER, { current: KEY_A }).token).toBe(token);
  });

  it("binds the value to the user id", () => {
    const stored = encryptToken(TOKEN, USER, { current: KEY_A });
    expect(problemOf(() => decryptToken(stored, OTHER_USER, { current: KEY_A }))).toBe("decrypt_failed");
  });

  it("detects a changed IV, ciphertext or tag", () => {
    const stored = encryptToken(TOKEN, USER, { current: KEY_A });
    const tagStart = Buffer.byteLength(TOKEN);
    for (const tampered of [flip(stored, 2), flip(stored, 3), flip(stored, 3, tagStart + 3)]) {
      expect(problemOf(() => decryptToken(tampered, USER, { current: KEY_A }))).toBe("decrypt_failed");
    }
  });

  it("refuses a value written with an unknown key", () => {
    const stored = encryptToken(TOKEN, USER, { current: KEY_A });
    expect(problemOf(() => decryptToken(stored, USER, { current: KEY_B }))).toBe("unknown_key");
    // A forged key id of the current key does not help.
    const forged = stored.replace(tokenKeyId(KEY_A), tokenKeyId(KEY_B));
    expect(problemOf(() => decryptToken(forged, USER, { current: KEY_B }))).toBe("decrypt_failed");
  });

  it("rotation: reads the previous key's rows and asks for re-encryption", () => {
    const old = encryptToken(TOKEN, USER, { current: KEY_A });
    const keys = { current: KEY_B, previous: KEY_A };
    expect(decryptToken(old, USER, keys)).toEqual({ token: TOKEN, reencrypt: true });
    const fresh = encryptToken(TOKEN, USER, keys);
    expect(fresh.split(".")[1]).toBe(tokenKeyId(KEY_B));
    expect(decryptToken(fresh, USER, keys)).toEqual({ token: TOKEN, reencrypt: false });
    // After the old variable is removed, the old row is unreadable.
    expect(problemOf(() => decryptToken(old, USER, { current: KEY_B, previous: null }))).toBe("unknown_key");
  });

  it("refuses malformed values", () => {
    const good = encryptToken(TOKEN, USER, { current: KEY_A });
    const [, keyId, iv, sealed] = good.split(".");
    for (const value of [
      "",
      "v1",
      `v2.${keyId}.${iv}.${sealed}`,
      `v1.${keyId}.${iv}`,
      `v1.${keyId}.${iv}.${sealed}.extra`,
      `v1.XYZ.${iv}.${sealed}`,
      `v1.${keyId}.${iv}=.${sealed}`,
      `v1.${keyId}.${iv}.${sealed}+`,
      `v1.${keyId}.${iv.slice(0, -2)}.${sealed}`,
      `v1.${keyId}.${iv}.${sealed.slice(0, 20)}`,
      `v1.${keyId}.${iv}.${"A".repeat(9000)}`,
      42 as unknown as string,
    ]) {
      expect(problemOf(() => decryptToken(value, USER, { current: KEY_A }))).toBe("malformed");
    }
  });

  it("refuses keys that are not 32 bytes", () => {
    expect(problemOf(() => encryptToken(TOKEN, USER, { current: Buffer.alloc(16) }))).toBe("bad_key");
    const stored = encryptToken(TOKEN, USER, { current: KEY_A });
    expect(problemOf(() => decryptToken(stored, USER, { current: KEY_A, previous: Buffer.alloc(31) }))).toBe("bad_key");
  });

  it("refuses an empty token or user id", () => {
    expect(() => encryptToken("", USER, { current: KEY_A })).toThrow(TypeError);
    expect(() => encryptToken(TOKEN, "", { current: KEY_A })).toThrow(TypeError);
    expect(() => encryptToken("x".repeat(4097), USER, { current: KEY_A })).toThrow(TypeError);
  });
});

describe("keys from the environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it("uses INBOX_TOKEN_KEY and INBOX_TOKEN_KEY_PREVIOUS by default", () => {
    const current = randomBytes(32);
    const previous = randomBytes(32);
    vi.stubEnv("INBOX_TOKEN_KEY", previous.toString("hex"));
    vi.stubEnv("INBOX_TOKEN_KEY_PREVIOUS", "");
    resetEnvForTests();
    const old = encryptToken(TOKEN, USER);

    vi.stubEnv("INBOX_TOKEN_KEY", current.toString("hex"));
    vi.stubEnv("INBOX_TOKEN_KEY_PREVIOUS", previous.toString("hex"));
    resetEnvForTests();
    expect(decryptToken(old, USER)).toEqual({ token: TOKEN, reencrypt: true });
    expect(decryptToken(encryptToken(TOKEN, USER), USER)).toEqual({ token: TOKEN, reencrypt: false });
  });

  it("without INBOX_TOKEN_KEY: no_key", () => {
    vi.stubEnv("INBOX_TOKEN_KEY", "");
    vi.stubEnv("INBOX_TOKEN_KEY_PREVIOUS", "");
    resetEnvForTests();
    expect(problemOf(() => requireTokenKeys())).toBe("no_key");
    expect(problemOf(() => encryptToken(TOKEN, USER))).toBe("no_key");
  });
});
