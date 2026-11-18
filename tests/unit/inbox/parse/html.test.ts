import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { MAX_DEPTH, decodeEntities, htmlToText, readHtml, rebuildHtml } from "@/lib/server/inbox/parse/html";
import { sample } from "./build";

describe("htmlToText", () => {
  it("keeps link text but not the addresses, and drops images", () => {
    const text = htmlToText(
      '<p>See <a href="https://x.example/track?id=1">your application</a> or <a href="https://x.example/">https://x.example/</a>.</p><img src="https://x.example/logo.png" alt="Logo">',
    );
    expect(text).toBe("See your application or https://x.example/.");
  });

  it("writes headings as they are, lists as bullets, and table rows as lines", () => {
    const text = htmlToText(
      "<h1>Your Interview</h1><ul><li>One</li><li>Two</li></ul><table><tr><th>Day</th><th>Time</th></tr><tr><td>Tuesday</td><td>10:00</td></tr></table>",
    );
    expect(text).toContain("Your Interview");
    expect(text).toContain("• One\n• Two");
    expect(text).toMatch(/Day\s+Time\s*\nTuesday\s+10:00/);
  });

  it("does not interleave text from layout tables", () => {
    const text = htmlToText(
      '<table><tr><td><p>Unfortunately we decided to move forward with other candidates.</p></td><td><img src="x"></td></tr></table>',
    );
    expect(text).toContain("Unfortunately we decided to move forward with other candidates.");
  });

  it("drops style, script and head content, and decodes entities", () => {
    const text = htmlToText(
      "<html><head><title>T</title><style>p{color:red}</style></head><body><style>.x{}</style><p>Gr&uuml;&szlig;e &amp; more</p><script>alert(1)</script></body></html>",
    );
    expect(text).toBe("Grüße & more");
  });

  it("writes quoted blocks as '> ' lines", () => {
    expect(htmlToText("<p>Mine</p><blockquote>Theirs</blockquote>")).toMatch(/Mine\n+> Theirs/);
  });

  it("reads a marketing mail", () => {
    const text = htmlToText(sample("marketing-preheader.html"));
    expect(text).toContain("Thank you for your application!");
    expect(text).toContain("View your application");
    expect(text).not.toMatch(/https?:|utm_|\.gif|\.png|@media|mso/);
  });

  it("stops at absurd nesting, quickly and without overflowing the stack", () => {
    const started = Date.now();
    const deep = `${"<div>".repeat(100_000)}deep${"</div>".repeat(100_000)}`;
    expect(() => htmlToText(deep)).not.toThrow();
    const unclosed = `<p>before</p>${"<b>".repeat(300_000)}after`;
    expect(htmlToText(unclosed)).toContain("before");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps normal nesting whole", () => {
    const html = `${"<div>".repeat(MAX_DEPTH - 1)}inside${"</div>".repeat(MAX_DEPTH - 1)}<p>after</p>`;
    expect(rebuildHtml(html)).toEqual({ html, cut: false });
    expect(htmlToText(html)).toMatch(/inside\s+after/);
  });

  it("never throws on junk", () => {
    for (const junk of ["", "<", "<<<<>>>>", "</p></div>", "<a href=", "&#xFFFFFFF; &#0; &bogus;", "\u0000<p>\u0000</p>"]) {
      expect(() => htmlToText(junk)).not.toThrow();
    }
  });
});

describe("decodeEntities", () => {
  it("decodes numeric and the usual named entities", () => {
    expect(decodeEntities("I&#39;m &quot;in&quot; &amp; ready &#x2013; &hellip; &unknown; &#0; &#xD800;")).toBe(
      'I\'m "in" & ready – … &unknown;  ',
    );
  });
});

// html-to-text parses with its own copy of htmlparser2 (an older version when the two differ),
// and that parser decides how deep its walk recurses. These tests read the markup readHtml hands
// to html-to-text with that same parser.
const requireHtmlToText = createRequire(createRequire(import.meta.url).resolve("html-to-text"));
const { parseDocument } = requireHtmlToText("htmlparser2") as typeof import("htmlparser2");

/** How deep elements nest in `html` as html-to-text's parser reads it. */
function converterDepth(html: string): number {
  let max = 0;
  const stack: Array<{ node: { children?: unknown[] }; depth: number }> = [
    { node: parseDocument(html) as never, depth: 0 },
  ];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    max = Math.max(max, depth);
    for (const child of (node.children ?? []) as Array<{ children?: unknown[] }>) {
      if (child.children) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return max;
}

describe("the nesting limit, as html-to-text's own parser sees it", () => {
  // The first seven got past the depth guard when it measured the raw input with this app's
  // htmlparser2 (depth 1), while html-to-text's parser nested every tag: "<a>" × 300,000 took
  // 24 s in the converter. The rest are the other places where parsers tend to differ.
  const n = 2_000;
  const hostile: Record<string, string> = {
    "nested <a>": "<a>".repeat(n),
    "nested headings": "<h1><h2>".repeat(n / 2),
    "nested <form>": "<form>".repeat(n),
    "<iframe> content": `<iframe>${"<div>".repeat(n)}`,
    "<noembed> content": `<noembed>${"<div>".repeat(n)}`,
    "<noframes> content": `<noframes>${"<div>".repeat(n)}`,
    "<plaintext> content": `<plaintext>${"<div>".repeat(n)}`,
    "comment ended by --!>": `<!-- x --!>${"<div>".repeat(n)}`,
    "svg": `<svg>${"<g>".repeat(n)}`,
    "svg self-closing": `<svg><foreignObject>${"<div/>".repeat(n)}`,
    "html self-closing": "<div/>".repeat(n),
    "textarea, title, xmp": `<textarea>${"<b>".repeat(n)}</textarea><title>${"<b>".repeat(n)}</title><xmp>${"<b>".repeat(n)}</xmp>`,
    "plain divs": "<div>".repeat(n),
  };

  it.each(Object.entries(hostile))("%s", (_name, html) => {
    expect(converterDepth(rebuildHtml(html).html)).toBeLessThanOrEqual(MAX_DEPTH);
    expect(() => readHtml(html)).not.toThrow();
  });

  it("shows raw-text content as a mail client does", () => {
    // These elements' content is raw text to this app's htmlparser2; the rewrite passes it on
    // as text, and leaves out what a mail client does not show.
    expect(htmlToText("<p>a</p><iframe><p>fallback</p></iframe><noembed>x</noembed><noframes>y</noframes><p>b</p>")).toBe("a\n\nb");
    expect(htmlToText("<p>a</p><textarea><b>t</b></textarea><xmp><b>x</b></xmp><title>T</title>")).toBe("a");
    expect(htmlToText("<p>1 &lt; 2 &amp; 3 > 2</p><plaintext><b>shown as written</b>")).toBe("1 < 2 & 3 > 2\n\n<b>shown as written</b>");
  });

  it("stays fast on a megabyte of them", () => {
    // About 2 seconds here (all converter time); 24 seconds before the rewrite.
    const started = Date.now();
    expect(readHtml("<a>".repeat(333_000)).truncated).toBe(false);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
