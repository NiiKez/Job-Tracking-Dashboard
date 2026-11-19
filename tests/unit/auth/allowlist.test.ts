import { afterEach, describe, expect, it } from "vitest";
import { isAllowed } from "@/lib/server/auth/allowlist";
import { parseEnv } from "@/lib/server/env";
import { demoEnv, restoreEnv, setEnv, SIGNED_IN_ENV, signedInEnv } from "./env";

describe("isAllowed", () => {
  afterEach(restoreEnv);

  it("accepts an address on ALLOWED_EMAILS, ignoring case and surrounding spaces", () => {
    signedInEnv({ ALLOWED_EMAILS: " Owner@Example.com , second@example.com" });
    expect(isAllowed("owner@example.com")).toBe(true);
    expect(isAllowed("OWNER@EXAMPLE.COM")).toBe(true);
    expect(isAllowed("  owner@example.com\t")).toBe(true);
    expect(isAllowed("second@example.com")).toBe(true);
  });

  it("refuses any other address", () => {
    signedInEnv({ ALLOWED_EMAILS: "owner@example.com" });
    expect(isAllowed("other@example.com")).toBe(false);
    expect(isAllowed("owner@example.com.evil.example")).toBe(false);
    expect(isAllowed("xowner@example.com")).toBe(false);
    expect(isAllowed("")).toBe(false);
  });

  it("refuses everyone while sign-in is locked", () => {
    // The allowlist is set, but the Google client is not.
    setEnv({ APP_URL: "https://jobs.example.com", ALLOWED_EMAILS: "owner@example.com" });
    expect(isAllowed("owner@example.com")).toBe(false);
  });

  it("refuses everyone in the public demo, which has no allowlist", () => {
    demoEnv();
    expect(isAllowed("owner@example.com")).toBe(false);
  });

  it("reads the given environment instead of the process's", () => {
    setEnv({});
    expect(isAllowed("owner@example.com", parseEnv(SIGNED_IN_ENV))).toBe(true);
    expect(isAllowed("owner@example.com")).toBe(false);
  });

  it("refuses everyone when ALLOWED_EMAILS is missing", () => {
    signedInEnv({ ALLOWED_EMAILS: "" });
    expect(isAllowed("owner@example.com")).toBe(false);
  });
});
