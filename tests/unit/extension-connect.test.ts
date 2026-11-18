import { describe, expect, it } from "vitest";
import {
  browserLabel,
  DEFAULT_BROWSER_LABEL,
  MAX_LABEL_LENGTH,
} from "@/components/extension/browser-label";
import { EXTENSION_SOURCE, readExtensionMessage } from "@/components/extension/protocol";
import { ANSWER_TIMEOUT_MS, CREATE_TIMEOUT_MS } from "@/components/extension/use-extension-connect";

// The connect page (/extension/connect): the label a connected browser gets in Settings, and which
// window messages count as the extension's (docs/plan/4-chrome-extension.md, "Connect flow").

const UA = {
  chromeLinux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  operaMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/116.0.0.0",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  headless:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
};

const brands = (...names: string[]) => names.map((brand) => ({ brand, version: "131" }));

describe("browserLabel", () => {
  it("names the browser and the platform from Client Hints", () => {
    expect(browserLabel({ userAgentData: { brands: brands("Not_A Brand", "Chromium", "Google Chrome"), platform: "Linux" } })).toBe(
      "Chrome on Linux",
    );
    expect(
      browserLabel({ userAgentData: { brands: brands("Microsoft Edge", "Chromium", "Not=A?Brand"), platform: "Windows" } }),
    ).toBe("Edge on Windows");
    expect(browserLabel({ userAgentData: { brands: brands("Brave", "Chromium"), platform: "macOS" } })).toBe("Brave on macOS");
    expect(browserLabel({ userAgentData: { brands: brands("Chromium"), platform: "Chrome OS" } })).toBe("Chromium on ChromeOS");
  });

  it("prefers Client Hints over the User-Agent string, which browsers freeze or change", () => {
    expect(
      browserLabel({
        userAgent: UA.chromeWindows,
        userAgentData: { brands: brands("Chromium", "Google Chrome"), platform: "Linux" },
      }),
    ).toBe("Chrome on Linux");
  });

  it("falls back to the User-Agent string", () => {
    expect(browserLabel({ userAgent: UA.chromeLinux })).toBe("Chrome on Linux");
    expect(browserLabel({ userAgent: UA.chromeWindows })).toBe("Chrome on Windows");
    expect(browserLabel({ userAgent: UA.edgeWindows })).toBe("Edge on Windows");
    expect(browserLabel({ userAgent: UA.operaMac })).toBe("Opera on macOS");
    expect(browserLabel({ userAgent: UA.chromeOs })).toBe("Chrome on ChromeOS");
    expect(browserLabel({ userAgent: UA.chromeAndroid })).toBe("Chrome on Android");
    expect(browserLabel({ userAgent: UA.headless })).toBe("Chrome on Linux");
    expect(browserLabel({ userAgent: UA.firefoxLinux })).toBe("Firefox on Linux");
  });

  it("uses the User-Agent string for what Client Hints leave out", () => {
    // Only the GREASE brand: the browser comes from the string; an unknown platform as well.
    expect(browserLabel({ userAgent: UA.edgeWindows, userAgentData: { brands: brands("Not A;Brand"), platform: "" } })).toBe(
      "Edge on Windows",
    );
  });

  it("leaves out a platform it can't tell, and says Chrome extension when the browser is unknown", () => {
    expect(browserLabel({ userAgentData: { brands: brands("Google Chrome"), platform: "Plan 9" } })).toBe("Chrome");
    expect(browserLabel({ userAgent: "" })).toBe(DEFAULT_BROWSER_LABEL);
    expect(browserLabel({ userAgent: "curl/8.0", userAgentData: null })).toBe(DEFAULT_BROWSER_LABEL);
    expect(browserLabel({})).toBe(DEFAULT_BROWSER_LABEL);
  });

  it("stays within the key label's 80 characters", () => {
    expect(MAX_LABEL_LENGTH).toBe(80);
    for (const ua of Object.values(UA)) {
      const label = browserLabel({ userAgent: ua });
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    }
  });
});

describe("readExtensionMessage", () => {
  const self = { window: { name: "this window" }, origin: "https://jobs.example.com" };
  const from = (data: unknown, over: Partial<{ source: unknown; origin: string }> = {}) =>
    readExtensionMessage(
      {
        data,
        source: ("source" in over ? over.source : self.window) as MessageEvent["source"],
        origin: over.origin ?? self.origin,
      },
      self,
    );

  it("reads ready, connected and failed from the extension's bridge", () => {
    expect(from({ source: EXTENSION_SOURCE, type: "ready", version: "1.0.0" })).toEqual({ type: "ready", version: "1.0.0" });
    expect(from({ source: EXTENSION_SOURCE, type: "connected", email: "me@example.com" })).toEqual({
      type: "connected",
      email: "me@example.com",
    });
    expect(from({ source: EXTENSION_SOURCE, type: "failed", error: "No answer" })).toEqual({ type: "failed", error: "No answer" });
  });

  it("ignores a message from another window, even one of this origin", () => {
    expect(from({ source: EXTENSION_SOURCE, type: "ready" }, { source: { name: "a frame" } })).toBeNull();
    expect(from({ source: EXTENSION_SOURCE, type: "ready" }, { source: null })).toBeNull();
  });

  it("ignores a message from another origin", () => {
    expect(from({ source: EXTENSION_SOURCE, type: "ready" }, { origin: "https://evil.example" })).toBeNull();
    expect(from({ source: EXTENSION_SOURCE, type: "ready" }, { origin: "null" })).toBeNull();
  });

  it("ignores the page's own messages, other sources and unknown types", () => {
    expect(from({ source: "job-tracker-app", type: "hello" })).toBeNull();
    expect(from({ source: "job-tracker-app", type: "ready" })).toBeNull();
    expect(from({ source: "someone-else", type: "connected", email: "x@example.com" })).toBeNull();
    expect(from({ source: EXTENSION_SOURCE, type: "key", token: "jtx_x" })).toBeNull();
    expect(from({ type: "ready" })).toBeNull();
    expect(from("ready")).toBeNull();
    expect(from(null)).toBeNull();
  });

  it("takes only short text from the message", () => {
    expect(from({ source: EXTENSION_SOURCE, type: "ready", version: 1 })).toEqual({ type: "ready", version: null });
    expect(from({ source: EXTENSION_SOURCE, type: "failed", error: "   " })).toEqual({ type: "failed", error: null });
    const long = from({ source: EXTENSION_SOURCE, type: "failed", error: "x".repeat(5000) });
    expect(long?.type === "failed" && long.error?.length).toBe(300);
  });
});

describe("the connect page's timers", () => {
  it("waits for the extension's answer longer than the extension's own 15-second check of the key", () => {
    // Running out of time after the key went out leaves the key in place (the extension may have
    // stored it); the page only stops waiting. A shorter wait would cut off a slow but good connect.
    expect(ANSWER_TIMEOUT_MS).toBeGreaterThan(15_000);
    expect(CREATE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});
