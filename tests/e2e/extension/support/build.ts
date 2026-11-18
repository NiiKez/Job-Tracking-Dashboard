// The extension the `extension` project loads: extension/build.mjs --e2e, the shipped code plus
// host_permissions <all_urls> (Playwright can't click the toolbar icon that grants activeTab).
// build.setup.ts makes it once per run, before the specs, into the run's output folder
// (test-results/<E2E_SCHEMA>/, which Playwright empties when a run starts): never older than
// extension/src, and two runs with two schemas never share it.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const ROOT = path.resolve(__dirname, "../../../..");

const run = promisify(execFile);

/** What build.mjs gets as --out; it writes the e2e build to <out>/e2e/. */
const outDir = (outputDir: string) => path.join(outputDir, "extension-build");

/** The unpacked extension Chromium loads, in the run's output folder. */
export function extensionDir(outputDir: string): string {
  return path.join(outDir(outputDir), "e2e");
}

/** Builds the e2e extension into extensionDir(outputDir) and returns that folder. */
export async function buildExtension(outputDir: string): Promise<string> {
  await run(process.execPath, [path.join(ROOT, "extension", "build.mjs"), "--e2e", "--out", outDir(outputDir)], {
    cwd: ROOT,
  });
  return extensionDir(outputDir);
}
