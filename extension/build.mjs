#!/usr/bin/env node
/*
 * Builds the Chrome extension (docs/plan/4-chrome-extension.md).
 *
 *   node extension/build.mjs          dist/chrome/ (Load unpacked) and dist/job-tracker-extension.zip,
 *                                     the zip the tracker serves at GET /api/extension/download
 *   node extension/build.mjs --e2e    dist/e2e/: the same code, plus host_permissions <all_urls>,
 *                                     because Playwright can't click the toolbar icon that grants
 *                                     activeTab. No zip.
 *   --out <dir>                       writes into <dir> instead of extension/dist (the tests do)
 *   --record-hash                     after the build, writes the manifest's version and the hash of
 *                                     dist/chrome/ (hashFolder below) to extension/build-hash.json.
 *                                     Not with --e2e.
 *
 * esbuild bundles the TypeScript, resolving "@/…" to src/ as tsconfig.json does, so the
 * extension shares the app's types and pure helpers. The zip holds one folder,
 * job-tracker-extension/, with fixed file times: the same sources give the same bytes.
 * Plain Node, no environment variables, any working directory. Any error exits non-zero.
 *
 * The version: the popup offers an update only when the server's version is newer than its own,
 * so every change to what ships needs a new version, also one that comes from an app file the
 * bundles import (src/lib/status.ts, …) or from a package (React, esbuild's output). The committed
 * extension/build-hash.json records which build belongs to which version, and
 * tests/extension/shell/build.test.ts fails when a fresh build differs from it (hashProblem).
 */
import { build } from "esbuild";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ZIP_FOLDER = "job-tracker-extension";
// Zip times are local wall-clock fields; building the date from fields keeps them the same in every time zone.
const ZIP_TIME = new Date(2026, 0, 1, 0, 0, 0);
/** The committed record of the shipped build: { version, hash }. */
const HASH_FILE = path.join(HERE, "build-hash.json");
const RECORD_COMMAND = "node extension/build.mjs --record-hash";

/** Each bundle: entry (under extension/src), output (in the build folder), format. */
const BUNDLES = [
  { entry: "background.ts", out: "background.js", format: "esm" },
  { entry: "popup/main.tsx", out: "popup.js", format: "iife" },
  { entry: "page/entry.ts", out: "page/read-page.js", format: "iife" },
  { entry: "connect-bridge.ts", out: "connect-bridge.js", format: "iife" },
];

/** Files copied as they are: source (under extension/) → output. */
const STATIC_FILES = [
  ["src/popup/popup.html", "popup.html"],
  ["src/popup/popup.css", "popup.css"],
  ...[16, 32, 48, 128].map((size) => [`icons/icon-${size}.png`, `icons/icon-${size}.png`]),
];

async function bundle(outDir) {
  await Promise.all(
    BUNDLES.map(({ entry, out, format }) =>
      build({
        absWorkingDir: ROOT,
        entryPoints: [path.join(HERE, "src", entry)],
        outfile: path.join(outDir, out),
        bundle: true,
        format,
        platform: "browser",
        target: "chrome120",
        tsconfig: path.join(ROOT, "tsconfig.json"),
        define: { "process.env.NODE_ENV": '"production"' },
        // Minified: React 19's react-dom is published unminified, about 650 kB of the popup.
        // The readable source is extension/src. License notices (React's MIT header) stay, at
        // the end of each file.
        minify: true,
        legalComments: "eof",
        charset: "utf8",
        logLevel: "warning",
      }),
    ),
  );
}

async function writeManifest(outDir, e2e) {
  const manifest = JSON.parse(await readFile(path.join(HERE, "manifest.json"), "utf8"));
  if (e2e) {
    manifest.name = `${manifest.name} (e2e)`;
    manifest.host_permissions = ["<all_urls>"];
  }
  await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.version;
}

async function copyStatic(outDir) {
  for (const [from, to] of STATIC_FILES) {
    await mkdir(path.dirname(path.join(outDir, to)), { recursive: true });
    await copyFile(path.join(HERE, from), path.join(outDir, to));
  }
}

/** Every file under `dir`, as sorted paths relative to it with "/" separators. */
async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

async function zipFolder(dir, zipPath) {
  const files = {};
  for (const name of await listFiles(dir)) {
    files[`${ZIP_FOLDER}/${name}`] = [await readFile(path.join(dir, name)), { mtime: ZIP_TIME }];
  }
  const zip = zipSync(files, { level: 9 });
  await writeFile(zipPath, zip);
  return zip.byteLength;
}

