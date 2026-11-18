import "server-only";

/**
 * Bytes of a Gmail message part to text.
 *
 * Gmail sends part bodies as base64url [V]. Three things about them are unverified
 * (docs/plan/2-gmail-ingest.md, "Risks"), so each is handled defensively and never decoded twice:
 *
 *   - Content-Transfer-Encoding. Gmail is expected to have removed it already. Only when the
 *     bytes still look encoded (7-bit text with quoted-printable soft breaks or escapes, or a
 *     body that is nothing but base64 lines) is it undone here.
 *   - Charset. The part's `charset` parameter is used, falling back to UTF-8; an unknown label
 *     never throws. A legacy charset whose bytes are valid multi-byte UTF-8 is read as UTF-8, in
 *     case Gmail transcoded the body but kept the header. Bytes without a declared charset that
 *     are not valid UTF-8 are read as windows-1252, which is what such mail almost always is.
 *   - Size. At most `maxBytes` are decoded; the caller is told when the rest was left out.
 */

/** The decoded bytes of a base64url (or plain base64) string, at most `maxBytes` of them. */
export function base64UrlToBytes(data: string, maxBytes: number): { bytes: Buffer; truncated: boolean } {
  // 4 characters carry 3 bytes. Cutting at a multiple of 4 keeps every group whole; whitespace
  // (which Node skips) can only make the cut a little early, never late.
  const maxChars = Math.ceil(maxBytes / 3) * 4;
  const cut = data.length > maxChars;
  let bytes = Buffer.from(cut ? data.slice(0, maxChars) : data, "base64url");
  // maxChars can carry up to two bytes more than maxBytes.
  const over = bytes.length > maxBytes;
  if (over) bytes = bytes.subarray(0, maxBytes);
  return { bytes, truncated: cut || over };
}

const UTF8_LABELS = new Set(["utf-8", "utf8", "unicode-1-1-utf-8", "x-unicode20utf8"]);
const ASCII_LABELS = new Set(["us-ascii", "ascii", "ansi_x3.4-1968", "iso646-us", "cp367", "us"]);
const WIDE_LABEL = /^(utf-?16|utf-?32|ucs-?2|ucs-?4|unicode)/;

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const lenientUtf8 = new TextDecoder("utf-8");
const windows1252 = new TextDecoder("windows-1252");

/** The `charset` label as it is compared here: unquoted, trimmed, lower case. */
export function normalizeCharset(label: string | null | undefined): string {
  return (label ?? "").trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
}

function strictUtf8OrNull(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

function hasHighByte(bytes: Uint8Array) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) return true;
  return false;
}

/** `bytes` as text in `charset` (see the rules at the top of this file). Never throws. */
export function decodeBytes(bytes: Uint8Array, charset: string | null | undefined): string {
  const label = normalizeCharset(charset);
  if (!label || ASCII_LABELS.has(label)) {
    // Undeclared or "ASCII": UTF-8 when it is valid, else the usual Western legacy charset.
    return strictUtf8OrNull(bytes) ?? windows1252.decode(bytes);
  }
  if (UTF8_LABELS.has(label)) return lenientUtf8.decode(bytes);
  if (!WIDE_LABEL.test(label) && hasHighByte(bytes)) {
    // A legacy label over bytes that are valid multi-byte UTF-8: the body was transcoded (or
    // mislabelled). Real Latin-1 text is practically never valid UTF-8 by accident.
    const asUtf8 = strictUtf8OrNull(bytes);
    if (asUtf8 !== null) return asUtf8;
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    // Unknown label (utf-7, a typo, an invented name).
    return lenientUtf8.decode(bytes);
  }
  return decoder.decode(bytes);
}

/** Quoted-printable (RFC 2045 6.7) to bytes. Lenient: a stray "=" stays as it is. */
export function decodeQuotedPrintable(text: string): Buffer {
  const out: number[] = [];
  const s = text.replace(/[ \t]+(?=\r?\n)/g, ""); // trailing whitespace is not part of the data
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d /* = */) {
      if (s[i + 1] === "\n") {
        i += 1; // soft line break
        continue;
      }
      if (s[i + 1] === "\r" && s[i + 2] === "\n") {
        i += 2;
        continue;
      }
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
      out.push(c);
    } else if (c < 0x80) {
      out.push(c);
    } else {
      // Not valid in quoted-printable; keep the character as UTF-8.
      for (const b of Buffer.from(s[i], "utf8")) out.push(b);
    }
  }
  return Buffer.from(out);
}

/**
 * Text that still carries quoted-printable encoding: a soft line break after an ordinary
 * character, an encoded "=" (=3D, which any quoted-printable body with an "=" has), or encoded
 * 8-bit characters inside a word. Decoded 7-bit text rarely has any of these; an address such
 * as "?ref=AB12" is not mistaken for one. An "=" that starts neither an escape nor a soft line
 * break ("?token=Qm9v=", "utm_source=mail") cannot be in an encoded body, so it rules one out.
 */
function looksQuotedPrintable(text: string) {
  if (/=(?![0-9A-F]{2}|[ \t]*\r?\n|[ \t]*$)/.test(text)) return false;
  return (
    /[^=\s]=\r?\n/.test(text) ||
    /=3D/.test(text) ||
    /=[C-F][0-9A-F]=[89AB][0-9A-F]/.test(text) ||
    /[a-z]=[A-F][0-9A-F][a-z]/.test(text)
  );
}

/** A body that is nothing but base64 lines, as a base64 transfer encoding leaves it. */
function looksBase64(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return false;
  const joined = lines.join("");
  return (
    joined.length >= 16 &&
    joined.length % 4 === 0 &&
    lines.every((l) => l.length <= 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(l))
  );
}

/**
 * Undoes a Content-Transfer-Encoding that Gmail left in place, and only then. Bytes with any
 * 8-bit byte were decoded already (both encodings produce 7-bit text).
 */
export function undoTransferEncoding(bytes: Buffer, encoding: string | null | undefined): Buffer {
  const cte = (encoding ?? "").trim().toLowerCase();
  if ((cte !== "quoted-printable" && cte !== "base64") || hasHighByte(bytes)) return bytes;
  const text = bytes.toString("latin1");
  if (cte === "quoted-printable") return looksQuotedPrintable(text) ? decodeQuotedPrintable(text) : bytes;
  if (!looksBase64(text)) return bytes;
  const decoded = Buffer.from(text, "base64");
  // Real text decodes to bytes without control characters (other than tab and line breaks).
  for (const b of decoded) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return bytes;
  return decoded;
}
