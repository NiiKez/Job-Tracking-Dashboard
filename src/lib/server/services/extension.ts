import "server-only";
import { jobKeys } from "@/lib/domain/normalize";
import { newExtensionKey } from "@/lib/server/auth/extension-key";
import { getDb, withTx, type Db } from "@/lib/server/db/client";
import { ConflictError, NotFoundError } from "@/lib/server/errors";
import { openExtensionZip, readExtensionBuild, type ExtensionZip } from "@/lib/server/extension/build-info";
import { readSnapshot } from "@/lib/server/parse/snapshot";
import {
  countExtensionKeys,
  deleteExtensionKeyRow,
  insertExtensionKey,
  listExtensionKeyRows,
  lockUserExtensionKeys,
  type ExtensionKeyRow,
} from "@/lib/server/repo/extension-keys";
import { findDuplicateJobRow } from "@/lib/server/repo/jobs";
import type { User } from "@/lib/server/repo/users";
import type {
  ExtensionJobInput,
  ExtensionKey,
  ExtensionKeyCreated,
  ExtensionOverview,
  ExtensionSession,
  PageSnapshot,
  ParseResult,
  UpsertResult,
} from "@/lib/types";
import { loadJob, upsertJob } from "./jobs";

/**
 * The Chrome extension's API (docs/plan/4-chrome-extension.md, "API"), behind /api/extension.
 *
 * With the session cookie (Settings and the /extension/connect page):
 *   getExtensionOverview(db, userId)        the version this server hands out and the keys
 *   createExtensionKey(userId, label)       a key for a browser being connected: the token goes
 *                                           to the extension once, only its hash is kept.
 *                                           ConflictError at MAX_EXTENSION_KEYS keys
 *   revokeExtensionKey(userId, keyId)       NotFoundError when it is not the user's
 *   openExtensionDownload()                 the zip; NotFoundError when this server has no build
 *
 * With the extension's key (route(…, { auth: "extension" })):
 *   getExtensionSession(user)               who the extension adds jobs for, and the latest version
 *   disconnectExtension(userId, keyId)      deletes the key the request used
 *   readPageSnapshot(db, userId, page)      the fields in the open tab (src/lib/server/parse/
 *                                           snapshot.ts) and the job they would duplicate, the
 *                                           same lookup as /api/parse. Nothing is fetched, so
 *                                           the parse rate limit does not apply
 *   saveExtensionJob(userId, input)         the add-job upsert, with captureMethod "extension"
 */

/** Keys (connected browsers) per user. */
export const MAX_EXTENSION_KEYS = 20;

export const NOT_BUILT = "The extension isn't built on this server";

/* ------------------------------------------------------ cookie routes */

export async function getExtensionOverview(db: Db, userId: string): Promise<ExtensionOverview> {
  const [build, rows] = await Promise.all([readExtensionBuild(), listExtensionKeyRows(db, userId)]);
  return { version: build?.version ?? null, keys: rows.map(toExtensionKey) };
}

/**
 * Inserts a key for the user. The count and the insert run under a per-user lock in one
 * transaction, so two requests at once cannot pass the limit together.
 */
export async function createExtensionKey(userId: string, label: string): Promise<ExtensionKeyCreated> {
  const { token, tokenHash } = newExtensionKey();
  const row = await withTx(async (tx) => {
    await lockUserExtensionKeys(tx, userId);
    if ((await countExtensionKeys(tx, userId)) >= MAX_EXTENSION_KEYS) {
      throw new ConflictError(
        `${MAX_EXTENSION_KEYS} browsers are connected already. Revoke one in Settings, then connect again.`,
      );
    }
    return insertExtensionKey(tx, userId, tokenHash, label.trim());
  });
  return { key: toExtensionKey(row), token };
}

export async function revokeExtensionKey(userId: string, keyId: string): Promise<void> {
  if (!(await deleteExtensionKeyRow(getDb(), userId, keyId))) throw new NotFoundError("Key not found");
}

/** The zip GET /api/extension/download sends. */
export async function openExtensionDownload(): Promise<ExtensionZip> {
  const zip = await openExtensionZip();
  if (!zip) throw new NotFoundError(NOT_BUILT);
  return zip;
}

/* --------------------------------------------------------- key routes */

export async function getExtensionSession(user: User): Promise<ExtensionSession> {
  const build = await readExtensionBuild();
  return { email: user.email, name: user.name, latestVersion: build?.version ?? null };
}

/** Disconnect in the popup. A key that is already gone is no error. */
export async function disconnectExtension(userId: string, keyId: string): Promise<void> {
  await deleteExtensionKeyRow(getDb(), userId, keyId);
}

export async function readPageSnapshot(db: Db, userId: string, page: PageSnapshot): Promise<ParseResult> {
  const parsed = readSnapshot(page);
  const duplicate = await findDuplicateJobRow(db, userId, jobKeys(parsed));
  return { ...parsed, duplicateOf: duplicate ? await loadJob(db, userId, duplicate.id) : null };
}

export async function saveExtensionJob(userId: string, input: ExtensionJobInput): Promise<UpsertResult> {
  return upsertJob(userId, { ...input, captureMethod: "extension" });
}

/* ------------------------------------------------------------- rows */

function toExtensionKey(row: ExtensionKeyRow): ExtensionKey {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
  };
}
