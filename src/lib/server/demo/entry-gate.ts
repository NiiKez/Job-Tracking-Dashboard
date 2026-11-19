import "server-only";
import { createRateLimiter } from "@/lib/server/parse/rate-limit";

/**
 * The limit on creating workspaces (docs/plan/5-public-demo.md, "Limits"): one at a time, at most
 * 10 waiting, at most 30 per minute in total. POST /auth/demo runs createWorkspace through it, so
 * a burst of visitors cannot pile up transactions of about 250 statements each, nor churn
 * through the workspaces faster than people can use them.
 *
 *   runEntry(fn)              through the process's gate: fn's result, or "busy" without running
 *                             fn. fn's error is passed on (and the next one runs).
 *   createEntryGate(opts?)    a gate of its own: other limits, and the clock (tests)
 *     .run(fn)                as runEntry
 *     .pending                how many run or wait right now
 *   ENTRY_LIMITS              { waiting: 10, perMinute: 30 } (and one running)
 *   resetEntryGateForTests()  forget the process's gate
 *
 * A request is refused at once when ENTRY_LIMITS.waiting already wait behind the one running, or
 * when ENTRY_LIMITS.perMinute were let in during the last minute (a sliding window; refused
 * requests do not count). Otherwise it is counted, waits for its turn (first come, first
 * served) and runs. With a creation taking a few hundred milliseconds, a full queue is a few
 * seconds of waiting at most.
 *
 * It reads nothing about the client, no address: that is nginx's job (per-address limits, see the
 * runbook). Process-local, like the link-fetch limit (parse/rate-limit.ts): the demo runs as one
 * process, and a restart (every deploy) starts it empty. createWorkspace's advisory lock makes
 * creations take turns across processes as well; this gate keeps the queue in front of it short.
 */

export const ENTRY_LIMITS = Object.freeze({
  /** Requests waiting behind the one that runs. */
  waiting: 10,
  /** Requests let in per minute, in total. */
  perMinute: 30,
});

const MINUTE_MS = 60_000;

export interface EntryGate {
  /** fn's result, or "busy" when fn was not run. */
  run<T>(fn: () => Promise<T>): Promise<T | "busy">;
  /** How many run or wait right now. */
  readonly pending: number;
}

export interface EntryGateOptions {
  /** Default ENTRY_LIMITS.waiting. */
  maxWaiting?: number;
  /** Default ENTRY_LIMITS.perMinute. */
  perMinute?: number;
  /** Test seam: the clock (ms). */
  now?: () => number;
}

export function createEntryGate({
  maxWaiting = ENTRY_LIMITS.waiting,
  perMinute = ENTRY_LIMITS.perMinute,
  now = Date.now,
}: EntryGateOptions = {}): EntryGate {
  // One key: the limit is for everyone together.
  const admitted = createRateLimiter({ limit: perMinute, windowMs: MINUTE_MS, now });
  let running = false;
  /** Who waits, first come first: each resolves to start its run. */
  const queue: Array<() => void> = [];

  return {
    get pending() {
      return (running ? 1 : 0) + queue.length;
    },

    async run<T>(fn: () => Promise<T>): Promise<T | "busy"> {
      // The queue first: a request refused for it is not counted against the minute.
      if (running && queue.length >= maxWaiting) return "busy";
      if (!admitted.take("entry")) return "busy";
      if (running) await new Promise<void>((resolve) => queue.push(resolve));
      else running = true;
      try {
        return await fn();
      } finally {
        // Hand the turn to the next one (running stays true), or end it.
        const next = queue.shift();
        if (next) next();
        else running = false;
      }
    },
  };
}

// On globalThis, so a hot reload in development (and every bundle's copy of this module) shares
// one gate, as with the database pool.
const g = globalThis as unknown as { __jobTrackerDemoEntryGate?: EntryGate };

/** Runs fn through the process's gate: see the top of this file. */
export function runEntry<T>(fn: () => Promise<T>): Promise<T | "busy"> {
  g.__jobTrackerDemoEntryGate ??= createEntryGate();
  return g.__jobTrackerDemoEntryGate.run(fn);
}

/** Test seam: forget the process's gate (its queue and its minute). */
export function resetEntryGateForTests(): void {
  g.__jobTrackerDemoEntryGate = undefined;
}
