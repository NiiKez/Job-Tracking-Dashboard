// The demo jobs and emails moved into the app's source tree (src/lib/server/demo/fixtures.ts), so
// the Next build compiles them for the public demo. Re-exported here for the development command
// and the tests that import them from this path.
export { buildSeed, EMAILS, type SeedData, type SeedEmail } from "@/lib/server/demo/fixtures";
