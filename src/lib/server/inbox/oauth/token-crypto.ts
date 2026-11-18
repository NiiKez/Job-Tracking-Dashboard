import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { inboxTokenKeys } from "@/lib/server/env";

/**
 * Encryption of the Gmail refresh token at rest (docs/plan/2-gmail-ingest.md, "Encryption"):
 * AES-256-GCM, a random 96-bit IV per write, the user id as associated data (a value copied to
 * another user's row does not decrypt), stored as text
 *
 *   v1.<key id>.<iv>.<ciphertext and tag>
 *
 * with base64url parts. The key id is a short fingerprint of the key (tokenKeyId), not secret,
 * so decryption knows which key a row was written with.
 *
 * Rotation: put the new key in INBOX_TOKEN_KEY and the old one in INBOX_TOKEN_KEY_PREVIOUS.
 * decryptToken() reads rows of either key and says `reencrypt: true` for the old one; the caller
 * then stores encryptToken(token, userId) in the row. Once no row has the old key id, the old
 * variable is removed.
 *
 *   encryptToken(plaintext, userId, keys?)   → stored text (always the current key)
 *   decryptToken(stored, userId, keys?)      → { token, reencrypt }
 *   tokenKeyId(key)                          → 8 hex characters
 *   requireTokenKeys()                       the keys from the environment, or TokenCryptoError
 *
 * `keys` defaults to inboxTokenKeys() (INBOX_TOKEN_KEY, INBOX_TOKEN_KEY_PREVIOUS). Every
 * failure is a TokenCryptoError with a fixed message: never the token, the key or the stored text.
 */

export interface TokenKeys {
  /** 32 bytes: encrypts, and decrypts rows written with it. */
  current: Buffer;
  /** 32 bytes while a rotation is under way: decrypts only. */
  previous?: Buffer | null;
}

export type TokenCryptoProblem =
  /** INBOX_TOKEN_KEY is not set. */
  | "no_key"
  /** A key is not 32 bytes. */
  | "bad_key"
  /** The stored text is not v1.<key id>.<iv>.<ciphertext and tag>. */
  | "malformed"
  /** Written with a key that is neither the current nor the previous one. */
  | "unknown_key"
  /** Authentication failed: the wrong user id, or the stored text was changed. */
  | "decrypt_failed";

const MESSAGES: Record<TokenCryptoProblem, string> = {
  no_key: "Token encryption: INBOX_TOKEN_KEY is not set",
  bad_key: "Token encryption: a key is not 32 bytes",
  malformed: "Token encryption: the stored value is malformed",
  unknown_key: "Token encryption: the stored value was written with an unknown key",
  decrypt_failed: "Token encryption: the stored value does not decrypt (wrong user, or changed)",
};

export class TokenCryptoError extends Error {
  readonly problem: TokenCryptoProblem;

  constructor(problem: TokenCryptoProblem) {
    super(MESSAGES[problem]);
    this.name = "TokenCryptoError";
    this.problem = problem;
  }
}

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Google's refresh tokens are about 100 characters; this bounds what is stored and parsed. */
export const MAX_TOKEN_LENGTH = 4_096;
const MAX_STORED_LENGTH = 8_192;
const KEY_ID_LABEL = "job-tracker inbox token key id v1\0";
const B64URL = /^[A-Za-z0-9_-]+$/;
const KEY_ID = /^[0-9a-f]{8}$/;

/** The environment's keys. Throws TokenCryptoError("no_key") when INBOX_TOKEN_KEY is missing. */
export function requireTokenKeys(): TokenKeys {
  const keys = inboxTokenKeys();
  if (!keys) throw new TokenCryptoError("no_key");
  return keys;
}

/** The first 8 hex characters of SHA-256(fixed label ‖ key): names a key without revealing it. */
export function tokenKeyId(key: Buffer): string {
  checkKey(key);
  return createHash("sha256").update(KEY_ID_LABEL).update(key).digest("hex").slice(0, 8);
}

/** Encrypts `plaintext` for `userId` with the current key, as v1.<key id>.<iv>.<ciphertext and tag>. */
export function encryptToken(plaintext: string, userId: string, keys: TokenKeys = requireTokenKeys()): string {
  checkKey(keys.current);
  if (typeof plaintext !== "string" || plaintext === "" || plaintext.length > MAX_TOKEN_LENGTH) {
    throw new TypeError("encryptToken: the token must be a non-empty string of at most 4096 characters");
  }
  checkUserId(userId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keys.current, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(userId, "utf8"));
  const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return [VERSION, tokenKeyId(keys.current), iv.toString("base64url"), sealed.toString("base64url")].join(".");
}

/**
 * Decrypts a stored value for `userId` with the current key, or the previous one during a
 * rotation. `reencrypt` is true when the previous key was used: store encryptToken() again.
 */
export function decryptToken(
  stored: string,
  userId: string,
  keys: TokenKeys = requireTokenKeys(),
): { token: string; reencrypt: boolean } {
  checkKey(keys.current);
  if (keys.previous) checkKey(keys.previous);
  checkUserId(userId);
  if (typeof stored !== "string" || stored.length > MAX_STORED_LENGTH) throw new TokenCryptoError("malformed");
  const parts = stored.split(".");
  if (parts.length !== 4) throw new TokenCryptoError("malformed");
  const [version, keyId, ivText, sealedText] = parts;
  if (version !== VERSION || !KEY_ID.test(keyId) || !B64URL.test(ivText) || !B64URL.test(sealedText)) {
    throw new TokenCryptoError("malformed");
  }
  const iv = Buffer.from(ivText, "base64url");
  const sealed = Buffer.from(sealedText, "base64url");
  if (iv.length !== IV_BYTES || sealed.length <= TAG_BYTES) throw new TokenCryptoError("malformed");

  let key: Buffer;
  let reencrypt: boolean;
  if (keyId === tokenKeyId(keys.current)) {
    key = keys.current;
    reencrypt = false;
  } else if (keys.previous && keyId === tokenKeyId(keys.previous)) {
    key = keys.previous;
    reencrypt = true;
  } else {
    throw new TokenCryptoError("unknown_key");
  }

  let token: string;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(userId, "utf8"));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
    token = new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    // Node's error says nothing secret, but a fixed one is simpler to reason about.
    throw new TokenCryptoError("decrypt_failed");
  }
  return { token, reencrypt };
}

function checkKey(key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new TokenCryptoError("bad_key");
}

function checkUserId(userId: string) {
  if (typeof userId !== "string" || userId === "") throw new TypeError("token-crypto: userId must be a non-empty string");
}
