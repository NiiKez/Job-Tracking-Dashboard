import "server-only";
import type { Db } from "@/lib/server/db/client";
import { getEnv, inboxTokenKeys, signInConfig } from "@/lib/server/env";
import { isSyncing } from "@/lib/server/inbox/sync/engine";
import { inboxErrorMessage } from "@/lib/server/inbox/sync/errors";
import type { InboxState, Settings } from "@/lib/types";

/** What Settings.inbox shows about the user's mailbox connection (all but provider and interval). */
export type InboxStatus = Omit<Settings["inbox"], "provider" | "intervalMinutes">;

interface StatusRow {
  status: "connected" | "needs_reconnect" | "disconnected";
  email_address: string;
  backfill_state: "pending" | "running" | "done";
  backfill_total: number | null;
  backfill_done: number;
  last_sync_ok_at: Date | null;
  last_error_code: string | null;
  last_error_at: Date | null;
  updated_at: Date;
  /** Someone (this process or another) holds an unexpired sync lease. */
  leased: boolean;
}

/**
 * The mailbox connection of a user, read from inbox_connections. getSettings() in
 * services/settings.ts is the only caller.
 *
 * - state: no row, or a disconnected one → "not_connected"; else the row's status.
 * - address: the mailbox, also after a disconnect (null only when none was ever connected).
 * - syncing: while connected, a sync of this user runs in this process now (the engine's
 *   registry) or anywhere (a live lease on the connection: another process, or a dry run).
 * - backfill: the first scan's (or a full re-scan's) progress while one runs; a scan that is
 *   about to start (pending while syncing) shows 0 of unknown.
 * - lastError: the stored code with its fixed text (inboxErrorMessage), never Google's words;
 *   hidden once disconnected.
 * - configured, demo: from the environment, as the screen needs them (see Settings["inbox"]).
 */
export async function getInboxStatus(db: Db, userId: string): Promise<InboxStatus> {
  const demo = getEnv().mailSource === "fixture";
  const configured = demo || (inboxTokenKeys() !== null && signInConfig() !== null);
  const [row] = await db<StatusRow[]>`
    SELECT status, email_address, backfill_state, backfill_total, backfill_done, last_sync_ok_at,
      last_error_code, last_error_at, updated_at, coalesce(lease_until > now(), false) AS leased
    FROM inbox_connections WHERE user_id = ${userId}`;

  const state: InboxState = !row || row.status === "disconnected" ? "not_connected" : row.status;
  const connected = state === "connected";
  const syncing = connected && (isSyncing(userId) || row.leased);
  const scanning = connected && (row.backfill_state === "running" || (row.backfill_state === "pending" && syncing));

  return {
    address: row?.email_address ?? null,
    connected,
    state,
    syncing,
    backfill: scanning ? { done: row.backfill_done, total: row.backfill_total } : null,
    lastCheckedAt: row?.last_sync_ok_at?.toISOString() ?? null,
    lastError:
      row && state !== "not_connected" && row.last_error_code
        ? {
            code: row.last_error_code,
            message: inboxErrorMessage(row.last_error_code),
            at: (row.last_error_at ?? row.updated_at).toISOString(),
          }
        : null,
    configured,
    demo,
  };
}
