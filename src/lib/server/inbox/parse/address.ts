import "server-only";
import { clampText, decodeEncodedWords } from "./headers";

/**
 * From and Reply-To (RFC 5322 address lists, as they arrive in practice). Handles display names
 * in quotes or not, encoded words, comments, the bare and angle-less forms, groups and lists
 * (the first mailbox with a usable address wins). Garbage gives an empty address, never an
 * exception. Not the link fetcher's src/lib/server/parse/address.ts, which is about IP addresses.
 */

export interface Mailbox {
  /** Decoded display name, "" when there is none. */
  name: string;
  /** Lower-case addr-spec, "" when there is no usable address. */
  address: string;
}

/** Display names are cut to this many characters. */
export const MAX_NAME = 200;
/** Longer "addresses" are not addresses (RFC 5321 allows 254). */
const MAX_ADDRESS = 320;

/** The first mailbox of the header that has a usable address, else the first one; never null. */
export function parseMailbox(value: string | null | undefined): Mailbox {
  if (!value || !value.trim()) return { name: "", address: "" };
  const list = parseMailboxList(value);
  const found = list.find((m) => m.address) ?? list[0];
  if (!found?.address && value.includes("=?")) {
    // Some senders encode the whole "Name <address>" as one encoded word.
    const decoded = decodeEncodedWords(value);
    if (decoded !== value) {
      const retry = parseMailboxList(decoded).find((m) => m.address);
      if (retry) return retry;
    }
  }
  return found ?? { name: "", address: "" };
}

/** Every mailbox in the header, in order (at most 50). */
export function parseMailboxList(value: string): Mailbox[] {
  return mergeNameOnlySegments(splitTopLevel(value.slice(0, 10_000)))
    .slice(0, 50)
    .map(parseSegment)
    .filter((m) => m.name || m.address);
}

/* ---------------------------------------------------------------- scanning */

interface Scan {
  /** Text outside quotes, comments and angle brackets, with quoted strings unquoted. */
  outside: string;
  /** Text inside the first angle brackets, or null. */
  angle: string | null;
  /** Text of the top-level comments. */
  comments: string[];
  /** Index in `outside` where the angle brackets were. */
  angleAt: number;
}

/** Splits at top-level commas: not inside quotes, comments or angle brackets. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let comment = 0;
  let angle = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && (quoted || comment) && i + 1 < s.length) {
      current += ch + s[++i];
      continue;
    }
    if (quoted) {
      if (ch === '"') quoted = false;
    } else if (comment) {
      if (ch === "(") comment++;
      else if (ch === ")") comment--;
    } else if (ch === '"') quoted = true;
    else if (ch === "(") comment = 1;
    else if (ch === "<") angle = true;
    else if (ch === ">") angle = false;
    else if ((ch === "," || ch === ";") && !angle) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((p) => p.trim()).filter(Boolean);
}

/**
 * A segment without "@" is most likely part of a display name that held a comma and was not
 * quoted ("Doe, Jane <jane@example.com>", as an already-decoded header can arrive): it is joined
 * to the segment after it.
 */
function mergeNameOnlySegments(segments: string[]): string[] {
  const out: string[] = [];
  let carry = "";
  for (const seg of segments) {
    const joined = carry ? `${carry}, ${seg}` : seg;
    if (!seg.includes("@") && !seg.includes(":")) {
      carry = joined;
      continue;
    }
    out.push(joined);
    carry = "";
  }
  if (carry) out.push(carry);
  return out;
}

function scan(seg: string): Scan {
  let outside = "";
  let angle: string | null = null;
  let angleAt = -1;
  const comments: string[] = [];
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '"') {
      // Quoted string: copy its content, unescaped.
      for (i++; i < seg.length && seg[i] !== '"'; i++) {
        outside += seg[i] === "\\" && i + 1 < seg.length ? seg[++i] : seg[i];
      }
    } else if (ch === "(") {
      let depth = 1;
      let text = "";
      for (i++; i < seg.length && depth > 0; i++) {
        const c = seg[i];
        if (c === "\\" && i + 1 < seg.length) {
          text += seg[++i];
          continue;
        }
        if (c === "(") depth++;
        if (c === ")") depth--;
        if (depth > 0) text += c;
      }
      i--;
      comments.push(text);
      outside += " ";
    } else if (ch === "<" && angle === null) {
      const end = seg.indexOf(">", i + 1);
      angle = seg.slice(i + 1, end < 0 ? undefined : end);
      angleAt = outside.length;
      i = end < 0 ? seg.length : end;
      outside += " ";
    } else {
      outside += ch;
    }
  }
  return { outside, angle, comments, angleAt };
}

/* ---------------------------------------------------------------- one mailbox */

function cleanName(raw: string): string {
  const s = decodeEncodedWords(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[­͏​‌⁠﻿]/g, "")
    .toWellFormed()
    .replace(/\s+/g, " ")
    .trim()
    // Leftover quoting: "'Jane Doe'", "\"Jane\"".
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
  // Punctuation alone ("<<>>", "--") is not a name.
  if (!/[\p{L}\p{N}]/u.test(s)) return "";
  return clampText(s, MAX_NAME).trim();
}

const ADDR_SPEC = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+$/;

/** A usable lower-case addr-spec, or "". The domain needs a dot and well-formed labels. */
export function cleanAddress(raw: string): string {
  let s = raw.trim();
  // A source route: "@relay.example,@other.example:jane@example.com".
  if (s.startsWith("@") && s.includes(":")) s = s.slice(s.lastIndexOf(":") + 1);
  s = s.replace(/^mailto:/i, "").toLowerCase();
  if (!s || s.length > MAX_ADDRESS || !ADDR_SPEC.test(s)) return "";
  const domain = s.slice(s.indexOf("@") + 1);
  const local = s.slice(0, s.indexOf("@"));
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return "";
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((l) => !l || l.startsWith("-") || l.endsWith("-"))) return "";
  return s;
}

function parseSegment(segment: string): Mailbox {
  let seg = segment;
  // Group syntax: "Team: jane@example.com, bob@example.com;" or "undisclosed-recipients:;".
  // The colon must come before any quote, comment, angle bracket or "@".
  const colon = seg.search(/[:"(<@]/);
  if (colon >= 0 && seg[colon] === ":") seg = seg.slice(colon + 1);
  const { outside, angle, comments, angleAt } = scan(seg);
  const commentName = comments.map((c) => c.trim()).filter(Boolean).join(" ");

  if (angle !== null) {
    // Comments and folding whitespace inside the brackets: "<jane(work)@example.com>".
    const address = cleanAddress(scan(angle).outside.replace(/\s+/g, ""));
    const name = cleanName(outside.slice(0, angleAt)) || cleanName(outside.slice(angleAt)) || cleanName(commentName);
    return { name, address };
  }

  const text = outside.trim();
  const whole = cleanAddress(text);
  if (whole) return { name: cleanName(commentName), address: whole };
  // "Jane Doe jane@example.com" without brackets: the last word with an "@" is the address.
  const words = text.split(/\s+/);
  for (let i = words.length - 1; i >= 0; i--) {
    const address = words[i].includes("@") ? cleanAddress(words[i].replace(/^<|>$/g, "")) : "";
    if (address) {
      const name = [...words.slice(0, i), ...words.slice(i + 1)].join(" ");
      return { name: cleanName(name) || cleanName(commentName), address };
    }
  }
  return { name: cleanName(text.includes("@") ? commentName : text || commentName), address: "" };
}
