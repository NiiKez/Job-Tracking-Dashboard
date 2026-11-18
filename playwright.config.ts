import { defineConfig, devices } from "@playwright/test";
import {
  ALLOWED_EMAILS,
  BASE_URL,
  E2E_PORT,
  E2E_SCHEMA,
  e2eDatabaseUrl,
  GOOGLE_CLIENT_ID,
  testDatabaseUrl,
} from "./tests/e2e/support/settings";

// End-to-end tests: a real browser against the production build (`next start`), with its own
// schema in the test database and demo mail instead of Gmail. See tests/e2e/support/serve.mjs for
// the server and tests/e2e/support/fixtures.ts for signing in.
//
//   npm run build && npm run test:e2e
//
// Needs TEST_DATABASE_URL (environment or .env.local) and Playwright's Chromium
// (`npx playwright install chromium` once: the headless shell for most specs, and full Chromium
// for the extension's). The run fails when the build is older than the source. E2E_PORT and
// E2E_SCHEMA move the server, so two runs can share the machine.
//
// Projects: `chromium` runs the web app's specs in the headless shell. `extension` runs
// tests/e2e/extension/ in full Chromium (channel "chromium", new headless; the shell can't load
// extensions) with the Chrome extension loaded, built for the run by `extension-build` first
// (tests/e2e/extension/support/). Both use the one server below.

const CI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  // A folder per schema: each run empties its output folder first, so two runs side by side
  // would otherwise delete each other's traces.
  outputDir: `test-results/${E2E_SCHEMA}`,
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    locale: "en-US",
    timezoneId: "UTC",
    trace: CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    // The browser can reach no host but the e2e server, so no test can reach a real site, Google
    // included. That holds for the hops of a server redirect too, which page.route() never sees.
    // The rule matches IP addresses as well, hence the exclusion; page.route() stand-ins still answer.
    launchOptions: { args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] },
  },
  // Hydration and the first API calls can take a few seconds on a busy machine or CI runner.
  expect: { timeout: 10_000 },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: "tests/e2e/extension/**" },
    // Builds the e2e extension (extension/build.mjs --e2e) into this run's outputDir, once.
    { name: "extension-build", testDir: "./tests/e2e/extension", testMatch: "build.setup.ts" },
    {
      name: "extension",
      testDir: "./tests/e2e/extension",
      dependencies: ["extension-build"],
      // Not "Desktop Chrome": its user agent claims Windows, and the connect page names the
      // browser after what it says about itself. The fixtures launch the browser themselves
      // (launchPersistentContext, tests/e2e/extension/support/extension.ts) with these options
      // and the launchOptions above.
      use: { channel: "chromium", viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: {
    command: "node tests/e2e/support/serve.mjs",
    url: `${BASE_URL}/api/health`,
    // Always a fresh server on a fresh schema: one left running from another run (or a dev server
    // on the same port) would test the wrong build or the wrong data.
    reuseExistingServer: false,
    timeout: 120_000,
    // The server's log (one line per inbox sync) only in CI, where it is the only record; its
    // errors always show.
    stdout: CI ? "pipe" : "ignore",
    stderr: "pipe",
    env: {
      E2E_PORT: String(E2E_PORT),
      E2E_SCHEMA,
      E2E_DATABASE_URL: e2eDatabaseUrl(),
      E2E_TEST_DATABASE_URL: testDatabaseUrl(),
      E2E_ALLOWED_EMAILS: ALLOWED_EMAILS,
      E2E_GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID,
    },
  },
});
