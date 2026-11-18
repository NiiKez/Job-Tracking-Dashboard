import "server-only";
import type { GmailMessage, GmailPart } from "../source/types";
import { parseMailbox } from "./address";
import { base64UrlToBytes, decodeBytes, undoTransferEncoding } from "./charset";
import { headerText, headerValue, parseHeaderParams } from "./headers";
import { MAX_HTML, decodeEntities, readHtml } from "./html";
import { MAX_BODY, type QuoteOptions, cleanBody, isForwardSubject, unflowText } from "./quoted";

/**
 * A Gmail message (format=full) as the ingest pipeline reads it (docs/plan/2-gmail-ingest.md,
 * "Reading a message" and "What is stored"):
 *
 *   parseGmailMessage(msg, { getAttachment })
 *     Never throws on a malformed message (missing payload or headers, empty, huge or deeply
 *     nested parts, odd encodings): it returns the best it can. It throws only what
 *     opts.getAttachment throws (a MailSourceError from the mail source), so a temporary
 *     failure is retried by the sync engine instead of storing a worse body.
 *
 * The body: the payload is walked depth-first (attached messages, message/rfc822, are not
 * entered), and the first text part that is not an attachment (no filename, no
 * "Content-Disposition: attachment") is used, text/html through html.ts. Within a
 * multipart/alternative, text/plain comes before text/html, unless it is only a stub of the HTML
 * beside it (shorter than a third of the HTML's cleaned text, "This message requires an HTML
 * email client"): then that HTML is used, converted once, if MAX_DECODED_BYTES leaves room for
 * it. Elsewhere the order of the parts decides, so an HTML body is not passed over for a
 * plain-text footer part after it (the plan says "the first text/plain part, else text/html";
 * this is narrower on purpose). A part that cleans to nothing is passed over. A text part delivered as an attachment reference is
 * fetched through opts.getAttachment when its size is under MAX_ATTACHMENT_FETCH; otherwise, or
 * without a fetcher, the next candidate is tried and in the end Gmail's snippet is used (also
 * once MAX_DECODED_BYTES of parts were tried). Quoted replies and padding go (quoted.ts; a
 * subject that marks a forward keeps Outlook's forwarded header block), and the result is cut
 * at MAX_BODY characters.
 */
export interface ParsedMessage {
  gmailMessageId: string;
  gmailThreadId: string;
  labelIds: string[];
  /** internalDate (when Gmail received it), not the Date header. */
  receivedAt: Date;
  /** Decoded display name, "" when none (at most 200 characters). */
  fromName: string;
  /** Lower-case addr-spec, "" when unparseable. */
  fromAddress: string;
  replyToAddress: string | null;
  /** RFC 2047 decoded, whitespace collapsed, at most MAX_SUBJECT characters. */
  subject: string;
  /** Cleaned text, at most MAX_BODY characters. */
  body: string;
  /**
   * The body is not the whole text: cut at MAX_BODY, the part was too large to decode whole, its
   * HTML nested too deep to read whole, or the snippet stands in for a text part that could not
   * be fetched.
   */
  bodyTruncated: boolean;
  bulk: { listUnsubscribe: boolean; listId: string | null; precedence: string | null };
  /** Primary subtag of Content-Language, lower case ("de"). */
  contentLanguage: string | null;
}

export interface ParseOptions {
  /** Fetches an attachment's data (base64url) of this message; null when it is gone. */
  getAttachment?: (attachmentId: string) => Promise<string | null>;
}

export { MAX_BODY };
/** A text part delivered as an attachment reference is fetched only below this size (bytes). */
export const MAX_ATTACHMENT_FETCH = 1_000_000;
/** At most this much of a part is decoded; the rest is left out and the body marked truncated. */
export const MAX_PART_BYTES = MAX_HTML;
/**
 * At most this much of all the parts tried together is decoded (converting a megabyte of HTML
 * takes about a second, and parts that clean to nothing are passed over); then the snippet
 * stands in and the body is marked truncated.
 */
export const MAX_DECODED_BYTES = 2 * MAX_PART_BYTES;
/** Parts nested deeper than this are not looked at; real mail nests a handful of levels. */
export const MAX_PART_DEPTH = 32;
/** At most this many parts are looked at. */
export const MAX_PARTS = 500;
/** At most this many attachment references are fetched for one message. */
const MAX_FETCHES = 2;
/** Subjects are cut to this many characters (the emails table has no limit; this is a guard). */
export const MAX_SUBJECT = 1_000;

interface Candidate {
  part: GmailPart;
  html: boolean;
  /** For text/plain in a multipart/alternative: the first HTML alternative beside it. */
  alternative?: Candidate;
}

