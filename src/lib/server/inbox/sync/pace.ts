import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { inboxError, isRetryable } from "./errors";

/**
 * The pace of Gmail requests for one mailbox (docs/plan/2-gmail-ingest.md, "Pace"):
 *
 * - a token bucket in quota units: QUOTA_UNITS_PER_MINUTE refill, at most BURST_UNITS saved up;
 * - at most MAX_CONCURRENT_REQUESTS requests at a time;
 * - retries of temporary failures (isRetryable: rate limits, 5xx, network, timeouts) with
 *   exponential backoff and full jitter between 1 and 64 seconds, at least as long as
 *   Retry-After, for at most MAX_ATTEMPTS attempts. A rate limit holds every request of this
 *   pacer, not only the one that saw it. A Retry-After longer than 64 seconds is not waited
 *   out here: the error is thrown with retryAfterMs, and the run ends.
 *
 * Gmail's quota and its warning about parallel requests are per user, so use one pacer per
 * mailbox (one per sync run is fine: runs of one user never overlap, and BURST_UNITS keeps a
 * run that starts right after another under Google's per-minute limit).
 *
 * Stop-aware: pass an AbortSignal and every wait (for a slot, for quota, for a retry) ends at
 * once with MailSourceError("temporary", "stopped"). A request already sent gets the signal
 * through its own `fetch` (gmail-client.ts).
 *
 * Quota figures: Google's Gmail API quota page (developers.google.com/workspace/gmail/api/
 * reference/quota), checked again on 2026-11-16 while building this: 6,000 units per user per
 * minute for projects created since 2026-05-01; getProfile 1, history.list 2, messages.list 5,
 * messages.get 20 (60 for format full, raw or html), messages.attachments.get 20. Projects
 * created earlier keep their older quotas, so the budget stays one constant.
 */

/** Quota units per call (Google's table). The client always uses messages.get with format=full. */
export const QUOTA_COST = {
  "users.getProfile": 1,
  "users.history.list": 2,
  "users.messages.list": 5,
  "users.messages.get": 60,
  "users.messages.attachments.get": 20,
} as const satisfies Record<string, number>;

export type GmailMethod = keyof typeof QUOTA_COST;

/** 80 % of Google's 6,000 per user per minute. */
export const QUOTA_UNITS_PER_MINUTE = 4_800;
/**
 * Units that may be saved up while idle. Any 60 seconds then carry at most 4,800 + 600 units,
 * under Google's 6,000.
 */
export const BURST_UNITS = 600;
export const MAX_CONCURRENT_REQUESTS = 3;
/** Attempts per request, the first included: six retries reach the 64-second ceiling. */
export const MAX_ATTEMPTS = 7;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 64_000;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface PacerOptions {
  unitsPerMinute?: number;
  burstUnits?: number;
  concurrency?: number;
  maxAttempts?: number;
  /** Test seams: the clock (ms), the wait (rejects when the signal aborts) and Math.random. */
  now?: () => number;
  sleep?: Sleep;
  random?: () => number;
}

export interface Pacer {
  /**
   * Runs one Gmail request: waits for a slot and for `method`'s quota, then calls `request`.
   * Retries it while it throws a retryable MailSourceError. Throws MailSourceError("temporary",
   * "stopped") once `signal` aborts.
   */
  run<T>(method: GmailMethod, request: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

const defaultSleep: Sleep = (ms, signal) => delay(ms, undefined, { signal });

/**
 * The wait before retry number `retry` (1 for the first retry): uniformly random between 1 second
 * and min(64 s, 2^retry seconds). The 1-second floor keeps a retry from following a rate limit
 * straight away.
 */
export function backoffDelay(retry: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(1, retry));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(BACKOFF_MIN_MS + r * (ceiling - BACKOFF_MIN_MS));
}

export function createPacer(opts: PacerOptions = {}): Pacer {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_ATTEMPTS);
  const bucket = createBucket(opts.unitsPerMinute ?? QUOTA_UNITS_PER_MINUTE, opts.burstUnits ?? BURST_UNITS, now);
  const slots = createSlots(Math.max(1, opts.concurrency ?? MAX_CONCURRENT_REQUESTS));
  // Set by a rate limit: no request of this pacer starts before this time.
  let holdUntil = 0;

  // Every wait goes through here, so an abort always ends as "stopped".
  async function wait(ms: number, signal: AbortSignal | undefined) {
    if (ms <= 0) return;
    try {
      await sleep(ms, signal);
    } catch (err) {
      if (signal?.aborted) throw inboxError("stopped", { cause: err });
      throw err;
    }
  }

  return {
    async run(method, request, signal) {
      const cost = QUOTA_COST[method];
      for (let attempt = 1; ; attempt++) {
        throwIfStopped(signal);
        // A hold can be extended while we wait: wait until no hold is left.
        while (holdUntil > now()) await wait(holdUntil - now(), signal);

        await slots.acquire(signal);
        let retryIn: number;
        try {
          await bucket.take(cost, signal, wait);
          throwIfStopped(signal);
          return await request();
        } catch (err) {
          if (!isRetryable(err) || attempt >= maxAttempts || signal?.aborted) throw err;
          const retryAfter = err.retryAfterMs;
          // Longer than the longest backoff: let the run end, and the scheduler wait instead.
          if (retryAfter !== null && retryAfter > BACKOFF_MAX_MS) throw err;
          retryIn = Math.max(backoffDelay(attempt, random), retryAfter ?? 0);
          if (err.code === "rate_limited") holdUntil = Math.max(holdUntil, now() + retryIn);
        } finally {
          slots.release();
        }
        await wait(retryIn, signal);
      }
    },
  };
}

function throwIfStopped(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw inboxError("stopped");
}

/**
 * The token bucket. Reservations are taken in call order: the balance may go negative, and a
 * caller waits until its own share has been refilled. An aborted wait gives its units back.
 */
function createBucket(unitsPerMinute: number, capacity: number, now: () => number) {
  const perMs = unitsPerMinute / 60_000;
  let balance = capacity;
  let at = now();

  function refill() {
    const t = now();
    if (t > at) {
      balance = Math.min(capacity, balance + (t - at) * perMs);
      at = t;
    }
  }

  return {
    async take(units: number, signal: AbortSignal | undefined, wait: (ms: number, signal?: AbortSignal) => Promise<void>) {
      refill();
      balance -= units;
      if (balance >= 0) return;
      try {
        await wait(Math.ceil(-balance / perMs), signal);
      } catch (err) {
        refill();
        balance = Math.min(capacity, balance + units);
        throw err;
      }
    },
  };
}

/** A counting semaphore, first come first served; a waiter leaves the queue when it aborts. */
function createSlots(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return {
    acquire(signal: AbortSignal | undefined): Promise<void> {
      throwIfStopped(signal);
      if (active < limit) {
        active++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const i = queue.indexOf(grant);
          if (i >= 0) queue.splice(i, 1);
          reject(inboxError("stopped"));
        };
        const grant = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        queue.push(grant);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    release() {
      const next = queue.shift();
      // The slot passes straight to the next waiter: `active` stays the same.
      if (next) next();
      else active--;
    },
  };
}

/**
 * `promise`, or MailSourceError("temporary", "stopped") as soon as `signal` aborts. The promise
 * itself goes on (its result is dropped); use it for work shared with other callers, such as one
 * token refresh.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(inboxError("stopped"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(inboxError("stopped"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
