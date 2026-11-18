import { route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { getEnv } from "@/lib/server/env";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/server/errors";
import { ensureDemoConnection, getSyncState } from "@/lib/server/inbox/repo";
import { sweepNoResponse } from "@/lib/server/inbox/sweep";
import { DRY_RUN_FETCH_LIMIT, dryRunInboxCheck } from "@/lib/server/inbox/sync/dry-run";
import {
  CHECK_WAIT_MS,
  NEEDS_RECONNECT_MESSAGE,
  NOT_CONNECTED_MESSAGE,
  runInboxCheck,
  runProgress,
  settleWithin,
} from "@/lib/server/inbox/sync/engine";
import { inboxErrorMessage, isMailSourceError } from "@/lib/server/inbox/sync/errors";
import type { InboxCheckResult, InboxDryRunResult } from "@/lib/types";

/**
 * "Check inbox now" (docs/plan/2-gmail-ingest.md, "API and type changes"). Runs a sync of the
 * user's mailbox, or joins the one already running, and waits for it up to 20 seconds:
 *
 *   200 { state: "done" }     the sync finished: `scanned` messages looked at, `processed` the
 *                             job mail stored, `noResponseMarked` the jobs the no-response sweep
 *                             marked (it runs after a sync that finished completely)
 *   200 { state: "running" }  still going after the wait (a first scan, or a sync that was
 *                             already running), or running in another process (it holds the
 *                             connection's lease). It keeps running; `scanned` so far, nothing else.
 *   409                       not connected, or Gmail needs to be reconnected (also when the
 *                             sync found that out); in demo mode, the user's inbox is a Gmail
 *                             connection (DEMO_ON_GMAIL_MESSAGE)
 *   502                       the mail source failed (setup, temporary, expired position): the
 *                             fixed text for the error code, never Google's own words
 *
 * In demo mode (MAIL_SOURCE=fixture) the user's demo connection is created (or re-connected)
 * first, so the demo mail in fixtures/mail can be checked without Google. A Gmail connection
 * (connected or not) is never turned into it: ensureDemoConnection refuses with the 409 above
 * and leaves the connection, its token, the ledger and the jobs as they are.
 *
 * Dry run, development only: POST /api/inbox/check?dryRun=1[&limit=N] fetches and classifies
 * what the next sync would (at most 200 messages, or N), writes nothing, and answers
 * InboxDryRunResult (counts and up to 50 examples) once it is done, however long that takes.
 * 404 when NODE_ENV is "production"; 409 when not connected, needing a reconnect, or while a
 * sync runs; 502 as above. Demo mode does not create a connection for it. From the browser's
 * devtools on the app's own page:
 *
 *   await (await fetch("/api/inbox/check?dryRun=1", { method: "POST",
 *     headers: { "content-type": "application/json" } })).json()
 */
export const POST = route(async ({ req, user }): Promise<InboxCheckResult | InboxDryRunResult | Response> => {
  const dryRun = req.nextUrl.searchParams.get("dryRun");
  if (dryRun === "1" || dryRun === "true") {
    if (process.env.NODE_ENV === "production") throw new NotFoundError("Not found");
    return checkDry(user.id, req.nextUrl.searchParams.get("limit"));
  }

  const db = getDb();
  if (getEnv().mailSource === "fixture") await ensureDemoConnection(db, user.id);
  const connection = await getSyncState(db, user.id);
  if (connection?.status === "needs_reconnect") throw new ConflictError(NEEDS_RECONNECT_MESSAGE);
  if (connection?.status !== "connected") throw new ConflictError(NOT_CONNECTED_MESSAGE);

  const check = runInboxCheck(user.id).then(async (result) => ({
    result,
    marked: result.complete ? await sweepNoResponse(user.id) : [],
  }));
  // Past the wait nobody listens: the run records its own outcome on the connection.
  check.catch(() => {});

  try {
    const outcome = await settleWithin(check, CHECK_WAIT_MS);
    if (!outcome.done || outcome.value.result.busy) {
      return {
        checkedAt: new Date().toISOString(),
        state: "running",
        scanned: runProgress(user.id)?.scanned ?? 0,
        processed: [],
        noResponseMarked: [],
      };
    }
    const { result, marked } = outcome.value;
    return {
      checkedAt: result.finishedAt.toISOString(),
      state: "done",
      scanned: result.scanned,
      processed: result.stored,
      noResponseMarked: marked,
    };
  } catch (err) {
    return sourceFailure(err);
  }
});

async function checkDry(userId: string, limitParam: string | null): Promise<InboxDryRunResult | Response> {
  let limit: number | undefined;
  if (limitParam !== null) {
    limit = /^\d{1,4}$/.test(limitParam) ? Number(limitParam) : NaN;
    if (!(limit >= 1 && limit <= DRY_RUN_FETCH_LIMIT)) {
      throw new BadRequestError(`limit must be a whole number from 1 to ${DRY_RUN_FETCH_LIMIT}`);
    }
  }
  try {
    return await dryRunInboxCheck(userId, { limit });
  } catch (err) {
    return sourceFailure(err);
  }
}

/** A mail-source failure as the answer: 409 for a token problem, else 502; anything else is thrown on. */
function sourceFailure(err: unknown): Response {
  if (!isMailSourceError(err)) throw err;
  if (err.kind === "needs_reconnect") throw new ConflictError(inboxErrorMessage(err.code));
  return Response.json({ error: inboxErrorMessage(err.code) }, { status: 502 });
}
