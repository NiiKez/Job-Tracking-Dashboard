// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { blockText, lineText } from "../../../extension/src/page/text";
import { page } from "./load";

/** The text of the body of a page holding `html`. */
function text(html: string, options?: Parameters<typeof blockText>[1]) {
  return blockText(page(html).body, options);
}

describe("blockText", () => {
  it("collapses whitespace, also across inline elements", () => {
    expect(text("  Senior \n\t Engineer  ")).toBe("Senior Engineer");
    expect(text("Build <b>fast</b>,  <i> safe </i> tools")).toBe("Build fast, safe tools");
    expect(text("<span>Kotlin</span><span>/Java</span>")).toBe("Kotlin/Java");
  });

  it("puts a line break around blocks and a blank line around paragraphs", () => {
    expect(text("<div>one</div><div>two</div>")).toBe("one\ntwo");
    expect(text("<p>one</p><p>two</p>")).toBe("one\n\ntwo");
    expect(text("<h3>Tasks</h3>Build things")).toBe("Tasks\n\nBuild things");
    expect(text("before<div>inside</div>after")).toBe("before\ninside\nafter");
  });

  it("turns <br> into a line break, two into a blank line, and never more", () => {
    expect(text("one<br>two")).toBe("one\ntwo");
    expect(text("one<br><br>two")).toBe("one\n\ntwo");
    expect(text("one<br><br><br><br>two")).toBe("one\n\ntwo");
  });

  it("puts list items on their own lines with a bullet", () => {
    expect(text("<p>Tasks</p><ul><li>one</li><li> two </li></ul><p>End</p>")).toBe(
      "Tasks\n\n• one\n• two\n\nEnd",
    );
    expect(text("<ol><li>first</li><li></li><li>third</li></ol>")).toBe("• first\n• third");
  });

  it("keeps a nested list in its parent's lines", () => {
    expect(text("<ul><li>parent<ul><li>child</li></ul></li><li>next</li></ul>")).toBe(
      "• parent\n• child\n• next",
    );
  });

  it("allows at most one blank line in a row, and none at the start or end", () => {
    expect(text("<p></p><p>one</p><p><br></p><p>&nbsp;</p><div><p>two</p></div><p></p>")).toBe(
      "one\n\ntwo",
    );
    expect(text("<div><div><div>deep</div></div></div><section><p>next</p></section>")).toBe(
      "deep\n\nnext",
    );
  });

  it("separates table cells with a space and rows with a line break", () => {
    expect(text("<table><tr><td>Salary</td><td>60k</td></tr><tr><th>Start</th><td>May</td></tr></table>")).toBe(
      "Salary 60k\nStart May",
    );
  });

  it("keeps the line breaks inside <pre>", () => {
    expect(text("<pre>line one\n  line two\n\n\n\nline three</pre>")).toBe(
      "line one\nline two\n\nline three",
    );
  });

  it("keeps the text's own line breaks when asked (keepLines)", () => {
    expect(text("<p>Wir suchen.\n\nAufgaben:\n- eins\n- zwei</p>", { keepLines: true })).toBe(
      "Wir suchen.\n\nAufgaben:\n- eins\n- zwei",
    );
    expect(text("<p>Wir suchen.\n\nAufgaben:</p>")).toBe("Wir suchen. Aufgaben:");
  });

  it("skips scripts, styles, templates, svg and controls", () => {
    const html = [
      "<p>Kept</p>",
      "<script>var x = 1;</script>",
      "<style>p { color: red }</style>",
      "<noscript>Enable JavaScript</noscript>",
      "<template><p>Later</p></template>",
      "<svg><title>icon</title><text>svg text</text></svg>",
      "<button>Show more</button>",
      "<select><option>English</option></select>",
      "<textarea>draft</textarea>",
      "<p>Also kept</p>",
    ].join("");
    expect(text(html)).toBe("Kept\n\nAlso kept");
  });

  it("skips [hidden] and aria-hidden elements below the start, but reads the start itself", () => {
    expect(
      text('<p>Kept</p><p hidden>Hidden</p><span aria-hidden="true">Icon</span><div aria-hidden="false">Shown</div>'),
    ).toBe("Kept\n\nShown");
    const doc = page('<div id="root" aria-hidden="true"><p>Under a dialog</p><p hidden>No</p></div>');
    expect(blockText(doc.getElementById("root"))).toBe("Under a dialog");
  });

  it('reads what hidden="until-found" folds away, which the browser keeps findable', () => {
    expect(
      text('<p>Intro</p><div hidden="until-found"><p>Folded</p></div><p hidden="Until-Found">Also folded</p>'),
    ).toBe("Intro\n\nFolded\n\nAlso folded");
    // Any other value hides the element, as the browser does.
    expect(text('<p>Kept</p><p hidden="">a</p><p hidden="hidden">b</p><p hidden="until">c</p>')).toBe("Kept");
  });

  it("leaves out elements that match `skip`", () => {
    expect(text("<h2>About the job</h2><p>Text</p>", { skip: "h2" })).toBe("Text");
  });

  it("stops reading once the text is longer than `max`", () => {
    const paragraphs = Array.from({ length: 1000 }, (_, i) => `<p>Paragraph ${i}</p>`).join("");
    const out = text(paragraphs, { max: 100 });
    expect(out.length).toBeGreaterThan(100);
    expect(out.length).toBeLessThan(200);
    expect(out.startsWith("Paragraph 0\n\nParagraph 1")).toBe(true);
  });

  it("reads a deeply nested page without running out of stack", () => {
    const depth = 20_000;
    const doc = page("");
    let parent: Element = doc.body;
    for (let i = 0; i < depth; i++) {
      const child = doc.createElement(i % 2 ? "div" : "span");
      parent.appendChild(child);
      parent = child;
    }
    parent.textContent = "bottom";
    expect(blockText(doc.body)).toBe("bottom");
  });

  it("returns an empty string for null and for an empty element", () => {
    expect(blockText(null)).toBe("");
    expect(text("<div> <span> </span> </div>")).toBe("");
  });
});

