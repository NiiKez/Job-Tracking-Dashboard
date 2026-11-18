import "server-only";
import { getDb } from "@/lib/server/db/client";
import { ConflictError } from "@/lib/server/errors";
import type { InboxDryRunResult, InboxDryRunSample, Job } from "@/lib/types";
import type { ParsedMessage } from "../parse/gmail-message";
import { finishedMessageIds, getSyncState, type SyncStateRow } from "../repo";
import { createMailSource } from "../source";
import type { MailSource } from "../source/types";
import {
  connectedState,
  FETCH_BATCH,
  FETCH_CONCURRENCY,
  mapLimit,
  nextListing,
  rescanAfter,
  stoppableRun,
  uniqueIds,
  type RunOptions,
} from "./engine";
import { inboxError, isMailSourceError } from "./errors";
import { classifyParsed, errorCode, fetchMessage, receivedTime, skipReason } from "./ingest";
import { holdLease, type HeldLease } from "./lease";

/**
 * The dry run (docs/plan/2-gmail-ingest.md, step 2.5; development only, the route refuses it in
 * production): what the next sync would do with the user's mailbox, with nothing written.
 *
 *   dryRunInboxCheck(userId, { limit? })  → InboxDryRunResult (src/lib/types.ts)
 *
 * - Lists what a real run would (sync/engine.ts nextListing): the mail added since the position,
 *   or the scan window (the first scan's, a resumed one's, or after an expired position the
 *   re-scan's), drops what the ledger has finished, and fetches the rest oldest first, at most
 *   `limit` (default and maximum DRY_RUN_FETCH_LIMIT) messages.
 * - Each fetched message is skipped as a real run would (labels, own address, gone) or
 *   classified with the same context, read in a READ ONLY transaction. Each is classified against
 *   the database as it is now: in a real run a later message can also match a job that an
 *   earlier message of the same run creates.
 * - Writes nothing: no ledger row, no sync position, no backfill progress, no email, no job, no
 *   failure. It holds the connection's lease while it runs, so no sync starts meanwhile (and it
 *   refuses with ConflictError while one runs), and releases it at the end. The one write it
 *   cannot rule out is the one any use of the stored refresh token makes: re-encrypting it during
 *   a key rotation (connection.ts getRefreshToken).
 * - A fetch that fails is counted by its error code; a stop, a token or a setup error ends the
 *   dry run with that error (the route answers 409 or 502 with the fixed text).
 * - The answer carries counts and up to DRY_RUN_SAMPLE examples (subject cut to 80 characters,
 *   outcome, review reason, company, status) for the owner to judge. Logs carry counts only.
 */

export const DRY_RUN_FETCH_LIMIT = 200;
export const DRY_RUN_SAMPLE = 50;
const SUBJECT_CHARS = 80;

export const DRY_RUN_BUSY_MESSAGE = "A sync is running. Try the dry run again when it has finished.";

export interface DryRunOptions extends RunOptions {
  /** How many messages to fetch at most: 1 to DRY_RUN_FETCH_LIMIT (default). */
  limit?: number;
}

/** See the contract at the top of this file. */
export async function dryRunInboxCheck(userId: string, opts: DryRunOptions = {}): Promise<InboxDryRunResult> {
  const db = getDb();
  const now = opts.now ?? (() => new Date());
  connectedState(await getSyncState(db, userId));
  const { controller, end } = stoppableRun(opts.signal);
  let lease: HeldLease | null = null;
  try {
    lease = await holdLease(db, userId, { onLost: () => controller.abort() });
    if (!lease) throw new ConflictError(DRY_RUN_BUSY_MESSAGE);
    // Read again under the lease, as a real run does.
    const state = connectedState(await getSyncState(db, userId));
    const source =
      opts.source ??
      createMailSource({ userId, emailAddress: state.email_address }, { signal: controller.signal, now, pace: opts.pace });
    return await dryRun({ userId, state, source, now, signal: controller.signal, limit: fetchLimit(opts.limit) });
  } finally {
    end();
    await lease?.release();
  }
}

function fetchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DRY_RUN_FETCH_LIMIT;
  return Math.min(DRY_RUN_FETCH_LIMIT, Math.max(1, Math.floor(limit)));
}

interface DryRunContext {
  userId: string;
  state: SyncStateRow;
  source: MailSource;
  now: () => Date;
  signal: AbortSignal;
  limit: number;
}

/** A sample entry and its received time, for sorting. */
type Example = { at: number; sample: InboxDryRunSample };