/**
 * The SHA-256 (hex) of a build folder: of the `sha256sum` lines ("<hex>  <path>\n") of every
 * file in it, sorted by path. So it covers every file's path and bytes, and nothing else (no
 * times, no folder location). The same as, in the folder,
 *   find . -type f -printf '%P\n' | LC_ALL=C sort | xargs sha256sum | sha256sum
 * The folder, not the zip: a new fflate could compress the same files differently.
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function hashFolder(dir) {
  let lines = "";
  for (const name of await listFiles(dir)) {
    lines += `${createHash("sha256").update(await readFile(path.join(dir, name))).digest("hex")}  ${name}\n`;
  }
  return createHash("sha256").update(lines).digest("hex");
}

/**
 * extension/build-hash.json, or null when it is missing or not { version, hash } (say, a merge
 * left conflict markers in it).
 * @returns {Promise<{ version: string, hash: string } | null>}
 */
export async function readRecordedHash() {
  let text;
  try {
    text = await readFile(HASH_FILE, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const { version, hash } = JSON.parse(text);
    return typeof version === "string" && typeof hash === "string" ? { version, hash } : null;
  } catch {
    return null;
  }
}

/**
 * What to do when a fresh build of the shipped extension (`built`) is not the one recorded in
 * extension/build-hash.json (`recorded`, null when the file is missing); null when it is.
 * @param {{ version: string, hash: string } | null} recorded
 * @param {{ version: string, hash: string }} built
 * @returns {string | null}
 */
export function hashProblem(recorded, built) {
  if (!recorded) return `extension/build-hash.json is missing or unreadable: run \`${RECORD_COMMAND}\` and commit it.`;
  if (recorded.version === built.version && recorded.hash === built.hash) return null;
  if (recorded.version === built.version) {
    return [
      `The built extension is not the one extension/build-hash.json records for version ${built.version}.`,
      "It also bundles files from src/ and npm packages, so a change there changes it too.",
      "The popup offers an update only when the version changes: raise \"version\" in extension/manifest.json,",
      `then run \`${RECORD_COMMAND}\` and commit both files.`,
      "(If this branch has already raised the version from the one on main, only run the command.)",
    ].join(" ");
  }
  return (
    `extension/manifest.json has version ${built.version}, extension/build-hash.json records ${recorded.version}: ` +
    `run \`${RECORD_COMMAND}\` and commit extension/build-hash.json.`
  );
}

async function recordHash(outDir, version) {
  const recorded = await readRecordedHash();
  const hash = await hashFolder(outDir);
  await writeFile(HASH_FILE, `${JSON.stringify({ version, hash }, null, 2)}\n`);
  console.log(`extension ${version}: sha256 ${hash} in ${shown(HASH_FILE)}`);
  if (recorded && recorded.version === version && recorded.hash !== hash) {
    console.warn(
      `warning: ${shown(HASH_FILE)} recorded another build for version ${version}. If ${version} is ` +
        "already on main, raise the version in extension/manifest.json and run this again.",
    );
  }
}

async function folderSize(dir) {
  const names = await listFiles(dir);
  const sizes = await Promise.all(names.map(async (name) => (await stat(path.join(dir, name))).size));
  return { count: names.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
/** A path for the summary: relative when it is under the working directory, else absolute. */
function shown(p) {
  const relative = path.relative(process.cwd(), p);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : p;
}

async function main() {
  const { values } = parseArgs({
    options: {
      e2e: { type: "boolean", default: false },
      out: { type: "string" },
      "record-hash": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.e2e && values["record-hash"]) throw new Error("--record-hash records the shipped build, not the --e2e one");
  const distDir = values.out ? path.resolve(values.out) : path.join(HERE, "dist");
  const outDir = path.join(distDir, values.e2e ? "e2e" : "chrome");

  // Start clean, so nothing from an earlier build ships.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await bundle(outDir);
  await copyStatic(outDir);
  const version = await writeManifest(outDir, values.e2e);

  const { count, bytes } = await folderSize(outDir);
  console.log(`extension ${version}${values.e2e ? " (e2e)" : ""}: ${shown(outDir)}/ (${count} files, ${kb(bytes)})`);
  if (!values.e2e) {
    const zipPath = path.join(distDir, "job-tracker-extension.zip");
    console.log(`extension ${version}: ${shown(zipPath)} (${kb(await zipFolder(outDir, zipPath))})`);
  }
  if (values["record-hash"]) await recordHash(outDir, version);
}

/** Run as a script (`node extension/build.mjs`, also through a symlinked path), not imported (the tests). */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    // import.meta.url is the real path; argv[1] keeps symlinks.
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((error) => {
    // esbuild has printed its own errors with file and line already.
    console.error(`extension build failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
