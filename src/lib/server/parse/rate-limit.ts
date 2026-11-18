import "server-only";

/**
 * A small in-memory limit on link fetches per user, so the parse endpoint cannot be used to
 * make this server send many requests. Process-local: the app runs as one process, and a
 * restart only resets the counts. Over the limit the parser skips the fetch and uses the
 * heuristics, so the user still gets a result.
 */

export const FETCHES_PER_WINDOW = 10;
export const WINDOW_MS = 60_000;
// Keeps memory bounded if many keys show up (the app has one allowed account).
const MAX_KEYS = 1_000;

export interface RateLimiter {
  /** Counts one fetch for `key`. False when the key is over its limit (nothing is counted then). */
  take(key: string): boolean;
}

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
  /** Test seam: the clock. */
  now?: () => number;
}

export function createRateLimiter({
  limit = FETCHES_PER_WINDOW,
  windowMs = WINDOW_MS,
  now = Date.now,
}: RateLimitOptions = {}): RateLimiter {
  // Sliding window: the times of the fetches in the last `windowMs`, oldest first.
  const recent = new Map<string, number[]>();

  function prune(times: number[], at: number) {
    while (times.length && times[0] <= at - windowMs) times.shift();
  }

  return {
    take(key) {
      const at = now();
      const times = recent.get(key) ?? [];
      prune(times, at);
      if (times.length >= limit) return false;
      times.push(at);
      // Re-insert so the Map's order is least recently used first.
      recent.delete(key);
      recent.set(key, times);
      if (recent.size > MAX_KEYS) {
        for (const [k, t] of recent) {
          prune(t, at);
          if (!t.length) recent.delete(k);
        }
        // Still too many active keys: drop the least recently used.
        for (const k of recent.keys()) {
          if (recent.size <= MAX_KEYS) break;
          recent.delete(k);
        }
      }
      return true;
    },
  };
}
