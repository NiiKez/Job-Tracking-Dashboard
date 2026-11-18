import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// `npm run migrate` as the deploy runs it. Its output can end up in a public CI log, so it must
// never contain the connection string (docs/plan/README.md, "Rules for every pull request").

const REPO = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO, "db", "migrate.mjs");
const PASSWORD = "pw-not-real-1234";

function run(script: string, databaseUrl: string | undefined) {
  // Nothing from .env.local or the test environment besides PATH.
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH };
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
  const result = spawnSync(process.execPath, [script], { cwd: REPO, env, encoding: "utf8", timeout: 20_000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("db/migrate.mjs as a script", () => {
  it.each([
    // An unencoded "/" in the password, a port out of range, a broken escape: postgres.js
    // throws while parsing, and Node would print the TypeError with the whole URL as `input`.
    `postgresql://app:${PASSWORD}/x@127.0.0.1:1/job_tracker`,
    `postgresql://app:${PASSWORD}@127.0.0.1:99999/job_tracker`,
    `postgresql://app:${PASSWORD}%zz@127.0.0.1:1/job_tracker`,
    // Parses, but nothing listens: a connection error.
    `postgresql://app:${PASSWORD}@127.0.0.1:1/job_tracker`,
  ])("fails without printing the connection string: %#", (url) => {
    const { status, output } = run(SCRIPT, url);
    expect(status).toBe(1);
    expect(output).toMatch(/^migrate: failed: /m);
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain("127.0.0.1:1/");
  });

  describe("through a symlinked path (a release's current link)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "migrate-link-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("still runs as the main script", () => {
      const link = path.join(dir, "repo");
      symlinkSync(REPO, link);
      const { status, output } = run(path.join(link, "db", "migrate.mjs"), undefined);
      expect(output).toContain("migrate: DATABASE_URL is not set");
      expect(status).toBe(1);
    });
  });
});
