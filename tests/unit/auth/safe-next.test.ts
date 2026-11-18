import { describe, expect, it } from "vitest";
import { MAX_NEXT_LENGTH, safeNextPath } from "@/lib/domain/safe-next";

describe("safeNextPath", () => {
  it.each([
    ["/", "/"],
    ["/jobs", "/jobs"],
    ["/jobs/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "/jobs/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"],
    ["/?status=applied,interview&q=acme", "/?status=applied,interview&q=acme"],
    ["/review#top", "/review#top"],
    ["/settings?tab=rules", "/settings?tab=rules"],
    // Only exact /login and /auth segments loop; similar names are ordinary pages.
    ["/loginx", "/loginx"],
    ["/authors", "/authors"],
    ["/jobs/login", "/jobs/login"],
    ["/%2F%2Fevil.example", "/%2F%2Fevil.example"],
  ])("keeps %j", (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["jobs"],
    ["https://evil.example/"],
    ["//evil.example"],
    ["//evil.example/path"],
    ["/\\evil.example"],
    ["\\\\evil.example"],
    ["/jobs\\..\\x"],
    ["javascript:alert(1)"],
    ["/\t/evil.example"],
    ["/\n/evil.example"],
    ["/jobs\r\nSet-Cookie: x=y"],
    ["/jobs\u0000"],
    ["/jobs\u007f"],
    ["/jobs\u0085"],
    ["/login"],
    ["/login?next=/"],
    ["/login/"],
    ["/login#x"],
    ["/auth"],
    ["/auth/google"],
    ["/auth/google/callback?code=x"],
    ["/auth?x=1"],
  ])("refuses %j", (raw) => {
    expect(safeNextPath(raw)).toBeNull();
  });

  it.each([
    ["/x/../auth/google"],
    ["/./login"],
    ["/%2e%2e/login"],
    ["/x/%2E%2e/auth"],
    ["/x/.%2e/login?next=/"],
    ["/jobs/../../auth/google/callback"],
    // Resolves to "//evil.example": no longer exactly one leading "/".
    ["/x/..//evil.example"],
  ])("refuses %j, which resolves to sign-in or another host once dot segments are applied", (raw) => {
    expect(safeNextPath(raw)).toBeNull();
  });

  it("keeps dot segments that resolve to an ordinary page, as given", () => {
    expect(safeNextPath("/jobs/../review")).toBe("/jobs/../review");
    expect(safeNextPath("/x/..%2flogin")).toBe("/x/..%2flogin");
  });

  it("refuses a path longer than the cap", () => {
    const atCap = `/${"a".repeat(MAX_NEXT_LENGTH - 1)}`;
    expect(safeNextPath(atCap)).toBe(atCap);
    expect(safeNextPath(`${atCap}a`)).toBeNull();
  });
});