/** A part's cleaned text, whether it is incomplete, and the part. */
interface Body {
  body: string;
  truncated: boolean;
  part: GmailPart | null;
}

/** See the contract at the top of this file. */
export async function parseGmailMessage(msg: GmailMessage, opts: ParseOptions = {}): Promise<ParsedMessage> {
  const m: Partial<GmailMessage> = msg && typeof msg === "object" ? msg : {};
  const payload = m.payload && typeof m.payload === "object" ? m.payload : undefined;
  const headers = Array.isArray(payload?.headers) ? payload.headers : [];
  const header = (name: string) => headerValue(headers, name);

  const from = parseMailbox(header("From"));
  const replyTo = parseMailbox(header("Reply-To")).address;
  const listId = header("List-Id");
  const precedence = headerText(header("Precedence"), 50).toLowerCase();

  const subject = headerText(header("Subject"), MAX_SUBJECT);
  const { body, truncated, part } = await readBody(payload, m.snippet, opts, { forwarded: isForwardSubject(subject) });

  return {
    gmailMessageId: typeof m.id === "string" ? m.id : "",
    gmailThreadId: typeof m.threadId === "string" && m.threadId ? m.threadId : typeof m.id === "string" ? m.id : "",
    labelIds: Array.isArray(m.labelIds) ? m.labelIds.filter((l): l is string => typeof l === "string") : [],
    receivedAt: receivedAt(m.internalDate, header("Date")),
    fromName: from.name,
    fromAddress: from.address,
    replyToAddress: replyTo || null,
    subject,
    body,
    bodyTruncated: truncated,
    bulk: {
      listUnsubscribe: !!header("List-Unsubscribe")?.trim(),
      listId: listIdOf(listId),
      precedence: precedence || null,
    },
    contentLanguage: languageOf(header("Content-Language")) ?? languageOf(headerValue(part?.headers, "Content-Language")),
  };
}

/* ---------------------------------------------------------------- body */

/**
 * The cleaned body, whether it is incomplete, and the part it came from (null when the snippet
 * stands in). A candidate that cleans to nothing (padding only, say) is passed over.
 */
async function readBody(payload: GmailPart | undefined, snippet: unknown, opts: ParseOptions, quotes: QuoteOptions): Promise<Body> {
  let fetches = 0;
  let unreadable = false;
  let budget = MAX_DECODED_BYTES;

  /** The part's data (base64url): inline, or fetched when it is a reference that may be. */
  const dataOf = async (part: GmailPart): Promise<string | null> => {
    const body = part.body;
    if (typeof body?.data === "string" && body.data) return body.data;
    if (typeof body?.attachmentId !== "string" || !body.attachmentId) return null;
    const size = Number(body.size);
    if (!opts.getAttachment || !Number.isFinite(size) || size >= MAX_ATTACHMENT_FETCH || fetches >= MAX_FETCHES) return null;
    fetches++;
    // Not caught: a failure here is the mail source's (see the contract above).
    const data = await opts.getAttachment(body.attachmentId);
    return typeof data === "string" && data ? data : null;
  };

  /** The candidate's data decoded (within the budget) and cleaned. */
  const read = (candidate: Candidate, data: string): Body => {
    const decoded = decodePart(candidate, data, Math.min(MAX_PART_BYTES, budget));
    budget -= decoded.bytes;
    const cleaned = cleanBody(decoded.text, MAX_BODY, quotes);
    return { body: cleaned.body, truncated: cleaned.truncated || decoded.truncated, part: candidate.part };
  };

  for (const candidate of textParts(payload)) {
    if (budget <= 0) {
      unreadable = true;
      break;
    }
    const data = await dataOf(candidate.part);
    if (!data) {
      if (typeof candidate.part.body?.attachmentId === "string" && candidate.part.body.attachmentId) unreadable = true;
      continue;
    }
    const found = read(candidate, data);
    if (!found.body) continue;
    // A plain-text stub of the HTML alternative: the HTML, when the budget has room for it.
    const html = candidate.alternative;
    if (html && expectedBytes(html.part) <= budget) {
      const htmlData = await dataOf(html.part);
      const fromHtml = htmlData ? read(html, htmlData) : null;
      if (fromHtml && found.body.length * 3 < fromHtml.body.length) return fromHtml;
    }
    return found;
  }
  // No readable text part: Gmail's snippet. Incomplete when a text part could not be fetched
  // or was not tried.
  const cleaned = cleanBody(snippetText(snippet), MAX_BODY, quotes);
  return { body: cleaned.body, truncated: unreadable, part: null };
}

/** How many bytes the part's data decodes to: from the data itself, else its declared size. */
function expectedBytes(part: GmailPart): number {
  const data = part.body?.data;
  if (typeof data === "string" && data) return Math.floor((data.length * 3) / 4);
  const size = Number(part.body?.size);
  return Number.isFinite(size) ? size : Infinity;
}

