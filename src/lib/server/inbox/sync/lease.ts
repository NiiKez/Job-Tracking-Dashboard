import "server-only";
import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/server/db/client";
import { releaseLease, renewLease, takeLease } from "../repo";

/**
 * The connection's lease while a sync (or a dry run) runs (docs/plan/2-gmail-ingest.md, "Lease"):
 *
 *   holdLease(db, userId, { onLost })   takes the lease, or null when another run holds it (in
 *                                       this process or another). While held it is renewed every
 *                                       LEASE_RENEW_MS. release() stops renewing and gives it up;
 *                                       call it in `finally`.
 *
 * The lease outlives a crash by at most LEASE_SECONDS (repo.ts), after which the next run takes
 * it. When a renewal finds the lease taken by someone else (this process was frozen past
 * LEASE_SECONDS), `onLost` is called once: the run must stop, as another one now runs. A renewal
 * that fails on the database is logged and tried again at the next tick.
 *
 * The owner is unique per run ("<pid>.<uuid>"), so two runs of one process never share a lease.
 */

export const LEASE_RENEW_MS = 30_000;

export interface HeldLease {
  readonly owner: string;
  /** Stops renewing and releases the lease. Never throws (it expires on its own otherwise). */
  release(): Promise<void>;
}

export interface LeaseOptions {
  /** Called once when a renewal finds the lease taken over. */
  onLost?: () => void;
  /** Test seam (default LEASE_RENEW_MS). */
  renewMs?: number;
}

export async function holdLease(db: Db, userId: string, opts: LeaseOptions = {}): Promise<HeldLease | null> {
  const owner = `${process.pid}.${randomUUID()}`;
  if (!(await takeLease(db, userId, owner))) return null;

  let released = false;
  let renewing: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (released || renewing) return;
    renewing = renewLease(db, userId, owner)
      .then((held) => {
        if (held || released) return;
        released = true;
        clearInterval(timer);
        console.warn("inbox: the sync lease was taken over, stopping this run");
        opts.onLost?.();
      })
      .catch((err: unknown) => {
        console.warn(`inbox: renewing the sync lease failed (${err instanceof Error ? err.name : "unknown"})`);
      })
      .finally(() => {
        renewing = null;
      });
  }, opts.renewMs ?? LEASE_RENEW_MS);
  // A lease must never keep the process alive on its own.
  timer.unref?.();

  return {
    owner,
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        await renewing;
        await releaseLease(db, userId, owner);
      } catch (err) {
        console.warn(`inbox: releasing the sync lease failed (${err instanceof Error ? err.name : "unknown"})`);
      }
    },
  };
}
