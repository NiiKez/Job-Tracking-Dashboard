import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// `npm run db:seed` must never print the connection string, also when postgres.js cannot parse
// it (the same case as db/migrate.mjs, see migrate-cli.test.ts). No database is reached: every
// URL below is malformed or points at a closed port.

const REPO = path.resolve(__dirname, "../..");
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
const PASSWORD = "pw-not-real-5678";

function seed(databaseUrl: string) {
  // DATABASE_URL from the environment wins over .env.local, so the development database is never read.
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: databaseUrl };
  const result = spawnSync(TSX, ["--conditions=react-server", "scripts/seed-dev.ts"], {
    cwd: REPO,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("scripts/seed-dev.ts as a script", () => {
  it.each([
    `postgresql://app:${PASSWORD}/x@127.0.0.1:1/job_tracker_dev`, // an unencoded "/" in the password
    `postgresql://app:${PASSWORD}@127.0.0.1:99999/job_tracker_dev`, // a port out of range
    `postgresql://app:${PASSWORD}%zz@127.0.0.1:1/job_tracker_dev`, // a broken escape
    `postgresql://app:${PASSWORD}@127.0.0.1:1/job_tracker_dev`, // parses, but nothing listens
  ])("fails without printing the connection string: %#", (url) => {
    const { status, output } = seed(url);
    expect(status).toBe(1);
    expect(output).toMatch(/^db:seed: failed/m);
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain("@127.0.0.1"); // no part of the URL
  }, 90_000);
});
