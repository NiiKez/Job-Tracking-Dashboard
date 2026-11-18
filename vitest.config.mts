import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// Database tests run in a throwaway schema of the database in TEST_DATABASE_URL: set directly in
// CI (the PostgreSQL service), read from .env.local here (the job_tracker_test database).
// DATABASE_URL is blanked, so code that skips the test helper fails instead of reaching the
// development database.
const envFile = path.resolve(import.meta.dirname, ".env.local");
const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
const testDatabaseUrl = process.env.TEST_DATABASE_URL || fromFile.TEST_DATABASE_URL || "";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // The real package throws outside React Server Components; tests import server modules directly.
      "server-only": path.resolve(import.meta.dirname, "tests/helpers/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: { TEST_DATABASE_URL: testDatabaseUrl, DATABASE_URL: "" },
  },
});
