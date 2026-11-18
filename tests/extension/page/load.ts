import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Documents for the page-reader tests, parsed by happy-dom's DOMParser (the test files run in
 * the happy-dom environment). Scripts in them never run.
 */

/** A saved page from fixtures/. */
export function fixture(name: string): Document {
  return parse(readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

/** A small page made in the test. */
export function page(body: string, head = ""): Document {
  return parse(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`);
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}