async function dryRun(run: DryRunContext): Promise<InboxDryRunResult> {
  const { userId, source, signal } = run;
  const db = getDb();

  // The listing, as the next real run would make it.
  const listing = nextListing(run.state, run.now());
  let mode = listing.mode;
  let after: Date | null = null;
  let listed: string[];
  if (listing.mode === "incremental") {
    try {
      listed = uniqueIds((await source.listAddedSince(listing.position)).messageIds);
    } catch (err) {
      if (!isMailSourceError(err, "history_expired")) throw err;
      mode = "full_scan";
      after = rescanAfter(run.state.last_sync_ok_at, run.now());
      listed = uniqueIds(await source.listMessageIds(after)).reverse();
    }
  } else {
    after = listing.after;
    listed = uniqueIds(await source.listMessageIds(after)).reverse();
  }
  const finished = await finishedMessageIds(db, userId, listed);
  const todo = listed.filter((id) => !finished.has(id));
  const take = todo.slice(0, run.limit);

  const result: InboxDryRunResult = {
    dryRun: true,
    checkedAt: "",
    mode,
    after: after?.toISOString() ?? null,
    listed: listed.length,
    alreadyDone: finished.size,
    fetchLimit: run.limit,
    fetched: take.length,
    notFetched: todo.length - take.length,
    skipped: { label: 0, ownAddress: 0, gone: 0 },
    ignored: 0,
    outcomes: { matched: 0, created: 0, review: 0 },
    reviewReasons: {},
    failed: {},
    sample: [],
    notes: [],
  };
  const related: Example[] = [];
  const ignored: Example[] = [];

  for (let i = 0; i < take.length; i += FETCH_BATCH) {
    checkStop(signal);
    const batch = await mapLimit(take.slice(i, i + FETCH_BATCH), FETCH_CONCURRENCY, async (id) => {
      checkStop(signal);
      try {
        return { id, parsed: await fetchMessage(source, id) };
      } catch (error) {
        return { id, error };
      }
    });
    for (const item of batch) {
      checkStop(signal);
      if ("error" in item) {
        const { error } = item;
        // Without the token, the setup or the run itself, the rest would fail the same way.
        if (isMailSourceError(error) && (error.code === "stopped" || error.kind !== "temporary")) throw error;
        const code = errorCode(error);
        result.failed[code] = (result.failed[code] ?? 0) + 1;
        continue;
      }
      const example = await look(run, item.parsed, result);
      if (example) (example.sample.outcome === "ignored" ? ignored : related).push(example);
    }
  }

  const byTime = (a: Example, b: Example) => a.at - b.at;
  result.sample = [...related.sort(byTime), ...ignored.sort(byTime)].slice(0, DRY_RUN_SAMPLE).map((e) => e.sample);
  result.notes = [
    "Nothing was written: no ledger rows, no sync position, no emails, no jobs.",
    `A dry run fetches at most ${run.limit} messages` +
      (result.notFetched > 0 ? `; ${result.notFetched} more were listed but not fetched.` : "."),
    "Each message was classified against the jobs as they are now. In a real run, a later message can also match a job an earlier message of the same run creates.",
  ];
  result.checkedAt = new Date().toISOString();
  console.info(
    `inbox: dry run ${mode}: listed ${result.listed}, already done ${result.alreadyDone}, fetched ${result.fetched}, ` +
      `ignored ${result.ignored}, matched ${result.outcomes.matched}, created ${result.outcomes.created}, ` +
      `review ${result.outcomes.review}, failed ${Object.values(result.failed).reduce((a, b) => a + b, 0)}`,
  );
  return result;
}

/** Skips or classifies one fetched message into the counts; the example, when classified. */
async function look(run: DryRunContext, parsed: ParsedMessage | null, result: InboxDryRunResult): Promise<Example | null> {
  if (!parsed) {
    result.skipped.gone++;
    return null;
  }
  const now = run.now();
  const receivedAt = receivedTime(parsed, now);
  const skip = skipReason(parsed, run.state.email_address);
  if (skip) {
    result.skipped[skip === "label" ? "label" : "ownAddress"]++;
    return null;
  }
  const { result: classified, jobs } = await getDb().begin("read only", (tx) =>
    classifyParsed(tx, run.userId, parsed, receivedAt, now),
  );
  const { effect } = classified;
  if (classified.outcome === "ignored") result.ignored++;
  else result.outcomes[classified.outcome]++;
  if (classified.reviewReason) {
    result.reviewReasons[classified.reviewReason] = (result.reviewReasons[classified.reviewReason] ?? 0) + 1;
  }
  const company = (id: string | undefined) => (id ? (jobs.find((j: Job) => j.id === id)?.company ?? null) : null);
  return {
    at: receivedAt.getTime(),
    sample: {
      receivedAt: receivedAt.toISOString(),
      subject: cut(parsed.subject),
      outcome: classified.outcome,
      reviewReason: classified.reviewReason,
      company:
        effect.kind === "link"
          ? company(effect.jobId)
          : effect.kind === "create"
            ? effect.company
            : effect.kind === "review"
              ? company(effect.suggestedJobIds[0])
              : null,
      status:
        effect.kind === "link"
          ? effect.to
          : effect.kind === "create"
            ? effect.status
            : effect.kind === "review"
              ? effect.suggestedStatus
              : null,
    },
  };
}

/** The subject on one line, at most SUBJECT_CHARS characters (code points). */
function cut(subject: string): string {
  const flat = (subject ?? "").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > SUBJECT_CHARS ? `${chars.slice(0, SUBJECT_CHARS - 1).join("")}…` : flat;
}

function checkStop(signal: AbortSignal): void {
  if (signal.aborted) throw inboxError("stopped");
}
