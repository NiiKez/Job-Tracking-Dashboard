import type { PageSnapshot } from "@/lib/types";
import { readPage } from "./read-page";

/**
 * The script the popup injects into the job page (bundled by extension/build.mjs to
 * page/read-page.js). It only defines a function; the popup calls it with a second
 * executeScript and gets the snapshot back. Both run in the extension's isolated world, so the
 * page's own scripts can neither see nor replace the function.
 *
 * Injecting it again (the popup opened twice on one tab) just defines the function again: the
 * bundle is one function scope with nothing at the top level, and it does nothing else when it
 * loads. That matters because executeScript({ files }) runs it as a classic script in the global
 * scope, where a top-level `const` or `let` would be declared a second time and throw
 * (tests/extension/page/entry.test.ts runs the built file twice that way).
 */

declare global {
  /** Set by page/read-page.js in the tab's isolated world; reads the page when called. */
  var __jobTrackerReadPage: (() => PageSnapshot) | undefined;
}

globalThis.__jobTrackerReadPage = () =>
  readPage(document, new URL(location.href), selectionText());

/** The text the user selected in the page, "" when none. */
function selectionText(): string {
  try {
    return globalThis.getSelection?.()?.toString() ?? "";
  } catch {
    return "";
  }
}
