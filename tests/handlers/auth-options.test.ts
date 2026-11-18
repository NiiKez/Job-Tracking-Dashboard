import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/auth/options/route";
import { getEnv, resetEnvForTests } from "@/lib/server/env";
import { proxy } from "@/proxy";
import { APP_ORIGIN, restoreEnv, setEnv, signedInEnv } from "../unit/auth/env";

// src/app/auth/options/route.ts: the signed-out sign-in page asks it for the demo's address
// (docs/plan/5-public-demo.md, "Step 8"). No session, no database. Invented hosts only.

// connection() needs a request scope; called directly, handlers only need it to resolve.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

const DEMO_ORIGIN = "https://demo.example.com";

// Values the demo refuses beside DEMO_MODE=on, blanked so a developer's shell cannot leak them in.
const NOT_IN_DEMO = ["INBOX_TOKEN_KEY", "INBOX_TOKEN_KEY_PREVIOUS", "ALLOW_PARTIAL_SETUP", "MAIL_SOURCE", "INBOX_SCHEDULER"];

/** Sets DEMO_URL and DEMO_MODE ("" = missing) on top of the sign-in variables already stubbed. */
function demoEnv(values: { DEMO_URL?: string; DEMO_MODE?: string }) {
  for (const name of NOT_IN_DEMO) vi.stubEnv(name, "");
  vi.stubEnv("DEMO_URL", values.DEMO_URL ?? "");
  vi.stubEnv("DEMO_MODE", values.DEMO_MODE ?? "");
  resetEnvForTests();
}

async function options() {
  const res = await GET();
  return { res, body: (await res.json()) as unknown };
}

describe("GET /auth/options", () => {
  beforeEach(() => {
    signedInEnv();
    demoEnv({});
  });
  afterEach(restoreEnv);

  it("names the demo's origin in google mode when DEMO_URL is set", async () => {
    demoEnv({ DEMO_URL: DEMO_ORIGIN });
    const { res, body } = await options();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(body).toEqual({ demoUrl: DEMO_ORIGIN });
  });

  it("answers the origin alone, without a trailing slash", async () => {
    demoEnv({ DEMO_URL: `${DEMO_ORIGIN}/` });
    expect((await options()).body).toEqual({ demoUrl: DEMO_ORIGIN });
  });

  it("answers null without DEMO_URL", async () => {
    expect(getEnv().demoUrl).toBeNull();
    const { res, body } = await options();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ demoUrl: null });
  });

  it("names the demo in locked mode too: the sign-in page can still link to it", async () => {
    setEnv({ APP_URL: APP_ORIGIN });
    demoEnv({ DEMO_URL: DEMO_ORIGIN });
    expect((await options()).body).toEqual({ demoUrl: DEMO_ORIGIN });
  });

  it("answers null in demo mode", async () => {
    setEnv({ APP_URL: "https://demo-app.example.com" });
    demoEnv({ DEMO_MODE: "on" });
    // A valid demo environment, so the null is the demo rule's and not a parse error's.
    expect(getEnv()).toMatchObject({ demoMode: true, demoUrl: null });
    const { res, body } = await options();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ demoUrl: null });
  });

  it("answers null instead of failing when the environment is malformed", async () => {
    // Each of these stops the start (checkEnv); the sign-in page must still render if one slips by.
    const malformed: Array<[string, () => void]> = [
      ["DEMO_URL over http on a public host", () => demoEnv({ DEMO_URL: "http://demo.example.com" })],
      ["DEMO_URL with a path", () => demoEnv({ DEMO_URL: `${DEMO_ORIGIN}/start` })],
      ["DEMO_URL equal to APP_URL", () => demoEnv({ DEMO_URL: APP_ORIGIN })],
      ["DEMO_URL beside DEMO_MODE=on", () => demoEnv({ DEMO_URL: DEMO_ORIGIN, DEMO_MODE: "on" })],
      [
        "another variable malformed, DEMO_URL fine",
        () => {
          signedInEnv({ APP_URL: "not a url" });
          demoEnv({ DEMO_URL: DEMO_ORIGIN });
        },
      ],
    ];
    for (const [name, apply] of malformed) {
      apply();
      expect(() => getEnv(), name).toThrow(/^Invalid environment: /);
      const { res, body } = await options();
      expect(res.status, name).toBe(200);
      expect(res.headers.get("cache-control"), name).toBe("no-store");
      expect(body, name).toEqual({ demoUrl: null });
    }
  });

  it("is reached signed out: the proxy lets it through in google and locked mode", () => {
    const run = () => proxy(new NextRequest("http://localhost:3800/auth/options"));
    demoEnv({ DEMO_URL: DEMO_ORIGIN });
    expect(run().headers.get("x-middleware-next")).toBe("1");
    setEnv({ APP_URL: APP_ORIGIN });
    demoEnv({ DEMO_URL: DEMO_ORIGIN });
    expect(run().headers.get("x-middleware-next")).toBe("1");
  });
});
