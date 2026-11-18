import "server-only";
import { compile } from "html-to-text";
import { Parser } from "htmlparser2";

/**
 * An HTML mail part to plain text, through html-to-text: no images, link text without the
 * addresses (no URLs dumped into the text), headings as they are written, list items as "• "
 * lines, one table row per line with its cells side by side (mail uses tables for layout, so a
 * column-aligned data table would scramble ordinary text), quoted blocks as "> " lines (which
 * quoted.ts then removes). No word wrap: the reader wraps.
 *
 * Hostile input is cut before it reaches the converter: html-to-text recurses once per open
 * element (a few thousand nested tags overflow the stack) and htmlparser2's bookkeeping grows
 * quadratically with nesting, so the input stops where elements nest deeper than MAX_DEPTH
 * (see the same guard in src/lib/server/parse/extract.ts). The converter gets the input
 * rewritten (rebuildHtml), not as it came: html-to-text parses with its own, older copy of
 * htmlparser2, which nests where the one here closes (a second <a>, <form> or heading) and reads
 * tags inside <iframe>, <noembed>, <noframes> and <plaintext>, so a depth measured on the raw
 * input bounded nothing ("<a>" × 300,000 took 24 seconds). readHtml says when the depth cut, or
 * the MAX_HTML cut, left something out. Never throws.
 */

/** HTML longer than this is cut first (the caller cuts the decoded part at the same size). */
export const MAX_HTML = 1_000_000;

/** Elements may nest this deep; the rest of the input is left out. Real mail nests a few dozen. */
export const MAX_DEPTH = 256;

let converter: ((html: string) => string) | null = null;

function getConverter() {
  converter ??= compile({
    wordwrap: false,
    // Above what rebuildHtml makes of MAX_HTML (at most 6 times as long: '"' in an attribute
    // value becomes "&quot;"), so html-to-text never cuts (and never logs that it did).
    limits: { maxInputLength: MAX_HTML * 8 },
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "hr", format: "skip" },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
      { selector: "h4", options: { uppercase: false } },
      { selector: "h5", options: { uppercase: false } },
      { selector: "h6", options: { uppercase: false } },
      { selector: "ul", options: { itemPrefix: "• " } },
      { selector: "table", format: "block", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
      { selector: "tr", format: "block", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
      { selector: "td", format: "inlineSurround", options: { prefix: "", suffix: "  " } },
      { selector: "th", format: "inlineSurround", options: { prefix: "", suffix: "  " } },
    ],
  });
  return converter;
}

// Elements without content or end tag: the same list in both versions of htmlparser2.
const VOID = new Set([
  ...["area", "base", "basefont", "br", "col", "command", "embed", "frame", "hr", "img"],
  ...["input", "isindex", "keygen", "link", "meta", "param", "source", "track", "wbr"],
]);
// Elements whose content htmlparser2 reads as raw text, which a mail client does not show.
const HIDDEN_RAW_TEXT = new Set(["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes"]);
const PLAIN_NAME = /^[a-z][a-z0-9-]*$/i;
const ATTRIBUTE_NAME = /^[a-z_:][a-z0-9_:.-]*$/i;

/**
 * The input as markup that any HTML parser reads into the tree htmlparser2 here built, cut
 * before the first element that would nest deeper than MAX_DEPTH (`cut`). Every element is
 * closed explicitly where it ended, "<" in text and '"' in attribute values are escaped, and
 * comments, declarations, the content of HIDDEN_RAW_TEXT elements and odd tag or attribute
 * names go; entities stay as they came. So html-to-text's parser cannot nest deeper than this
 * one counted (see the top of this file).
 */
export function rebuildHtml(html: string): { html: string; cut: boolean } {
  const out: string[] = [];
  const open: string[] = [];
  let cut = false;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (cut) return;
        if (open.length >= MAX_DEPTH) {
          cut = true;
          parser.pause(); // write() returns after this tag, and end() then reads nothing more
          return;
        }
        const tag = PLAIN_NAME.test(name) ? name : "span";
        let start = `<${tag}`;
        for (const [key, value] of Object.entries(attribs)) {
          if (ATTRIBUTE_NAME.test(key)) start += ` ${key}="${value.replace(/"/g, "&quot;")}"`;
        }
        out.push(`${start}>`);
        if (!VOID.has(name)) open.push(tag);
      },
      ontext(text) {
        if (!cut && !HIDDEN_RAW_TEXT.has(open.at(-1) ?? "")) out.push(text.replace(/</g, "&lt;"));
      },
      onclosetag(name) {
        // htmlparser2 closes elements innermost first, so the one closing is the last opened.
        if (!cut && !VOID.has(name) && open.length) out.push(`</${open.pop()}>`);
      },
    },
    { decodeEntities: false },
  );
  parser.write(html);
  parser.end();
  for (let i = open.length - 1; i >= 0; i--) out.push(`</${open[i]}>`);
  return { html: out.join(""), cut };
}

/** Last resort when the converter fails: tags out, the common entities decoded. Linear time. */
function crudeText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>|<\/(?:p|div|tr|li)>/gi, "\n").replace(/<[^<>]*>/g, " "));
}

/** HTML entities in a short text such as Gmail's snippet ("I&#39;m"): numeric and the usual names. */
export function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    zwnj: "‌",
    zwj: "‍",
    shy: "­",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    euro: "€",
  };
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (all, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return named[ref.toLowerCase()] ?? all;
  });
}

/** Readable text of an HTML part, and whether a cut (MAX_HTML, MAX_DEPTH) left some out. */
export function readHtml(html: string): { text: string; truncated: boolean } {
  const capped = html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html;
  const { html: input, cut } = rebuildHtml(capped);
  const truncated = capped.length < html.length || cut;
  try {
    return { text: getConverter()(input), truncated };
  } catch {
    return { text: crudeText(input), truncated };
  }
}

/** Readable text of an HTML part (see the top of this file). */
export function htmlToText(html: string): string {
  return readHtml(html).text;
}
