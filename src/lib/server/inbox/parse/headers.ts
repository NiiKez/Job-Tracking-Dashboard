import "server-only";
import type { GmailHeader } from "../source/types";
import { decodeBytes } from "./charset";

/**
 * Header helpers. Names are compared case-insensitively. Whether Gmail sends header values
 * RFC 2047 encoded or already decoded is unverified, so encoded words are decoded when present
 * and text without them passes through unchanged: decoding twice cannot happen unless decoded
 * text itself spells out an encoded word.
 */

/** The first header called `name` (any case), or null. Tolerates a missing or malformed list. */
export function headerValue(headers: readonly GmailHeader[] | undefined, name: string): string | null {
  if (!Array.isArray(headers)) return null;
  const wanted = name.toLowerCase();
  for (const h of headers) {
    if (h && typeof h.name === "string" && h.name.trim().toLowerCase() === wanted) {
      return typeof h.value === "string" ? h.value : null;
    }
  }
  return null;
}

// =?charset?encoding?text?= (RFC 2047). Text may hold spaces in the wild, though it should not.
const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;

function wordBytes(encoding: string, text: string): Buffer {
  if (encoding.toUpperCase() === "B") return Buffer.from(text, "base64");
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "_") out.push(0x20);
    else if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else for (const b of Buffer.from(ch, "utf8")) out.push(b);
  }
  return Buffer.from(out);
}

/**
 * Decodes RFC 2047 encoded words. Whitespace between two encoded words is dropped, and adjacent
 * words in the same charset are joined before decoding, so a character split across two words
 * survives. Malformed words stay as they are.
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes("=?")) return value;
  type Piece = { text: string } | { charset: string; bytes: Buffer };
  const pieces: Piece[] = [];
  let last = 0;
  for (const m of value.matchAll(ENCODED_WORD)) {
    const between = value.slice(last, m.index);
    const prev = pieces[pieces.length - 1];
    if (between && !(prev && "bytes" in prev && /^\s*$/.test(between))) pieces.push({ text: between });
    // RFC 2231 allows a language after the charset: "utf-8*en".
    const charset = m[1].split("*")[0].toLowerCase();
    const bytes = wordBytes(m[2], m[3]);
    const before = pieces[pieces.length - 1];
    if (before && "bytes" in before && before.charset === charset) {
      before.bytes = Buffer.concat([before.bytes, bytes]);
    } else {
      pieces.push({ charset, bytes });
    }
    last = m.index + m[0].length;
  }
  pieces.push({ text: value.slice(last) });
  return pieces.map((p) => ("bytes" in p ? decodeBytes(p.bytes, p.charset) : p.text)).join("");
}

// C0 and C1 controls except tab and line breaks, which the callers turn into spaces.
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Cuts to `max` UTF-16 units without leaving half of a surrogate pair. */
export function clampText(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * A header value as one line of text: encoded words decoded, control characters removed,
 * whitespace (including folding) collapsed, invisible padding removed, trimmed, cut to `max`.
 */
export function headerText(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const decoded = decodeEncodedWords(value)
    .replace(CONTROLS, "")
    .replace(/[­͏​‌⁠﻿]/g, "")
    .toWellFormed()
    .replace(/\s+/g, " ")
    .trim();
  return clampText(decoded, max).trim();
}

/** A structured header split at its parameters: `text/plain; charset="utf-8"`. */
export interface ParsedHeaderParams {
  /** The part before the first ";", lower case. */
  value: string;
  /** Parameter names lower case, values unquoted. */
  params: Record<string, string>;
}

/** Splits `value; a=b; c="d;e"` into the value and its parameters. Never throws. */
export function parseHeaderParams(raw: string | null | undefined): ParsedHeaderParams {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  const s = raw ?? "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && quoted && i + 1 < s.length) {
      current += s[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (ch === ";" && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  const params: Record<string, string> = Object.create(null);
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const name = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    else val = val.replace(/"/g, "");
    if (name && !(name in params)) params[name] = val;
  }
  return { value: parts[0].trim().toLowerCase(), params };
}
