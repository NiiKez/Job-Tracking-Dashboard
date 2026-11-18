/**
 * Readable text from a part of a job page, as the popup and the server want it: whitespace
 * collapsed, paragraphs (p, headings, lists, tables …) separated by a blank line, other block
 * elements and `<br>` by a line break, list items as "• " lines, and never more than one blank
 * line in a row. It mirrors htmlToText() in src/lib/server/parse/extract.ts, so a description a
 * site reader found looks like one the server read from JSON-LD.
 *
 * It walks the DOM itself instead of using `innerText`: innerText depends on CSS and layout
 * (Chrome leaves out what is collapsed behind "Show more", happy-dom has no layout at all), and
 * a page's full description is what we want, whether or not it is folded away on screen.
 *
 * Left out: script, style, noscript, template and svg, form controls and buttons ("Show more",
 * "Apply" and the like are never part of a posting), and every element below the starting one
 * that is `[hidden]` or `aria-hidden="true"`. `hidden="until-found"` is read all the same: it is
 * how Chrome folds text away while keeping it findable, as "Show more" sections do. The starting
 * element itself is always read: a site may hide the whole page from screen readers while a
 * dialog is open, and a reader that picked an element knows what it wants.
 */

/** Never read: not text, or controls whose labels are not part of a posting. */
const SKIP_TAGS = new Set([
  "audio",
  "button",
  "canvas",
  "datalist",
  "embed",
  "head",
  "iframe",
  "noscript",
  "object",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
  "video",
]);

/** A blank line before and after. */
const PARAGRAPH_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dl",
  "fieldset",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "p",
  "pre",
  "section",
  "table",
]);

/** A line break before and after. */
const LINE_TAGS = new Set([
  "caption",
  "dd",
  "details",
  "div",
  "dt",
  "figcaption",
  "legend",
  "summary",
  "tr",
]);

const LIST_TAGS = new Set(["ul", "ol", "menu"]);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

export interface TextOptions {
  /**
   * Stop reading once the text is longer than this. The result is then longer than `max` too,
   * so a caller can tell a text that is too long without walking all of a huge page.
   */
  max?: number;
  /** A CSS selector for elements below the starting one to leave out, such as a heading. */
  skip?: string;
  /** Start list items with "• " (the default). */
  bullets?: boolean;
  /**
   * Keep the text's own line breaks, as inside `<pre>`: for plain text a site shows with
   * `white-space: pre-line` instead of tags.
   */
  keepLines?: boolean;
}

/** The text of `root` with its line structure (see the header). "" for null. */
export function blockText(root: Element | null | undefined, options: TextOptions = {}): string {
  if (!root) return "";
  if (root.localName === "meta") return collapse(root.getAttribute("content") ?? "");
  const max = options.max ?? Infinity;
  const out = new TextOut(options.bullets ?? true, options.keepLines ?? false);
  // An explicit stack instead of recursion, as a page can nest deeper than the call stack
  // allows. Each element's children are taken one at a time by index, so reading stops at
  // `max` without touching the rest, and no sibling pointers are followed (previousSibling is
  // a search through the parent's children in happy-dom).
  out.open(root);
  const stack: Array<{ el: Element; children: NodeListOf<ChildNode>; next: number }> = [
    { el: root, children: root.childNodes, next: 0 },
  ];
  while (stack.length > 0 && out.length <= max) {
    const frame = stack[stack.length - 1];
    if (frame.next >= frame.children.length) {
      out.close(frame.el);
      stack.pop();
      continue;
    }
    const node = frame.children[frame.next++];
    if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE) {
      out.text(node.nodeValue ?? "");
    } else if (node.nodeType === ELEMENT_NODE && !isLeftOut(node as Element, options.skip)) {
      const el = node as Element;
      out.open(el);
      stack.push({ el, children: el.childNodes, next: 0 });
    }
  }
  return out.result();
}

/** The text of `root` on one line: for titles, company names and places. "" for null. */
export function lineText(root: Element | null | undefined): string {
  return collapse(blockText(root, { max: 10_000, bullets: false }));
}

/** Whitespace, line breaks included, as single spaces; trimmed. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** An element below the starting one that is not read, nor anything inside it. */
function isLeftOut(el: Element, skip: string | undefined): boolean {
  if (SKIP_TAGS.has(el.localName) || isHidden(el)) return true;
  if ((el.getAttribute("aria-hidden") ?? "").trim().toLowerCase() === "true") return true;
  return !!skip && el.matches(skip);
}

