import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEMO_ENTRY_ACTION, DemoEntryActions, demoEntryError } from "@/components/auth/demo-entry";

// The public demo's entry page (src/app/login/demo/page.tsx, src/components/auth/demo-entry.tsx):
// a plain HTML form that posts to /auth/demo, which works without JavaScript, and the lines for
// the ?error= codes the route answers with. The page in a browser is tests/e2e/demo/entry.spec.ts.

const text = (html: string) => html.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'");

describe("the demo's entry form", () => {
  it("is a plain POST form to /auth/demo with one submit button", () => {
    const html = renderToStaticMarkup(createElement(DemoEntryActions));
    expect(DEMO_ENTRY_ACTION).toBe("/auth/demo");
    const form = /<form([^>]*)>/.exec(html)?.[1] ?? "";
    expect(form).toContain(' method="post"');
    expect(form).toContain(' action="/auth/demo"');
    expect(form).not.toContain("target=");
    expect(html).toMatch(/<button[^>]* type="submit"[^>]*>Try the demo<\/button>/);
    expect(html).not.toMatch(/ disabled(=""|>| )/);
    expect(html).not.toContain('role="alert"');
    // Nothing the form sends: no field, so no value to check or leak.
    expect(html).not.toContain("<input");
  });

  it("says what went wrong above the button", () => {
    const busy = renderToStaticMarkup(createElement(DemoEntryActions, { error: "busy" }));
    expect(busy).toContain('role="alert"');
    expect(text(busy)).toContain("The demo is busy right now. Try again in a minute.");
    expect(busy.indexOf("role=\"alert\"")).toBeLessThan(busy.indexOf("<form"));
    expect(text(renderToStaticMarkup(createElement(DemoEntryActions, { error: "failed" })))).toContain(
      "The demo couldn't start. Try again.",
    );
    expect(demoEntryError("something-else")).toBe("The demo couldn't start. Try again.");
  });

  it("is a static page: no environment, no server code, the form in the Suspense fallback", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/app/login/demo/page.tsx"), "utf8");
    expect(source).not.toMatch(/process\.env|@\/lib\/server|searchParams|connection\(/);
    expect(source).toContain("<Suspense fallback={<DemoEntryActions />}>");
    expect(source).toContain('href="/privacy"');
  });
});
