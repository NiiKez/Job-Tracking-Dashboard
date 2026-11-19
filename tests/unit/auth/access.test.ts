import { afterEach, describe, expect, it } from "vitest";
import { EXTENSION_OFF_IN_DEMO, isDemoUser, mayUse, refuseInDemo } from "@/lib/server/auth/access";
import { parseEnv, signInMode } from "@/lib/server/env";
import { demoEnv, restoreEnv, SIGNED_IN_ENV, signedInEnv } from "./env";

// Who may use the app in each sign-in mode (docs/plan/5-public-demo.md, "Three sign-in modes").
// Invented values only.

const GOOGLE = parseEnv({ ...SIGNED_IN_ENV, ALLOWED_EMAILS: "owner@example.com,alex.0a1b2c3d@demo.invalid" });
const DEMO = parseEnv({ APP_URL: "https://demo.example.com", DEMO_MODE: "on" });
const LOCKED = parseEnv({ APP_URL: "https://jobs.example.com", ALLOWED_EMAILS: "owner@example.com" });

const owner = { email: "owner@example.com", googleSub: "110000000000000000001" };
const stranger = { email: "other@example.com", googleSub: "110000000000000000002" };
/** A demo user whose address is (against all odds) on the allowlist too. */
const visitor = { email: "alex.0a1b2c3d@demo.invalid", googleSub: "demo:0190f5a2-0000-7000-8000-000000000000" };

describe("isDemoUser", () => {
  it("is true for the demo marker at the start of google_sub only", () => {
    expect(isDemoUser(visitor)).toBe(true);
    expect(isDemoUser({ googleSub: "demo:" })).toBe(true);
    expect(isDemoUser(owner)).toBe(false);
    expect(isDemoUser({ googleSub: "Demo:0190f5a2" })).toBe(false);
    expect(isDemoUser({ googleSub: "1101demo:" })).toBe(false);
  });
});

describe("mayUse", () => {
  afterEach(restoreEnv);

  it("the modes are what the fixtures say", () => {
    expect([signInMode(GOOGLE), signInMode(DEMO), signInMode(LOCKED)]).toEqual(["google", "demo", "locked"]);
  });

  it("google: users on the allowlist that are not demo users", () => {
    expect(mayUse(owner, GOOGLE)).toBe(true);
    expect(mayUse({ ...owner, email: " Owner@Example.com" }, GOOGLE)).toBe(true);
    expect(mayUse(stranger, GOOGLE)).toBe(false);
    // Interlock 4: a demo user is refused even though its address is on the allowlist.
    expect(mayUse(visitor, GOOGLE)).toBe(false);
  });

  it("demo: demo users only, whatever their address", () => {
    expect(mayUse(visitor, DEMO)).toBe(true);
    expect(mayUse({ ...visitor, email: "owner@example.com" }, DEMO)).toBe(true);
    expect(mayUse(owner, DEMO)).toBe(false);
    expect(mayUse(stranger, DEMO)).toBe(false);
  });

  it("locked: nobody", () => {
    for (const user of [owner, stranger, visitor]) expect(mayUse(user, LOCKED)).toBe(false);
  });

  it("reads the process environment by default", () => {
    signedInEnv();
    expect(mayUse(owner)).toBe(true);
    expect(mayUse(visitor)).toBe(false);
    demoEnv();
    expect(mayUse(owner)).toBe(false);
    expect(mayUse(visitor)).toBe(true);
  });
});

describe("refuseInDemo", () => {
  afterEach(restoreEnv);

  it("is null outside demo mode", () => {
    expect(refuseInDemo(EXTENSION_OFF_IN_DEMO, GOOGLE)).toBeNull();
    expect(refuseInDemo(EXTENSION_OFF_IN_DEMO, LOCKED)).toBeNull();
    signedInEnv();
    expect(refuseInDemo(EXTENSION_OFF_IN_DEMO)).toBeNull();
  });

  it("is a 403 with the message in demo mode", async () => {
    demoEnv();
    const res = refuseInDemo(EXTENSION_OFF_IN_DEMO)!;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "The Chrome extension isn't available in the demo." });
  });
});
