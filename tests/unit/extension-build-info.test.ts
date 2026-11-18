import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openExtensionZip, readExtensionBuild } from "@/lib/server/extension/build-info";

// The built extension the server hands out (src/lib/server/extension/build-info.ts), read from a
// dist directory of its own under the system's temp directory.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A dist directory with these files: a manifest (object, or raw text) and the zip's bytes. */
function dist(files: { manifest?: unknown; zip?: Buffer } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "extension-dist-"));
  dirs.push(dir);
  if (files.manifest !== undefined) {
    mkdirSync(path.join(dir, "chrome"));
    const text = typeof files.manifest === "string" ? files.manifest : JSON.stringify(files.manifest);
    writeFileSync(path.join(dir, "chrome", "manifest.json"), text);
  }
  if (files.zip) writeFileSync(path.join(dir, "job-tracker-extension.zip"), files.zip);
  return dir;
}

const ZIP = Buffer.from("PK\u0003\u0004 an invented zip, not a real one");

describe("readExtensionBuild", () => {
  it("reads the version from the built manifest, next to the zip", async () => {
    const dir = dist({ manifest: { manifest_version: 3, version: "1.2.3" }, zip: ZIP });
    expect(await readExtensionBuild(dir)).toEqual({
      version: "1.2.3",
      zipPath: path.join(dir, "job-tracker-extension.zip"),
    });
  });

  it("is null without a build, half a build, or a manifest without a Chrome version", async () => {
    expect(await readExtensionBuild(path.join(tmpdir(), "no-such-extension-dist-invented"))).toBeNull();
    expect(await readExtensionBuild(dist())).toBeNull();
    expect(await readExtensionBuild(dist({ manifest: { version: "1.0" } }))).toBeNull();
    expect(await readExtensionBuild(dist({ zip: ZIP }))).toBeNull();
    for (const manifest of [
      "{not json",
      null,
      [],
      {},
      { version: 1 },
      { version: "" },
      { version: "1.0.0-beta" },
      { version: "01.2" },
      { version: "1.2.3.4.5" },
      { version: "1.65536" },
      { version: '1"; filename="x' },
    ]) {
      expect(await readExtensionBuild(dist({ manifest, zip: ZIP })), JSON.stringify(manifest)).toBeNull();
    }
  });

  it("accepts Chrome's version forms", async () => {
    for (const version of ["1", "0.1", "1.0.0", "2.10.0.65535"]) {
      expect((await readExtensionBuild(dist({ manifest: { version }, zip: ZIP })))?.version).toBe(version);
    }
  });

  it("reads again on every call, so a new build is found", async () => {
    const dir = dist({ manifest: { version: "1.0.0" }, zip: ZIP });
    expect((await readExtensionBuild(dir))?.version).toBe("1.0.0");
    writeFileSync(path.join(dir, "chrome", "manifest.json"), JSON.stringify({ version: "1.0.1" }));
    expect((await readExtensionBuild(dir))?.version).toBe("1.0.1");
  });
});

/** This process's open files that are `file` (Linux: /proc/self/fd). */
function openCopies(file: string): number {
  return readdirSync("/proc/self/fd").filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === file;
    } catch {
      return false; // closed meanwhile, e.g. the directory handle readdirSync used
    }
  }).length;
}

describe("openExtensionZip", () => {
  it("reads the zip with its version", async () => {
    const zip = await openExtensionZip(dist({ manifest: { version: "1.4.0" }, zip: ZIP }));
    expect(zip?.version).toBe("1.4.0");
    expect(Buffer.from(await new Response(zip!.bytes).arrayBuffer())).toEqual(ZIP);
  });

  it("is null without a build", async () => {
    expect(await openExtensionZip(dist({ manifest: { version: "1.4.0" } }))).toBeNull();
  });

  // Next.js answers HEAD with the GET handler and never reads or cancels the body: a file
  // opened for it would stay open until garbage collection.
  it.skipIf(!existsSync("/proc/self/fd"))("leaves no file open when the zip is never sent", async () => {
    const dir = dist({ manifest: { version: "1.4.0" }, zip: ZIP });
    const file = path.join(dir, "job-tracker-extension.zip");
    for (let i = 0; i < 3; i++) expect(await openExtensionZip(dir)).not.toBeNull();
    expect(openCopies(file)).toBe(0);
  });

  it("has the bytes before it returns, so a deploy that rewrites the zip cannot change the download", async () => {
    const dir = dist({ manifest: { version: "1.4.0" }, zip: ZIP });
    const zip = await openExtensionZip(dir);
    writeFileSync(path.join(dir, "job-tracker-extension.zip"), "PK another build");
    expect(Buffer.from(await new Response(zip!.bytes).arrayBuffer())).toEqual(ZIP);
    rmSync(dir, { recursive: true });
    expect(Buffer.from(zip!.bytes)).toEqual(ZIP);
  });
});

// Turbopack traces the files a server module may read into its routes' .nft.json, following
// path.join() and file system calls. These paths come from `dir`, which it cannot work out, and
// unmarked calls traced the whole project (about 550 files in every /api/extension route). The
// build is what shows it; this keeps the comments that prevent it from being dropped.
describe("build-info.ts and Turbopack's file tracing", () => {
  it("marks the first argument of every path and file system call /* turbopackIgnore: true */", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/lib/server/extension/build-info.ts"), "utf8");
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const fsCall = /\b(join|resolve|relative|readFile|stat|lstat|open|access|readdir|createReadStream|realpath)\(([^)]*)/g;
    const calls = [...code.matchAll(fsCall)];
    expect(calls.map(([, name]) => name).sort()).toEqual(expect.arrayContaining(["join", "readFile", "stat"]));
    for (const [call, , args] of calls) expect(args.trimStart(), call).toMatch(/^\/\* turbopackIgnore: true \*\//);
  });
});