describe("lineText", () => {
  it("puts everything on one line, without bullets", () => {
    expect(lineText(page("<h1>Senior<br>Engineer</h1><ul><li>Berlin</li><li>Remote</li></ul>").body)).toBe(
      "Senior Engineer Berlin Remote",
    );
  });

  it("reads a <meta> element's content (microdata)", () => {
    const doc = page('<div><meta itemprop="name" content="  Acme   GmbH "></div>');
    expect(lineText(doc.querySelector("meta"))).toBe("Acme GmbH");
  });
});

describe("speed on long pages", () => {
  /** Milliseconds `read` takes, logged so a slow run shows in the output. */
  function timed(label: string, read: () => string): { ms: number; text: string } {
    const start = performance.now();
    const text = read();
    const ms = performance.now() - start;
    console.info(`${label}: ${ms.toFixed(1)} ms, ${text.length} characters`);
    return { ms, text };
  }

  it("reads 50,000 short lines in linear time", () => {
    const doc = page(`<main>${Array.from({ length: 50_000 }, (_, i) => `<div>line ${i}</div>`).join("")}</main>`);
    const { ms, text } = timed("50,000 lines", () => blockText(doc.querySelector("main")));
    expect(text.startsWith("line 0\nline 1\nline 2\n")).toBe(true);
    expect(text.endsWith("line 49999")).toBe(true);
    expect(ms).toBeLessThan(1_000);
  });

  it("reads 50,000 inline spans in linear time", () => {
    const doc = page(`<main>${Array.from({ length: 50_000 }, (_, i) => `<span>word${i} </span>`).join("")}</main>`);
    const { ms, text } = timed("50,000 spans", () => blockText(doc.querySelector("main")));
    expect(text.startsWith("word0 word1 word2 ")).toBe(true);
    expect(text.endsWith("word49999")).toBe(true);
    expect(text).not.toContain("  ");
    expect(ms).toBeLessThan(1_000);
  });

  it("stops at the cap without walking the rest of a huge page", () => {
    const paragraph = (i: number) => `<p>paragraph number ${i} of a page far too long</p>`;
    const doc = page(`<main>${Array.from({ length: 30_000 }, (_, i) => paragraph(i)).join("")}</main>`);
    const main = doc.querySelector("main");
    const all = timed("30,000 paragraphs, no cap", () => blockText(main));
    const capped = timed("30,000 paragraphs, cap of 100,000", () => blockText(main, { max: 100_000 }));
    expect(all.text.length).toBeGreaterThan(1_000_000);
    expect(capped.text.length).toBeGreaterThan(100_000);
    expect(capped.text.length).toBeLessThan(100_100);
    expect(all.text.startsWith(capped.text)).toBe(true);
    expect(capped.ms).toBeLessThan(1_000);
  });
});
