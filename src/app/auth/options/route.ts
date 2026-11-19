import { connection } from "next/server";
import { getEnv } from "@/lib/server/env";

/**
 * What the sign-in page offers besides Google sign-in (docs/plan/5-public-demo.md, "Step 8"):
 * `{ demoUrl }`, the public demo's origin from DEMO_URL ("https://demo.example.com", no trailing
 * slash) or null. src/components/auth/sign-in.tsx shows "Just looking? Try the demo" when it is
 * set.
 *
 * Public by design: the sign-in page asks before anyone is signed in, so there is no session check
 * and no route() (tests/unit/routes-use-route.test.ts lists it), and it reads no database. The
 * proxy lets /auth/* through. The origin is no secret: the page links to it.
 *
 * - Demo mode: always null. parseEnv() refuses DEMO_URL there; checked again so a demo never links
 *   to itself or another demo.
 * - A malformed environment: null, so the sign-in page looks as it does without DEMO_URL instead
 *   of failing. It cannot happen in a running app: checkEnv() stops the start
 *   (src/instrumentation.ts).
 *
 * GET only; Next answers 405 to the other methods.
 */
export async function GET() {
  // Answer every request live, never from a build-time prerender: the build has no environment.
  await connection();
  return Response.json({ demoUrl: demoUrl() }, { headers: { "Cache-Control": "no-store" } });
}

function demoUrl(): string | null {
  try {
    const env = getEnv();
    return env.demoMode ? null : env.demoUrl;
  } catch {
    return null;
  }
}
