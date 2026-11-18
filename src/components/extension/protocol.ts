/**
 * The messages between /extension/connect and the extension's connect bridge, a content script the
 * extension injects into that page (docs/plan/4-chrome-extension.md, "Connect flow"):
 *
 *   bridge ─► page  {source:"job-tracker-extension", type:"ready", version}
 *   page  ─► bridge {source:"job-tracker-app", type:"hello"}               on mount; the bridge answers "ready"
 *   page  ─► bridge {source:"job-tracker-app", type:"key", token, keyId}   after the user clicks Connect
 *   bridge ─► page  {source:"job-tracker-extension", type:"connected", email} or {…, type:"failed", error}
 *
 * Both sides post with window.postMessage(message, location.origin) and accept a message only when
 * it comes from this very window, from this origin, and names the other side as its source.
 */

export const APP_SOURCE = "job-tracker-app";
export const EXTENSION_SOURCE = "job-tracker-extension";

export type AppMessage = { type: "hello" } | { type: "key"; token: string; keyId: string };

export type ExtensionMessage =
  | { type: "ready"; version: string | null }
  | { type: "connected"; email: string | null }
  | { type: "failed"; error: string | null };

/** Longest text taken from the extension (an error, a version, an email address). */
const MAX_TEXT = 300;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : null;
}

/**
 * The extension's message in `event`, or null when it is not one: another window (a frame, an
 * opener), another origin, another source name, or an unknown type.
 */
export function readExtensionMessage(
  event: Pick<MessageEvent, "source" | "origin" | "data">,
  self: { window: unknown; origin: string },
): ExtensionMessage | null {
  if (event.source !== self.window || event.origin !== self.origin) return null;
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null) return null;
  const { source, type } = data as Record<string, unknown>;
  if (source !== EXTENSION_SOURCE) return null;
  const record = data as Record<string, unknown>;
  switch (type) {
    case "ready":
      return { type, version: text(record.version) };
    case "connected":
      return { type, email: text(record.email) };
    case "failed":
      return { type, error: text(record.error) };
    default:
      return null;
  }
}

/** Posts to the bridge in this window, to this origin only. */
export function postToExtension(message: AppMessage): void {
  window.postMessage({ source: APP_SOURCE, ...message }, window.location.origin);
}
