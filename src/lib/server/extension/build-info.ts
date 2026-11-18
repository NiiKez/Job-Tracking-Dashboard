import "server-only";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * The Chrome extension this server hands out (docs/plan/4-chrome-extension.md, "Install").
 * `npm run build` runs extension/build.mjs before `next build`, so a release carries
 *   extension/dist/chrome/manifest.json          the version Settings shows and the popup compares
 *   extension/dist/job-tracker-extension.zip     what GET /api/extension/download sends
 * relative to the directory the server runs in (process.cwd(), the release directory). Without
 * both (development before `npm run build:extension`, or a broken build) there is no build: the
 * version is null and the download answers 404.
 *
 * Read on every call, never remembered: a few hundred bytes of JSON, and a deploy that replaces
 * the release finds the new one. The version is checked to be Chrome's format (one to four
 * numbers with dots), so it is safe in a file name and a header.
 *
 * The zip (about 110 kB) is read whole before it is sent: a deploy that replaces or removes it
 * meanwhile cannot cut the download short, and no file stays open when the body is never read
 * (Next.js answers HEAD with the GET handler and drops the body without cancelling it).
 *
 * Turbopack traces the files a server module may read into its routes' .nft.json: it follows
 * path.join() calls as well as file system calls. The paths here are built from `dir`, which it
 * cannot work out, and it traced the whole project into every /api/extension route. So every
 * path.join() and file system call here marks its first argument with a turbopackIgnore comment,
 * as Next.js's own server code does: the files are read at run time from the release directory
 * and are never traced (tests/unit/extension-build-info.test.ts checks the comments).
 *
 * API
 *   readExtensionBuild(dir?)   { version, zipPath }, or null when there is no build
 *   openExtensionZip(dir?)     { version, bytes }: the zip, read before it is sent; null when
 *                              there is no build
 * `dir` is the dist directory, extension/dist under process.cwd() by default (a test seam).
 */

export interface ExtensionBuild {
  /** The manifest's version, e.g. "1.0.3". */
  version: string;
  zipPath: string;
}

export interface ExtensionZip {
  version: string;
  /** The whole zip. */
  bytes: Uint8Array<ArrayBuffer>;
}

/** Chrome's manifest version: one to four integers from 0 to 65535, no leading zeros. */
const VERSION = /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/;

function defaultDir(): string {
  // The release directory at run time, not a path into the project (see the top of this file).
  return path.join(/* turbopackIgnore: true */ process.cwd(), "extension", "dist");
}

export async function readExtensionBuild(dir: string = defaultDir()): Promise<ExtensionBuild | null> {
  const manifestPath = path.join(/* turbopackIgnore: true */ dir, "chrome", "manifest.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(/* turbopackIgnore: true */ manifestPath, "utf8"));
  } catch {
    return null;
  }
  const version = typeof manifest === "object" && manifest !== null ? (manifest as { version?: unknown }).version : null;
  if (typeof version !== "string" || !isChromeVersion(version)) return null;
  const zipPath = path.join(/* turbopackIgnore: true */ dir, "job-tracker-extension.zip");
  try {
    if (!(await stat(/* turbopackIgnore: true */ zipPath)).isFile()) return null;
  } catch {
    return null;
  }
  return { version, zipPath };
}

export async function openExtensionZip(dir?: string): Promise<ExtensionZip | null> {
  const build = await readExtensionBuild(dir);
  if (!build) return null;
  try {
    // readFile closes the file before it returns.
    return { version: build.version, bytes: await readFile(/* turbopackIgnore: true */ build.zipPath) };
  } catch {
    // Removed since readExtensionBuild looked: no build any more.
    return null;
  }
}

function isChromeVersion(version: string): boolean {
  return VERSION.test(version) && version.split(".").every((part) => Number(part) <= 65535);
}
