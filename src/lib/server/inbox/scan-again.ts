import "server-only";
import { getDb, withTx } from "@/lib/server/db/client";
import { getEnv } from "@/lib/server/env";
import { ConflictError } from "@/lib/server/errors";
import { DEMO_ON_GMAIL_MESSAGE, getSyncState, resetScan } from "./repo";
import { isSyncing, NEEDS_RECONNECT_MESSAGE, NOT_CONNECTED_MESSAGE, runInboxCheck } from "./sync/engine";

/** While a sync runs, the scan cannot be restarted under it. */
export const SYNC_RUNNING_MESSAGE = "A sync is running. Try again when it has finished.";

/**
 * "Scan again" (Settings → Inbox): reads the mailbox again as far back as a first scan does
 * (INBOX_BACKFILL_DAYS), with the keywords and the pipeline of now. For mail the first scan
 * passed over (a confirmation in words no keyword knew, before a release that reads it): it is
 * classified again, and a job it belongs to is created or moved as by any sync. Mail already
 * stored is not read again (repo.ts resetScan), so nothing is filed twice.
 *
 * Resets the scan (repo.ts resetScan), then starts the run as "Check inbox" does and answers
 * without waiting for it: Settings shows the scan's progress while it runs (settings polls while
 * the inbox is busy). The run records its own outcome; the scheduler's periodic no-response
 * sweep picks up what the scan changed. runInboxCheck(userId) joins the run (tests await it).
 *
 * ConflictError when not connected, when Gmail needs a reconnect, in demo mode on a Gmail
 * connection (DEMO_ON_GMAIL_MESSAGE), and while a sync runs here or elsewhere (a held lease):
 * nothing is changed then. Returns how many ledger rows were forgotten.
 */
export async function scanAgain(userId: string): Promise<{ forgotten: number }> {
  const db = getDb();
  const state = await getSyncState(db, userId);
  if (state?.status === "needs_reconnect") throw new ConflictError(NEEDS_RECONNECT_MESSAGE);
  if (state?.status !== "connected") throw new ConflictError(NOT_CONNECTED_MESSAGE);
  if (getEnv().mailSource === "fixture" && !state.demo) throw new ConflictError(DEMO_ON_GMAIL_MESSAGE);
  if (isSyncing(userId)) throw new ConflictError(SYNC_RUNNING_MESSAGE);

  const reset = await withTx((tx) => resetScan(tx, userId));
  if (!reset) throw new ConflictError(SYNC_RUNNING_MESSAGE);

  // Past the answer nobody listens: the run records its own outcome on the connection.
  runInboxCheck(userId).catch(() => {});
  return reset;
}
