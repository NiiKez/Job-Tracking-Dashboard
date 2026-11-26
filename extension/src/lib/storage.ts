import type { JobFieldValues } from "@/components/add-job/job-form";
import { PRIORITIES, type Priority } from "@/lib/types";

/*
 * What the extension remembers.
 *
 * chrome.storage.local (kept across restarts), the shape the plan fixes:
 *   { connection: { origin, token, email, name } | null, lastOrigin: string | null }
 *   background.ts closes it to content scripts (setAccessLevel TRUSTED_CONTEXTS), as session is.
 *
 * chrome.storage.session (memory only, gone when the browser quits; content scripts can't read it):
 *   connect      the Connect flow in progress. The service worker is stopped when idle, so this
 *                cannot live in a variable: the tab it opened, and the origin it is for.
 *   draft:<tab>  edits made in the popup for the page in that tab (fields, and a priority picked),
 *                so closing the popup (Escape, a click outside) doesn't lose them. Cleared after
 *                saving and when the tab closes.
 *
 * Values read back are checked, not trusted: an older version may have written another shape.
 */

export interface Connection {
  origin: string;
  /** The key: sent only as `Authorization: Bearer` to `origin`. */
  token: string;
  email: string;
  name: string;
}

const isString = (value: unknown): value is string => typeof value === "string";

function isConnection(value: unknown): value is Connection {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return isString(c.origin) && isString(c.token) && isString(c.email) && isString(c.name);
}

export async function readConnection(): Promise<Connection | null> {
  const { connection } = await chrome.storage.local.get("connection");
  return isConnection(connection) ? connection : null;
}

/** The address of the tracker connected last: the Connect screen's default. */
export async function readLastOrigin(): Promise<string | null> {
  const { lastOrigin } = await chrome.storage.local.get("lastOrigin");
  return isString(lastOrigin) ? lastOrigin : null;
}

export async function saveConnection(connection: Connection) {
  await chrome.storage.local.set({ connection, lastOrigin: connection.origin });
}

/**
 * Forgets the connection that used `token`. A connection made meanwhile with another key stays:
 * a late 401 for the old key must not undo a new Connect.
 */
export async function forgetConnection(token: string) {
  const current = await readConnection();
  if (current?.token === token) await chrome.storage.local.set({ connection: null });
}

/* ------------------------------------------------------------------ Connect in progress */

export interface PendingConnect {
  origin: string;
  /** The tab showing <origin>/extension/connect; null while Chrome still asks for the permission. */
  tabId: number | null;
  /** Date.now() when Connect was clicked. */
  startedAt: number;
}

function isPendingConnect(value: unknown): value is PendingConnect {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    isString(p.origin) &&
    (p.tabId === null || Number.isInteger(p.tabId)) &&
    typeof p.startedAt === "number"
  );
}

export async function readPendingConnect(): Promise<PendingConnect | null> {
  const { connect } = await chrome.storage.session.get("connect");
  return isPendingConnect(connect) ? connect : null;
}

export async function savePendingConnect(pending: PendingConnect) {
  await chrome.storage.session.set({ connect: pending });
}

export async function clearPendingConnect() {
  await chrome.storage.session.remove("connect");
}

/* ------------------------------------------------------------------ Drafts */

export interface Draft {
  /** The page the edits are for; another page in the same tab starts fresh. */
  url: string;
  /** Only the fields the user changed from what the tracker read. */
  edits: Partial<JobFieldValues>;
  /** The priority the user picked; absent when they picked none. */
  priority?: Priority;
}

/** What a draft brings back to the form. */
export type DraftEdits = Omit<Draft, "url">;

const draftKey = (tabId: number) => `draft:${tabId}`;

function isDraft(value: unknown): value is Draft {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    isString(d.url) &&
    typeof d.edits === "object" &&
    d.edits !== null &&
    Object.values(d.edits).every(isString) &&
    (d.priority === undefined || (PRIORITIES as readonly unknown[]).includes(d.priority))
  );
}

/** The edits for this tab, when they were made on the page it shows now. */
export async function readDraft(tabId: number, url: string): Promise<DraftEdits | null> {
  const key = draftKey(tabId);
  const { [key]: draft } = await chrome.storage.session.get(key);
  if (!isDraft(draft) || draft.url !== url) return null;
  return draft.priority ? { edits: draft.edits, priority: draft.priority } : { edits: draft.edits };
}

export async function saveDraft(tabId: number, draft: Draft) {
  const key = draftKey(tabId);
  if (Object.keys(draft.edits).length === 0 && !draft.priority) await chrome.storage.session.remove(key);
  else await chrome.storage.session.set({ [key]: draft });
}

export async function clearDraft(tabId: number) {
  await chrome.storage.session.remove(draftKey(tabId));
}