/**
 * `[hidden]`, but not `hidden="until-found"` (its value is matched in any case, as browsers do;
 * any other value, an empty one included, hides the element).
 */
function isHidden(el: Element): boolean {
  const hidden = el.getAttribute("hidden");
  return hidden !== null && hidden.toLowerCase() !== "until-found";
}

/**
 * The text being built. Line breaks are owed (`pending`) rather than written, so that empty
 * elements and nested blocks add at most one blank line, and none at the start or the end.
 *
 * The text is kept as a list of parts, joined once at the end, and only the last part is ever
 * looked at or changed: reading the end of one long growing string (endsWith, trimEnd) makes
 * the engine flatten and copy it each time, which turns a page of many short lines quadratic.
 */
class TextOut {
  private parts: string[] = []; // never an empty part
  private size = 0; // their total length
  private pending = 0; // line breaks owed before the next text (2 = a blank line)
  private bullet = false; // the next text starts a list item
  private lists = 0; // open lists: a nested list is not a paragraph of its own
  private pre = 0; // open <pre>: its line breaks are kept

  constructor(
    private readonly bullets: boolean,
    private readonly keepLines: boolean,
  ) {}

  get length() {
    return this.size;
  }

  open(el: Element) {
    const tag = el.localName;
    if (tag === "br") {
      this.pending = Math.min(this.pending + 1, 2);
    } else if (tag === "li") {
      this.lineBreak(1);
      this.bullet = this.bullets;
    } else if (LIST_TAGS.has(tag)) {
      this.lineBreak(this.lists > 0 ? 1 : 2);
      this.lists++;
    } else if (PARAGRAPH_TAGS.has(tag)) {
      this.lineBreak(2);
      if (tag === "pre") this.pre++;
    } else if (LINE_TAGS.has(tag)) {
      this.lineBreak(1);
    }
  }

  close(el: Element) {
    const tag = el.localName;
    if (tag === "li") {
      this.lineBreak(1);
      this.bullet = false; // an empty item leaves no bullet behind
    } else if (LIST_TAGS.has(tag)) {
      this.lists = Math.max(0, this.lists - 1);
      this.lineBreak(this.lists > 0 ? 1 : 2);
    } else if (PARAGRAPH_TAGS.has(tag)) {
      this.lineBreak(2);
      if (tag === "pre") this.pre = Math.max(0, this.pre - 1);
    } else if (LINE_TAGS.has(tag)) {
      this.lineBreak(1);
    } else if ((tag === "td" || tag === "th") && this.size > 0 && !/\s/.test(this.lastChar())) {
      this.push(" ");
    }
  }

  text(raw: string) {
    if (this.pre === 0 && !this.keepLines) return this.add(raw);
    // Inside <pre> each line break counts as a <br>.
    const lines = raw.split(/\r\n?|\n/);
    lines.forEach((line, i) => {
      if (i > 0) this.pending = Math.min(this.pending + 1, 2);
      this.add(line);
    });
  }

  result() {
    return this.parts
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private lineBreak(n: number) {
    this.pending = Math.max(this.pending, n);
  }

  private add(raw: string) {
    let text = raw.replace(/\s+/g, " ");
    if (this.pending > 0 || this.size === 0) text = text.trimStart();
    if (!text) return;
    if (this.pending > 0 && this.size > 0) {
      this.trimEnd();
      this.push("\n".repeat(this.pending));
    }
    this.pending = 0;
    if (this.bullet) {
      this.push("• ");
      this.bullet = false;
    }
    if (this.lastChar() === " " && text.startsWith(" ")) text = text.slice(1);
    this.push(text);
  }

  private push(part: string) {
    if (!part) return;
    this.parts.push(part);
    this.size += part.length;
  }

  /** The last character written; "" before the first. */
  private lastChar() {
    const last = this.parts[this.parts.length - 1];
    return last ? last[last.length - 1] : "";
  }

  /** Removes trailing whitespace, as String.trimEnd() on the whole text would. */
  private trimEnd() {
    while (this.parts.length > 0) {
      const last = this.parts[this.parts.length - 1];
      const trimmed = last.trimEnd();
      this.size -= last.length - trimmed.length;
      if (trimmed) {
        this.parts[this.parts.length - 1] = trimmed;
        return;
      }
      this.parts.pop();
    }
  }
}
