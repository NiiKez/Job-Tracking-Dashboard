import type { PageSnapshot } from "@/lib/types";

/*
 * Every message that crosses a boundary in the extension, and the guards that check one before
 * it is used. Anything arriving from a page or another context is `unknown` until a guard says
 * otherwise.
 *
 *   popup  ── runtime ──► service worker   { type: "connect", origin }       → ConnectReply
 *   bridge ── runtime ──► service worker   { type: "connect-key", token }    → KeyReply
 *   page   ── window  ──► bridge           { source: "job-tracker-app", type: "hello" | "key" }
 *   bridge ── window  ──► page             { source: "job-tracker-extension", type: "ready" | "connected" | "failed" }
 *
 * The window protocol is the one the tracker's /extension/connect page speaks
 * (docs/plan/4-chrome-extension.md, Connect flow).
 */

export const APP_SOURCE = "job-tracker-app";
export const EXTENSION_SOURCE = "job-tracker-extension";

/* ------------------------------------------------------------ runtime messages */

/** The popup asks the service worker to open the tracker's connect page. */
export interface ConnectRequest {
  type: "connect";
  origin: string;
}

/** The bridge passes on the key the connect page made. */
export interface KeyMessage {
  type: "connect-key";
  token: string;
}

export type ConnectReply = { ok: true } | { ok: false; error: string };
export type KeyReply = { ok: true; email: string } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isConnectRequest(value: unknown): value is ConnectRequest {
  return isRecord(value) && value.type === "connect" && typeof value.origin === "string";
}

export function isKeyMessage(value: unknown): value is KeyMessage {
  return isRecord(value) && value.type === "connect-key" && typeof value.token === "string";
}

export function isConnectReply(value: unknown): value is ConnectReply {
  return isRecord(value) && (value.ok === true || (value.ok === false && typeof value.error === "string"));
}

export function isKeyReply(value: unknown): value is KeyReply {
  if (!isRecord(value)) return false;
  return value.ok === true ? typeof value.email === "string" : value.ok === false && typeof value.error === "string";
}

/* ------------------------------------------------------------ window messages */

/** What the connect page posts: "hello" on mount, "key" once it made the key. */
export type AppMessage =
  | { source: typeof APP_SOURCE; type: "hello" }
  | { source: typeof APP_SOURCE; type: "key"; token: string };

export type BridgeMessage =
  | { source: typeof EXTENSION_SOURCE; type: "ready"; version: string }
  | { source: typeof EXTENSION_SOURCE; type: "connected"; email: string }
  | { source: typeof EXTENSION_SOURCE; type: "failed"; error: string };

export function isAppMessage(value: unknown): value is AppMessage {
  if (!isRecord(value) || value.source !== APP_SOURCE) return false;
  return value.type === "hello" || (value.type === "key" && typeof value.token === "string");
}

/* ------------------------------------------------------------ page snapshot */

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * The result of page/read-page.js, which runs in the job page. The page's own scripts can't
 * reach the extension's isolated world, but they shape the DOM it reads, so the shape is checked
 * here and the tracker validates the content and its limits.
 */
export function isPageSnapshot(value: unknown): value is PageSnapshot {
  if (!isRecord(value)) return false;
  const { url, canonicalUrl, title, meta, jsonLd, site, selection } = value;
  return (
    isString(url) &&
    (canonicalUrl === null || isString(canonicalUrl)) &&
    isString(title) &&
    isRecord(meta) &&
    Object.values(meta).every(isString) &&
    Array.isArray(jsonLd) &&
    jsonLd.every(isString) &&
    (site === null ||
      (isRecord(site) &&
        isString(site.reader) &&
        isRecord(site.fields) &&
        Object.values(site.fields).every((field) => field === undefined || isString(field)))) &&
    isString(selection)
  );
}
