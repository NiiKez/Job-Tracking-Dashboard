import { describe, expect, it } from "vitest";
import {
  isAppMessage,
  isConnectReply,
  isConnectRequest,
  isKeyMessage,
  isKeyReply,
  isPageSnapshot,
} from "../../../extension/src/lib/messages";

// The guards every message passes before the extension uses it: from the popup, the bridge,
// the tracker's connect page, and the job page's snapshot.

describe("runtime messages", () => {
  it("connect request and reply", () => {
    expect(isConnectRequest({ type: "connect", origin: "https://tracker.example.com" })).toBe(true);
    expect(isConnectRequest({ type: "connect" })).toBe(false);
    expect(isConnectRequest({ type: "connect", origin: 1 })).toBe(false);
    expect(isConnectRequest("connect")).toBe(false);
    expect(isConnectRequest(null)).toBe(false);

    expect(isConnectReply({ ok: true })).toBe(true);
    expect(isConnectReply({ ok: false, error: "No" })).toBe(true);
    expect(isConnectReply({ ok: false })).toBe(false);
    expect(isConnectReply(undefined)).toBe(false);
  });

  it("key message and reply", () => {
    expect(isKeyMessage({ type: "connect-key", token: "jtx_x" })).toBe(true);
    expect(isKeyMessage({ type: "connect-key" })).toBe(false);
    expect(isKeyMessage({ type: "connect", token: "jtx_x" })).toBe(false);

    expect(isKeyReply({ ok: true, email: "ada@example.com" })).toBe(true);
    expect(isKeyReply({ ok: true })).toBe(false);
    expect(isKeyReply({ ok: false, error: "No" })).toBe(true);
    expect(isKeyReply({ ok: "yes", email: "ada@example.com" })).toBe(false);
  });
});

describe("the connect page's window messages", () => {
  it("takes hello and key from the app, nothing else", () => {
    expect(isAppMessage({ source: "job-tracker-app", type: "hello" })).toBe(true);
    expect(isAppMessage({ source: "job-tracker-app", type: "key", token: "jtx_x", keyId: "k1" })).toBe(true);
    expect(isAppMessage({ source: "job-tracker-app", type: "key" })).toBe(false);
    expect(isAppMessage({ source: "job-tracker-extension", type: "hello" })).toBe(false);
    expect(isAppMessage({ source: "job-tracker-app", type: "ready" })).toBe(false);
    expect(isAppMessage("hello")).toBe(false);
  });
});

describe("page snapshot", () => {
  const snapshot = {
    url: "https://jobs.example.com/1",
    canonicalUrl: null,
    title: "Engineer",
    meta: { "og:title": "Engineer" },
    jsonLd: ['{"@type":"JobPosting"}'],
    site: { reader: "generic", fields: { description: "Build things.", title: undefined } },
    selection: "",
  };

  it("accepts the shape read-page.js returns", () => {
    expect(isPageSnapshot(snapshot)).toBe(true);
    expect(isPageSnapshot({ ...snapshot, canonicalUrl: "https://jobs.example.com/1", site: null })).toBe(true);
  });

  it.each([
    ["no url", { ...snapshot, url: undefined }],
    ["a number for the title", { ...snapshot, title: 1 }],
    ["a meta value that is not text", { ...snapshot, meta: { "og:title": ["x"] } }],
    ["JSON-LD that is not text", { ...snapshot, jsonLd: [{ "@type": "JobPosting" }] }],
    ["a site without a reader", { ...snapshot, site: { fields: {} } }],
    ["a site field that is not text", { ...snapshot, site: { reader: "generic", fields: { title: 1 } } }],
    ["no selection", { ...snapshot, selection: null }],
  ])("refuses %s", (_, value) => {
    expect(isPageSnapshot(value)).toBe(false);
  });

  it("refuses nothing at all", () => {
    expect(isPageSnapshot(null)).toBe(false);
    expect(isPageSnapshot(undefined)).toBe(false);
  });
});
