import { describe, expect, it } from "vitest";
import { inboxError, MailSourceError } from "@/lib/server/inbox/sync/errors";
import {
  abortable,
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  backoffDelay,
  BURST_UNITS,
  createPacer,
  MAX_ATTEMPTS,
  MAX_CONCURRENT_REQUESTS,
  QUOTA_COST,
  QUOTA_UNITS_PER_MINUTE,
  type PacerOptions,
} from "@/lib/server/inbox/sync/pace";

/**
 * A clock that only moves when the test lets it: sleep() registers a timer; run() lets every
 * pending promise settle, then jumps to the next timer, until the awaited promise settles.
 */
function fakeTime() {
  let t = 0;
  let seq = 0;
  let timers: Array<{ at: number; seq: number; fire: () => void }> = [];
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = () => {
        timers = timers.filter((x) => x !== timer);
        reject(signal?.reason);
      };
      const timer = {
        at: t + Math.max(0, ms),
        seq: seq++,
        fire: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      timers.push(timer);
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  /** Moves time forward to `until` (or until nothing is left), firing timers in order. */
  async function advance(until = Infinity) {
    for (;;) {
      await flush();
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      t = next.at;
      next.fire();
    }
    if (until !== Infinity) t = Math.max(t, until);
    await flush();
  }

  async function run<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    while (!settled) {
      await flush();
      if (settled) break;
      if (timers.length === 0) throw new Error("deadlock: nothing left to wait for");
      await advance(Math.min(...timers.map((x) => x.at)));
    }
    return promise;
  }

  return { now: () => t, sleep, advance, run, pending: () => timers.length };
}

function pacerWith(time: ReturnType<typeof fakeTime>, opts: PacerOptions = {}) {
  return createPacer({ now: time.now, sleep: time.sleep, random: () => 0.5, ...opts });
}

describe("constants", () => {
  it("uses the plan's budget, concurrency and Google's quota table", () => {
    expect(QUOTA_UNITS_PER_MINUTE).toBe(4_800);
    expect(MAX_CONCURRENT_REQUESTS).toBe(3);
    expect(QUOTA_COST).toEqual({
      "users.getProfile": 1,
      "users.history.list": 2,
      "users.messages.list": 5,
      "users.messages.get": 60,
      "users.messages.attachments.get": 20,
    });
    // Any 60 seconds stay under Google's 6,000 units per user.
    expect(QUOTA_UNITS_PER_MINUTE + BURST_UNITS).toBeLessThan(6_000);
  });
});

describe("backoffDelay", () => {
  it("is full jitter between 1 second and an exponential ceiling capped at 64 seconds", () => {
    expect(backoffDelay(1, () => 0)).toBe(BACKOFF_MIN_MS);
    expect(backoffDelay(1, () => 1)).toBe(2_000);
    expect(backoffDelay(3, () => 1)).toBe(8_000);
    expect(backoffDelay(6, () => 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(20, () => 1)).toBe(BACKOFF_MAX_MS);
    for (let retry = 1; retry < 10; retry++) {
      const d = backoffDelay(retry);
      expect(d).toBeGreaterThanOrEqual(BACKOFF_MIN_MS);
      expect(d).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    }
  });
});

describe("token bucket", () => {
  it("lets the burst through at once, then one full message every 0.75 seconds", async () => {
    const time = fakeTime();
    const pacer = pacerWith(time);
    const starts: number[] = [];
    const all = Promise.all(
      Array.from({ length: 14 }, () =>
        pacer.run("users.messages.get", async () => {
          starts.push(time.now());
        }),
      ),
    );
    await time.run(all);
    // 600 burst units = 10 messages at once; 4,800 units a minute = 80 a second = one per 750 ms.
    expect(starts.slice(0, 10)).toEqual(Array(10).fill(0));
    expect(starts.slice(10)).toEqual([750, 1_500, 2_250, 3_000]);
  });

  it("charges each method its own cost", async () => {
    const time = fakeTime();
    const pacer = pacerWith(time, { burstUnits: 10, unitsPerMinute: 600 }); // 10 units a second
    const starts: number[] = [];
    const go = (method: Parameters<typeof pacer.run>[0]) =>
      pacer.run(method, async () => {
        starts.push(time.now());
      });
    await time.run(go("users.messages.list")); // 5: from the burst
    await time.run(go("users.history.list")); // 2: from the burst
    await time.run(go("users.messages.attachments.get")); // 20: 3 left, waits 1.7 s
    expect(starts).toEqual([0, 0, 1_700]);
  });

  it("refills while idle, up to the burst only", async () => {
    const time = fakeTime();
    const pacer = pacerWith(time);
    const starts: number[] = [];
    const burst = () =>
      Promise.all(
        Array.from({ length: 11 }, () =>
          pacer.run("users.messages.get", async () => {
            starts.push(time.now());
          }),
        ),
      );
    await time.run(burst());
    await time.advance(time.now() + 10 * 60_000);
    const idleUntil = time.now();
    starts.length = 0;
    await time.run(burst());
    expect(starts.slice(0, 10)).toEqual(Array(10).fill(idleUntil));
    expect(starts[10]).toBe(idleUntil + 750);
  });
});

describe("concurrency", () => {
  it("runs at most three requests at a time, in order", async () => {
    const time = fakeTime();
    const pacer = pacerWith(time);
    let active = 0;
    let most = 0;
    const order: number[] = [];
    const all = Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        pacer.run("users.getProfile", async () => {
          order.push(i);
          active++;
          most = Math.max(most, active);
          await time.sleep(1_000);
          active--;
        }),
      ),
    );
    await time.run(all);
    expect(most).toBe(3);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(time.now()).toBe(3_000);
  });
});