/** The part's text, whether some was left out, and how many bytes were decoded. */
function decodePart(candidate: Candidate, data: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  let size = 0;
  try {
    const { bytes, truncated } = base64UrlToBytes(data, maxBytes);
    size = bytes.length;
    const headers = candidate.part.headers;
    const type = parseHeaderParams(headerValue(headers, "Content-Type"));
    const raw = undoTransferEncoding(bytes, headerValue(headers, "Content-Transfer-Encoding"));
    let text = decodeBytes(raw, type.params.charset).replace(/\r\n?/g, "\n");
    if (candidate.html) {
      const read = readHtml(text);
      return { text: read.text, truncated: truncated || read.truncated, bytes: size };
    }
    if (type.params.format?.toLowerCase() === "flowed") {
      text = unflowText(text, type.params.delsp?.toLowerCase() === "yes");
    }
    return { text, truncated, bytes: size };
  } catch {
    return { text: "", truncated: false, bytes: size };
  }
}

function isAttachment(part: GmailPart): boolean {
  if (typeof part.filename === "string" && part.filename.trim()) return true;
  return /^\s*attachment\b/i.test(headerValue(part.headers, "Content-Disposition") ?? "");
}

function mimeTypeOf(part: GmailPart): string {
  if (typeof part.mimeType === "string" && part.mimeType.trim()) return part.mimeType.trim().toLowerCase();
  const declared = parseHeaderParams(headerValue(part.headers, "Content-Type")).value;
  // RFC 2045's default is text/plain; a part with children is a multipart whatever it says.
  return declared || (Array.isArray(part.parts) ? "multipart/mixed" : "text/plain");
}

/**
 * Text parts in the order they are tried: depth-first, with text/plain before text/html within
 * a multipart/alternative (its parts are the same text in different forms), each plain part
 * knowing the first HTML part in another branch of that multipart/alternative; attachments and
 * attached messages left out; at most MAX_PART_DEPTH deep and MAX_PARTS parts.
 */
function textParts(payload: GmailPart | undefined): Candidate[] {
  let seen = 0;
  const walk = (part: GmailPart, depth: number): Candidate[] => {
    if (!part || typeof part !== "object" || seen >= MAX_PARTS) return [];
    seen++;
    const type = mimeTypeOf(part);
    if (type === "text/plain" || type === "text/html") {
      return isAttachment(part) ? [] : [{ part, html: type === "text/html" }];
    }
    if (type.startsWith("message/") && depth > 0) return [];
    if (!Array.isArray(part.parts) || depth >= MAX_PART_DEPTH) return [];
    const branches = part.parts.map((child) => walk(child, depth + 1));
    if (type !== "multipart/alternative") return branches.flat();
    const plain = branches.flatMap((branch, i) => {
      const html = branches.find((other, j) => j !== i && other.some((c) => c.html))?.find((c) => c.html);
      // A plain part in a nested multipart/alternative keeps the HTML nearest to it.
      return branch.filter((c) => !c.html).map((c) => (c.alternative || !html ? c : { ...c, alternative: html }));
    });
    return [...plain, ...branches.flat().filter((c) => c.html)];
  };
  return payload && typeof payload === "object" ? walk(payload, 0) : [];
}

/** Gmail's snippet is HTML-escaped ("I&#39;m"). */
function snippetText(snippet: unknown): string {
  return typeof snippet === "string" ? decodeEntities(snippet.slice(0, 2_000)) : "";
}

/* ---------------------------------------------------------------- headers */

function receivedAt(internalDate: unknown, dateHeader: string | null): Date {
  const ms = typeof internalDate === "string" || typeof internalDate === "number" ? Number(internalDate) : NaN;
  const fromInternal = new Date(Number.isFinite(ms) && ms > 0 ? ms : NaN);
  if (!Number.isNaN(fromInternal.getTime())) return fromInternal;
  // Never seen without internalDate; the Date header is the next best, then the epoch.
  const fromHeader = new Date(Date.parse(dateHeader ?? ""));
  return Number.isNaN(fromHeader.getTime()) ? new Date(0) : fromHeader;
}

/** RFC 2919: the identifier in angle brackets ("JobRadar <alerts.jobradar.example>"), else the value. */
function listIdOf(value: string | null): string | null {
  const text = headerText(value, 500);
  if (!text) return null;
  const inside = /<([^<>]+)>/.exec(text)?.[1]?.trim();
  return (inside || text).slice(0, 255);
}

/** "de-DE, en" → "de". */
function languageOf(value: string | null | undefined): string | null {
  const first = headerText(value, 100).split(",")[0]?.trim().toLowerCase() ?? "";
  const primary = first.split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

