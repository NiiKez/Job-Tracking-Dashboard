// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://jobs.lever.co/fernhillgames/3f6c1d2e-0000-4000-8000-00000000abcd" }
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { fixture } from "./load";

// The injected script as the popup uses it: page/read-page.js, as extension/build.mjs builds it,
// is run in the tab, then globalThis.__jobTrackerReadPage() is called. The popup may inject it
// into the same tab more than once.

const ROOT = path.resolve(__dirname, "../../..");

/** page/read-page.js from a real build (extension/build.mjs, into a temporary folder). */
function built(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "read-page-"));
  try {
    execFileSync(process.execPath, [path.join(ROOT, "extension/build.mjs"), "--out", dir], { stdio: "pipe" });
    return readFileSync(path.join(dir, "chrome/page/read-page.js"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Runs the script as executeScript({ files }) does: a classic script in the global scope (here
 * the test's, where happy-dom's window is), not in a function. A top-level `const` or `let`
 * would be declared there, and a second injection would throw.
 */
function inject(code: string) {
  new vm.Script(code, { filename: "page/read-page.js" }).runInThisContext();
}

let code = "";

beforeAll(() => {
  code = built();
  document.documentElement.innerHTML = fixture("lever.html").documentElement.innerHTML;
}, 30_000);

describe("page/read-page.js", () => {
  it("defines the reader function and nothing else at the top level", () => {
    const before = new Set(Object.keys(globalThis));
    inject(code);
    const added = Object.keys(globalThis).filter((key) => !before.has(key));
    expect(added).toEqual(["__jobTrackerReadPage"]);
    expect(typeof globalThis.__jobTrackerReadPage).toBe("function");
  });

  it("reads the open page: its address, the site reader's fields and the selection", () => {
    const description = document.querySelector('[data-qa="job-description"]')!;
    const range = document.createRange();
    range.selectNodeContents(description.firstElementChild!);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);

    const snapshot = globalThis.__jobTrackerReadPage!();
    expect(snapshot.url).toBe(location.href);
    expect(snapshot.title).toBe("Fernhill Games - Senior Gameplay Programmer");
    expect(snapshot.site?.reader).toBe("lever");
    expect(snapshot.site?.fields.title).toBe("Senior Gameplay Programmer");
    expect(snapshot.selection).toBe("Fernhill Games makes cozy strategy games for PC and consoles.");
    getSelection()?.removeAllRanges();
  });

  it("can be injected again into the same page", () => {
    const first = globalThis.__jobTrackerReadPage!();
    expect(() => inject(code)).not.toThrow();
    expect(() => inject(code)).not.toThrow();
    expect(globalThis.__jobTrackerReadPage!()).toEqual(first);
    expect(first.selection).toBe("");
  });

  it("returns a snapshot that survives structured cloning (executeScript's result)", () => {
    const snapshot = globalThis.__jobTrackerReadPage!();
    expect(structuredClone(snapshot)).toEqual(snapshot);
  });

  it("stays small: no server code in the bundle", () => {
    expect(code.length).toBeLessThan(60_000);
    expect(code).not.toMatch(/server-only|htmlparser2|postgres/);
  });
});