describe("retries", () => {
  it("retries a temporary failure after a backoff between 1 and 2 seconds", async () => {
    const time = fakeTime();
    const pacer = pacerWith(time);
    const attempts: number[] = [];
    const result = pacer.run("users.messages.list", async () => {
      attempts.push(time.now());
      if (attempts.length === 1) throw inboxError("google_unavailable");
      return "ok";
    });
    await expect(time.run(result)).resolves.toBe("ok");
    expect(attempts).toHaveLength(2);
    expect(attempts[1] - attempts[0]).toBe(1_500); // random 0.5 → halfway between 1 s and 2 s
  });

  it("retries network errors, timeouts and rate limits, with growing waits", async () => {
    const time = fakeTime();
    const pacer = pacerWith(time, { random: () => 1 });
    const codes = ["network", "timeout", "rate_limited", "google_unavailable"] as const;
    const attempts: number[] = [];
    const result = pacer.run("users.getProfile", async () => {
      attempts.push(time.now());
      if (attempts.length <= codes.length) throw inboxError(codes[attempts.length - 1]);
      return "ok";
    });
    await expect(time.run(result)).resolves.toBe("ok");
    const waits = attempts.slice(1).map((at, i) => at - attempts[i]);
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it("does not retry what waiting cannot fix", async () => {
    for (const code of ["token_rejected", "gmail_api_disabled", "history_expired", "bad_request", "bad_response", "stopped"] as const) {
      const time = fakeTime();
      const pacer = pacerWith(time);
      let calls = 0;
      const result = pacer.run("users.getProfile", async () => {
        calls++;
        throw inboxError(code);
      });
      await expect(time.run(result)).rejects.toMatchObject({ code });
      expect(calls).toBe(1);
    }
  });

  it("does not retry an error that is not a MailSourceError", async () => {
    const time = fakeTime();
    let calls = 0;
    const result = pacerWith(time).run("users.getProfile", async () => {
      calls++;
      throw new Error("bug");
    });
    await expect(time.run(result)).rejects.toThrow("bug");
    expect(calls).toBe(1);
  });

  it("gives up after MAX_ATTEMPTS, with the last error", async () => {
    const time = fakeTime();
    let calls = 0;
    const result = pacerWith(time).run("users.getProfile", async () => {
      calls++;
      throw inboxError("google_unavailable");
    });
    await expect(time.run(result)).rejects.toMatchObject({ kind: "temporary", code: "google_unavailable" });
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it("waits at least Retry-After, and holds every request meanwhile", async () => {
    const time = fakeTime();
    const pacer = pacerWith(time);
    const starts: Array<[string, number]> = [];
    let limited = false;
    const first = pacer.run("users.getProfile", async () => {
      starts.push(["first", time.now()]);
      if (!limited) {
        limited = true;
        throw inboxError("rate_limited", { retryAfterMs: 20_000 });
      }
    });
    await time.advance(0);
    const second = pacer.run("users.getProfile", async () => {
      starts.push(["second", time.now()]);
    });
    await time.run(Promise.all([first, second]));
    expect(starts).toEqual([
      ["first", 0],
      ["first", 20_000],
      ["second", 20_000],
    ]);
  });

  it("does not wait out a Retry-After longer than 64 seconds", async () => {
    const time = fakeTime();
    let calls = 0;
    const result = pacerWith(time).run("users.getProfile", async () => {
      calls++;
      throw inboxError("rate_limited", { retryAfterMs: 3_600_000 });
    });
    await expect(time.run(result)).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 3_600_000 });
    expect(calls).toBe(1);
    expect(time.now()).toBe(0);
  });
});

describe("stopping", () => {
  it("an aborted signal runs nothing", async () => {
    const time = fakeTime();
    let calls = 0;
    const result = pacerWith(time).run(
      "users.getProfile",
      async () => {
        calls++;
      },
      AbortSignal.abort(),
    );
    await expect(result).rejects.toMatchObject({ kind: "temporary", code: "stopped" });
    expect(calls).toBe(0);
  });

  it("ends a backoff wait at once", async () => {
    const time = fakeTime();
    const controller = new AbortController();
    const result = pacerWith(time).run(
      "users.getProfile",
      async () => {
        throw inboxError("network");
      },
      controller.signal,
    );
    result.catch(() => {});
    await time.advance(0);
    expect(time.pending()).toBe(1); // the backoff
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "stopped" });
    expect(time.now()).toBe(0);
  });

  it("ends a wait for a slot or for quota at once, and gives the quota back", async () => {
    const time = fakeTime();
    const pacer = pacerWith(time, { concurrency: 1 });
    const controller = new AbortController();
    let release!: () => void;
    const holder = pacer.run("users.getProfile", () => new Promise<void>((resolve) => (release = resolve)));
    const waitingForSlot = pacer.run("users.getProfile", async () => {}, controller.signal);
    waitingForSlot.catch(() => {});
    await time.advance(0);
    controller.abort();
    await expect(waitingForSlot).rejects.toMatchObject({ code: "stopped" });
    release();
    await time.run(holder);

    // Quota: drain the burst, then abort a request waiting for units; the next one is not delayed by it.
    const quota = pacerWith(time);
    await time.run(Promise.all(Array.from({ length: 10 }, () => quota.run("users.messages.get", async () => {}))));
    const start = time.now();
    const stop = new AbortController();
    const waitingForQuota = quota.run("users.messages.get", async () => {}, stop.signal);
    waitingForQuota.catch(() => {});
    await time.advance(start);
    stop.abort();
    await expect(waitingForQuota).rejects.toMatchObject({ code: "stopped" });
    let ranAt = -1;
    await time.run(
      quota.run("users.messages.get", async () => {
        ranAt = time.now();
      }),
    );
    expect(ranAt).toBe(start + 750);
  });
});

describe("abortable", () => {
  it("passes the result through, or rejects as stopped when the signal aborts first", async () => {
    await expect(abortable(Promise.resolve(1), undefined)).resolves.toBe(1);
    await expect(abortable(Promise.resolve(2), new AbortController().signal)).resolves.toBe(2);
    await expect(abortable(Promise.reject(new Error("x")), new AbortController().signal)).rejects.toThrow("x");
    await expect(abortable(Promise.resolve(3), AbortSignal.abort())).rejects.toBeInstanceOf(MailSourceError);
    const controller = new AbortController();
    const pending = abortable(new Promise(() => {}), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "stopped" });
  });
});

describe("default sleep", () => {
  it("uses real timers that the signal cancels", async () => {
    const pacer = createPacer({ random: () => 0 });
    const controller = new AbortController();
    const started = Date.now();
    const result = pacer.run(
      "users.getProfile",
      async () => {
        throw inboxError("network");
      },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 10);
    await expect(result).rejects.toMatchObject({ code: "stopped" });
    expect(Date.now() - started).toBeLessThan(900);
  });
});
