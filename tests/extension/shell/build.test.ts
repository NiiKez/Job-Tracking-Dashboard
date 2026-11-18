import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import { hashFolder, hashProblem, readRecordedHash } from "../../../extension/build.mjs";

// extension/build.mjs, run as `npm run build` runs it, but into temporary folders (--out), from
// another working directory and with no environment beyond PATH: the folder Chrome loads, the
// zip the tracker serves, and the e2e variant. Then the build against extension/build-hash.json,
// so a change to what ships (the extension's code, an app file it bundles, a package) can't
// reach users under the version they already have.

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "extension/build.mjs");

let work: string;
const out = (...parts: string[]) => path.join(work, ...parts);

function build(dir: string, ...args: string[]) {
  // Nothing from this environment besides PATH, not even the NODE_ENV the types insist on.
  const env = { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv;
  return run(process.execPath, [SCRIPT, "--out", dir, ...args], { cwd: tmpdir(), env, encoding: "utf8" });
}

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();
}

const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));

let stdout: string;

beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), "extension-build-"));
  const [first] = await Promise.all([build(out("a")), build(out("b")), build(out("a"), "--e2e")]);
  stdout = first.stdout;
}, 60_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("the Chrome build", () => {
  it("prints one line per output", () => {
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^extension \d+\.\d+\.\d+: .*chrome\/ \(\d+ files, [\d.]+ kB\)$/);
    expect(lines[1]).toMatch(/^extension \d+\.\d+\.\d+: .*job-tracker-extension\.zip \([\d.]+ kB\)$/);
  });

  it("has the manifest of the plan", async () => {
    const manifest = await json(out("a/chrome/manifest.json"));
    expect(manifest).toEqual(await json(path.join(ROOT, "extension/manifest.json")));
    expect(manifest).toMatchObject({
      manifest_version: 3,
      name: "Job Tracker",
      minimum_chrome_version: "120",
      permissions: ["activeTab", "scripting", "storage"],
      optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
      action: { default_popup: "popup.html" },
      commands: { _execute_action: { suggested_key: { default: "Alt+Shift+J" } } },
      background: { service_worker: "background.js", type: "module" },
    });
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.description.length).toBeLessThanOrEqual(132); // Chrome's limit
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
  });

  it("contains every file the manifest and the popup name, and no source maps", async () => {
    const dir = out("a/chrome");
    const manifest = await json(path.join(dir, "manifest.json"));
    expect(await files(dir)).toEqual([
      "background.js",
      "connect-bridge.js",
      "icons/icon-128.png",
      "icons/icon-16.png",
      "icons/icon-32.png",
      "icons/icon-48.png",
      "manifest.json",
      "page/read-page.js",
      "popup.css",
      "popup.html",
      "popup.js",
    ]);
    const named = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)] as string[];
    for (const file of named) expect(existsSync(path.join(dir, file)), file).toBe(true);
    const html = await readFile(path.join(dir, "popup.html"), "utf8");
    expect(html).toContain('src="popup.js"');
    expect(html).toContain('href="popup.css"');
    for (const script of ["background.js", "popup.js", "page/read-page.js", "connect-bridge.js"]) {
      const code = await readFile(path.join(dir, script), "utf8");
      expect(code, script).not.toContain("sourceMappingURL");
      expect(code, script).not.toContain("process.env");
    }
  });

  it("zips the folder as one folder, job-tracker-extension/", async () => {
    const zip = unzipSync(await readFile(out("a/job-tracker-extension.zip")));
    const names = Object.keys(zip).sort();
    expect(names).toEqual((await files(out("a/chrome"))).map((f) => `job-tracker-extension/${f}`));
    const manifest = new TextDecoder().decode(zip["job-tracker-extension/manifest.json"]);
    expect(manifest).toBe(await readFile(out("a/chrome/manifest.json"), "utf8"));
  });

  it("gives the same zip, byte for byte, for the same sources", async () => {
    const [a, b] = await Promise.all([readFile(out("a/job-tracker-extension.zip")), readFile(out("b/job-tracker-extension.zip"))]);
    expect(a.equals(b)).toBe(true);
  });
});

describe("the e2e build", () => {
  it("is the same code with <all_urls> and its own name, and no zip", async () => {
    const manifest = await json(out("a/e2e/manifest.json"));
    const shipped = await json(out("a/chrome/manifest.json"));
    expect(manifest).toEqual({ ...shipped, name: `${shipped.name} (e2e)`, host_permissions: ["<all_urls>"] });
    expect(await files(out("a/e2e"))).toEqual(await files(out("a/chrome")));
    for (const script of ["background.js", "popup.js", "page/read-page.js", "connect-bridge.js"]) {
      expect(await readFile(out("a/e2e", script), "utf8"), script).toBe(await readFile(out("a/chrome", script), "utf8"));
    }
    expect(existsSync(out("a/e2e.zip"))).toBe(false);
  });
});

describe("the recorded build, extension/build-hash.json", () => {
  it("is this build, so the popup will offer it as an update", async () => {
    const built = { version: (await json(out("a/chrome/manifest.json"))).version, hash: await hashFolder(out("a/chrome")) };
    const problem = hashProblem(await readRecordedHash(), built);
    if (problem) assert.fail(problem);
  });

  it("hashes what ships, wherever it was built", async () => {
    const hash = await hashFolder(out("a/chrome"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashFolder(out("b/chrome"))).toBe(hash);
  });

  it("changes with any file's bytes or path", async () => {
    const copy = out("hash-copy");
    await cp(out("a/chrome"), copy, { recursive: true });
    const hash = await hashFolder(copy);
    const css = path.join(copy, "popup.css");
    await writeFile(css, `${await readFile(css, "utf8")} `);
    const edited = await hashFolder(copy);
    expect(edited).not.toBe(hash);
    await rename(css, path.join(copy, "popup2.css"));
    expect(await hashFolder(copy)).not.toBe(edited);
  });

  const recorded = { version: "1.2.0", hash: "a".repeat(64) };

  it("asks for a new version when the build changed under the same one", () => {
    const problem = hashProblem(recorded, { version: "1.2.0", hash: "b".repeat(64) });
    expect(problem).toContain("for version 1.2.0");
    expect(problem).toContain('raise "version" in extension/manifest.json');
    expect(problem).toContain("`node extension/build.mjs --record-hash`");
  });

  it("asks only for the record when the version was raised", () => {
    const problem = hashProblem(recorded, { version: "1.2.1", hash: "b".repeat(64) });
    expect(problem).toBe(
      "extension/manifest.json has version 1.2.1, extension/build-hash.json records 1.2.0: " +
        "run `node extension/build.mjs --record-hash` and commit extension/build-hash.json.",
    );
  });

  it("asks for the record when there is none", () => {
    expect(hashProblem(null, recorded)).toContain("`node extension/build.mjs --record-hash`");
  });

  it("is fine with the same version and build", () => {
    expect(hashProblem(recorded, { ...recorded })).toBeNull();
  });
});

describe("failures", () => {
  it("exit non-zero", async () => {
    await expect(build(out("c"), "--unknown")).rejects.toMatchObject({ code: 1 });
  });

  it("refuse to record the e2e build, before building anything", async () => {
    await expect(build(out("d"), "--e2e", "--record-hash")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("--record-hash records the shipped build, not the --e2e one"),
    });
    expect(existsSync(out("d"))).toBe(false);
  });
});
