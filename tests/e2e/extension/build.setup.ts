// The `extension-build` project (playwright.config.ts): builds the e2e extension once per run,
// before the `extension` project's specs load it (support/build.ts).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import { buildExtension } from "./support/build";

setup("build the e2e extension", async ({}, testInfo) => {
  setup.setTimeout(60_000);
  const dir = await buildExtension(testInfo.project.outputDir);
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
  expect(manifest).toMatchObject({ manifest_version: 3, host_permissions: ["<all_urls>"] });
});
