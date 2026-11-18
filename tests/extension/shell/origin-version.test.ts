import { describe, expect, it } from "vitest";
import { hostOf, normalizeOrigin, originPattern } from "../../../extension/src/lib/origin";
import { compareVersions, isNewerVersion } from "../../../extension/src/lib/version";

// The tracker address on the Connect screen (https, or http only on this computer; no path,
// no credentials) and the version comparison behind "Version X is available in Settings".

describe("normalizeOrigin", () => {
  it.each([
    ["https://tracker.example.com", "https://tracker.example.com"],
    ["https://tracker.example.com/", "https://tracker.example.com"],
    ["  HTTPS://Tracker.Example.com  ", "https://tracker.example.com"],
    ["tracker.example.com", "https://tracker.example.com"],
    ["https://tracker.example.com:8443", "https://tracker.example.com:8443"],
    ["https://tracker.example.com:443/", "https://tracker.example.com"],
    ["http://localhost:3800", "http://localhost:3800"],
    ["http://127.0.0.1:3810/", "http://127.0.0.1:3810"],
    // A bare local address means a dev server: http, not https.
    ["localhost:3800", "http://localhost:3800"],
    ["127.0.0.1:3800", "http://127.0.0.1:3800"],
    ["https://localhost:3800", "https://localhost:3800"],
    // A trailing dot names the same host; the tracker's pages never use it, so it is dropped.
    ["https://tracker.example.com.", "https://tracker.example.com"],
    ["tracker.example.com./", "https://tracker.example.com"],
    ["https://tracker.example.com.:8443", "https://tracker.example.com:8443"],
    ["http://localhost.:3800", "http://localhost:3800"],
    ["localhost.:3800", "http://localhost:3800"],
    ["HTTPS://Tracker.Example.COM.", "https://tracker.example.com"],
    // The parser's own spellings: a name in Unicode becomes punycode, a short IPv4 address the full one.
    ["https://bücher.example", "https://xn--bcher-kva.example"],
    ["https://xn--bcher-kva.example", "https://xn--bcher-kva.example"],
    ["http://127.1:3800", "http://127.0.0.1:3800"],
    ["https://192.168.1.20", "https://192.168.1.20"],
    ["https://[::1]:3800", "https://[::1]:3800"],
    ["https://my-tracker.example.com", "https://my-tracker.example.com"],
  ])("accepts %j as %s", (typed, origin) => {
    expect(normalizeOrigin(typed)).toEqual({ ok: true, origin });
    // The permission Connect asks for names this one host: its only * is the path's.
    expect(originPattern(origin).indexOf("*")).toBe(originPattern(origin).length - 1);
  });

  it.each([
    ["", "Enter your tracker's address."],
    ["   ", "Enter your tracker's address."],
    ["https://tracker .example.com", "An address has no spaces."],
    ["http://tracker.example.com", "Use https. Plain http works only for localhost and 127.0.0.1."],
    ["http://localhost.example.com", "Use https. Plain http works only for localhost and 127.0.0.1."],
    ["ftp://tracker.example.com", "Use an https address, like https://tracker.example.com."],
    ["https://ada:secret@tracker.example.com", "Leave out the user name and password; you sign in on the tracker's page."],
    ["https://tracker.example.com/settings", "Use the address without a path: https://tracker.example.com"],
    ["https://tracker.example.com/?next=/", "Use the address without a path: https://tracker.example.com"],
    ["https://tracker.example.com/#top", "Use the address without a path: https://tracker.example.com"],
    ["javascript:alert(1)", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://tracker.example.com..", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://.", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://tracker..example.com", "That isn't a web address. Use one like https://tracker.example.com."],
    ["http://tracker.example.com.", "Use https. Plain http works only for localhost and 127.0.0.1."],
    // The URL parser takes these as host names, but in a permission pattern * means any host:
    // "*" would ask Chrome for every https site. Only letters, digits, hyphens and dots, or an IP address.
    ["*", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://*", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://*.", "That isn't a web address. Use one like https://tracker.example.com."],
    ["*.example.com", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://*.example.com", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://%2A.example.com", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://＊.example.com", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://tracker*.example.com", "That isn't a web address. Use one like https://tracker.example.com."],
    ["http://*.localhost:3800", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://tracker_1.example.com", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://tracker!.example.com", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://tr$acker.example.com", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://tr~acker.example.com", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://tr{acker}.example.com", "That isn't a web address. Use one like https://tracker.example.com."],
    ["https://tr'acker.example.com", "That isn't a web address. Use one like https://tracker.example.com."],
  ])("refuses %j", (typed, error) => {
    expect(normalizeOrigin(typed)).toEqual({ ok: false, error });
  });

  it("gives the permission pattern and the host the footer shows", () => {
    expect(originPattern("https://tracker.example.com")).toBe("https://tracker.example.com/*");
    expect(originPattern("http://localhost:3800")).toBe("http://localhost:3800/*");
    expect(hostOf("http://localhost:3800")).toBe("localhost:3800");
    expect(hostOf("https://tracker.example.com")).toBe("tracker.example.com");
  });
});

describe("version comparison", () => {
  it.each([
    ["1.0.0", "1.0.0", 0],
    ["1.0", "1.0.0", 0],
    ["1.0.1", "1.0.0", 1],
    ["1.10.0", "1.9.0", 1],
    ["2", "1.99.99.99", 1],
    ["1.0.0", "1.0.0.1", -1],
    ["0.9.9", "1.0.0", -1],
  ] as const)("%s against %s is %i", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it.each(["", "1.0.0-beta", "v1.0.0", "1..0", "1.0.0.0.0", "1.x", " 1.0"])("treats %j as no version", (bad) => {
    expect(compareVersions(bad, "1.0.0")).toBeNull();
    expect(compareVersions("1.0.0", bad)).toBeNull();
  });

  it("suggests an update only for a newer version", () => {
    expect(isNewerVersion("1.1.0", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("0.9.0", "1.0.0")).toBe(false);
    expect(isNewerVersion(null, "1.0.0")).toBe(false);
    expect(isNewerVersion("latest", "1.0.0")).toBe(false);
  });
});
