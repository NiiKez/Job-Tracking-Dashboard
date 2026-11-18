import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEnv, resetEnvForTests } from "@/lib/server/env";
import { SWEEP_EVERY_MS } from "@/lib/server/inbox/sweep";
import { inboxError } from "@/lib/server/inbox/sync/errors";
import {
  isSchedulerRunning,
  LEDGER_CLEANUP_EVERY_MS,
  resetSchedulerForTests,
  startInboxScheduler,
  stopInboxScheduler,
  TICK_MS,
  type SchedulerDeps,
  type SignalHost,
} from "@/lib/server/inbox/sync/scheduler";

// The inbox scheduler with fake timers and injected functions: when it starts, how a tick runs,
// and how it stops. The database side (the due query, the engine's back-off, the gate) is in
// tests/db/inbox/scheduler.test.ts and sweep.test.ts.

const KEY = "b".repeat(64);
const FIXTURE = parseEnv({ MAIL_SOURCE: "fixture" });
const GMAIL = parseEnv({ INBOX_TOKEN_KEY: KEY });
const HOUR = 3_600_000;
/** The start line with every part running. */
const STARTED = "inbox: scheduler started, every 60 s: timed syncs, the no-response sweep and the ledger clean-up";
/** The start line when only the maintenance runs, and why. */
const maintenanceOnly = (why: string) =>
  `inbox: scheduler started, every 60 s: no timed syncs (${why}), only the no-response sweep and the ledger clean-up`;

/** Lets every pending promise settle (setImmediate is not faked). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Moves the fake clock by `ms`, firing the timer on the way, then lets the tick run. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 5; i++) await settle();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A stand-in for `process`: listeners on an EventEmitter, kill only recorded. */
function fakeProcess() {
  const emitter = new EventEmitter();
  const kills: string[] = [];
  const host: SignalHost = {
    pid: 4242,
    on: (signal, listener) => emitter.on(signal, listener),
    removeListener: (signal, listener) => emitter.removeListener(signal, listener),
    listenerCount: (signal) => emitter.listenerCount(signal),
    kill: (_pid, signal) => kills.push(signal),
  };
  return { host, emitter, kills, send: (signal: "SIGTERM" | "SIGINT") => emitter.emit(signal, signal) };
}

/**
 * Connections as the database would answer: `due` in next_sync_at order. A sync that resolves
 * takes the user off the list (next_sync_at moved on), as the engine does; a failing one leaves
 * it there unless `moveOnFailure`.
 */
function harness(opts: { due?: string[]; sweepable?: string[]; moveOnFailure?: boolean } = {}) {
  const due = [...(opts.due ?? [])];
  const lines: string[] = [];
  const calls: string[] = [];
  const results = new Map<string, () => Promise<{ complete: boolean; busy?: boolean }>>();
  const signals: AbortSignal[] = [];
  const deps: SchedulerDeps = {
    nextDue: vi.fn(async (_now: Date, skip: readonly string[]) => due.find((u) => !skip.includes(u)) ?? null),
    sync: vi.fn(async (userId: string, signal: AbortSignal) => {
      calls.push(`sync ${userId}`);
      signals.push(signal);
      try {
        const result = await (results.get(userId)?.() ?? Promise.resolve({ complete: true }));
        due.splice(due.indexOf(userId), 1);
        return result;
      } catch (err) {
        if (opts.moveOnFailure) due.splice(due.indexOf(userId), 1);
        throw err;
      } finally {
        calls.push(`done ${userId}`);
      }
    }),
    sweepable: vi.fn(async () => [...(opts.sweepable ?? [])]),
    sweep: vi.fn(async (userId: string) => {
      calls.push(`sweep ${userId}`);
      return 0;
    }),
    cleanLedger: vi.fn(async () => 0),
    stopAllSyncs: vi.fn(),
    now: () => new Date(),
    log: (line: string) => {
      lines.push(line);
    },
  };
  return { deps, due, lines, calls, results, signals };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date(Date.UTC(2026, 10, 17, 9)));
});

afterEach(() => {
  resetSchedulerForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe("starting the scheduler", () => {
  it("starts a 60-second timer that does not keep the process alive, and returns without work", async () => {
    const { deps, lines } = harness();
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const { host, emitter } = fakeProcess();

    expect(startInboxScheduler({ deps, env: FIXTURE, signals: host })).toBe("started");
    expect(isSchedulerRunning()).toBe(true);
    expect(lines).toEqual([STARTED]);
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(setInterval.mock.calls[0][1]).toBe(TICK_MS);
    expect((setInterval.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(false);
    expect(emitter.listenerCount("SIGTERM")).toBe(1);
    expect(emitter.listenerCount("SIGINT")).toBe(1);
    expect(deps.nextDue).not.toHaveBeenCalled();

    await advance(TICK_MS - 1);
    expect(deps.nextDue).not.toHaveBeenCalled();
    await advance(1);
    expect(deps.nextDue).toHaveBeenCalledTimes(1);
    await advance(TICK_MS);
    expect(deps.nextDue).toHaveBeenCalledTimes(2);
  });

  it("does not start during the build", () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    const { deps } = harness();
    const { host, emitter } = fakeProcess();
    expect(startInboxScheduler({ deps, env: FIXTURE, signals: host })).toBe("build");
    expect(isSchedulerRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });

  it("does not start a second time in the same process", () => {
    const { deps } = harness();
    const { host, emitter } = fakeProcess();
    expect(startInboxScheduler({ deps, env: FIXTURE, signals: host })).toBe("started");
    expect(startInboxScheduler({ deps, env: FIXTURE, signals: host })).toBe("running");
    expect(startInboxScheduler({ deps, env: GMAIL, signals: host })).toBe("running");
    expect(startInboxScheduler({ deps, env: parseEnv({}), signals: host })).toBe("running");
    expect(vi.getTimerCount()).toBe(1);
    expect(emitter.listenerCount("SIGTERM")).toBe(1);
  });

  it("syncs with INBOX_TOKEN_KEY, or with MAIL_SOURCE=fixture", async () => {
    for (const env of [GMAIL, FIXTURE, parseEnv({ INBOX_TOKEN_KEY: KEY, INBOX_SCHEDULER: "on" })]) {
      const h = harness({ due: ["user-a"] });
      expect(startInboxScheduler({ deps: h.deps, env, signals: fakeProcess().host })).toBe("started");
      expect(h.lines).toEqual([STARTED]);
      await advance(TICK_MS);
      expect(h.calls).toEqual(["sync user-a", "done user-a", "sweep user-a"]);
      resetSchedulerForTests();
    }
  });

  // Owner, 2026-11-17: "off stops syncing only". The /privacy 90 days and the sweep hold in
  // every configuration.
  it.each([
    ["INBOX_SCHEDULER=off", parseEnv({ INBOX_TOKEN_KEY: KEY, INBOX_SCHEDULER: "off" }), "INBOX_SCHEDULER is off"],
    ["INBOX_SCHEDULER=off and fixtures", parseEnv({ MAIL_SOURCE: "fixture", INBOX_SCHEDULER: "off" }), "INBOX_SCHEDULER is off"],
    ["no INBOX_TOKEN_KEY", parseEnv({}), "Gmail is not set up"],
  ])("with %s it runs the sweep and the ledger clean-up, never a sync, and still stops on a signal", async (_, env, why) => {
    const h = harness({ due: ["user-a"], sweepable: ["user-x"] });
    const proc = fakeProcess();
    const nextShutdown = vi.fn();
    proc.emitter.on("SIGTERM", nextShutdown); // start-server.js registers before register() runs
    expect(startInboxScheduler({ deps: h.deps, env, signals: proc.host })).toBe("maintenance_only");
    expect(isSchedulerRunning()).toBe(true);
    expect(h.lines).toEqual([maintenanceOnly(why)]);
    expect(vi.getTimerCount()).toBe(1);

    await advance(TICK_MS);
    expect(h.deps.nextDue).not.toHaveBeenCalled();
    expect(h.deps.sync).not.toHaveBeenCalled();
    expect(h.calls).toEqual(["sweep user-x"]);
    expect(h.deps.cleanLedger).toHaveBeenCalledTimes(1);
    // Six hours on: swept and cleaned again, still no sync.
    await advance(SWEEP_EVERY_MS);
    expect(h.calls).toEqual(["sweep user-x", "sweep user-x"]);
    expect(h.deps.cleanLedger).toHaveBeenCalledTimes(2);
    expect(h.deps.sync).not.toHaveBeenCalled();

    // The stop is the same: manual runs stop between messages, the timer goes, Next.js exits.
    proc.send("SIGTERM");
    expect(nextShutdown).toHaveBeenCalledTimes(1);
    expect(h.deps.stopAllSyncs).toHaveBeenCalledTimes(1);
    expect(isSchedulerRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(proc.kills).toEqual([]);
    expect(h.lines.at(-1)).toBe("inbox: scheduler stopped (SIGTERM)");
    await advance(SWEEP_EVERY_MS);
    expect(h.calls).toHaveLength(2);
  });

  it("alone (no Next.js listener) in maintenance only, it still raises the signal again", () => {
    const h = harness();
    const proc = fakeProcess();
    startInboxScheduler({ deps: h.deps, env: parseEnv({}), signals: proc.host });
    proc.send("SIGINT");
    expect(h.deps.stopAllSyncs).toHaveBeenCalledTimes(1);
    expect(proc.kills).toEqual(["SIGINT"]);
    expect(proc.emitter.listenerCount("SIGINT")).toBe(0);
  });

  describe("register() in src/instrumentation.ts", () => {
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "info").mockImplementation(() => {});
      // Invented; nothing connects before the first tick.
      vi.stubEnv("DATABASE_URL", "postgresql://app:pw-1234@localhost:5432/job_tracker");
      vi.stubEnv("MAIL_SOURCE", "fixture");
      vi.stubEnv("INBOX_SCHEDULER", "");
      vi.stubEnv("INBOX_TOKEN_KEY", "");
      vi.stubEnv("INBOX_TOKEN_KEY_PREVIOUS", "");
      vi.stubEnv("NEXT_PHASE", "");
      resetEnvForTests();
    });

    it("starts it once on the Node runtime, after the environment check", async () => {
      vi.stubEnv("NEXT_RUNTIME", "nodejs");
      const { register } = await import("@/instrumentation");
      await register();
      expect(isSchedulerRunning()).toBe(true);
      await register();
      expect(vi.getTimerCount()).toBe(1);
      expect(console.info).toHaveBeenCalledWith(STARTED);
    });

    it("stops the start on a malformed inbox variable, naming the variable but not the value", async () => {
      vi.stubEnv("NEXT_RUNTIME", "nodejs");
      const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as typeof process.exit);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { register } = await import("@/instrumentation");
      const cases = [
        ["INBOX_TOKEN_KEY", "zz-not-a-key-zz"],
        ["INBOX_TOKEN_KEY_PREVIOUS", "zz-not-a-key-zz"],
        ["MAIL_SOURCE", "zz-imap-zz"],
        ["INBOX_SCHEDULER", "zz-yes-zz"],
        ["INBOX_BACKFILL_DAYS", "0"],
      ] as const;
      for (const [name, value] of cases) {
        vi.stubEnv("INBOX_TOKEN_KEY", KEY);
        vi.stubEnv(name, value);
        resetEnvForTests();
        exit.mockClear();
        error.mockClear();

        await expect(register()).rejects.toThrow("exit 1");
        expect(exit).toHaveBeenCalledWith(1);
        expect(error).toHaveBeenCalledTimes(1);
        const message = String(error.mock.calls[0][0]);
        expect(message).toContain(name);
        if (value !== "0") expect(message).not.toContain(value);
        expect(isSchedulerRunning()).toBe(false);
        vi.stubEnv(name, "");
      }
      expect(vi.getTimerCount()).toBe(0);
    });

    it("starts the app without INBOX_TOKEN_KEY or with INBOX_SCHEDULER=off, with the maintenance only", async () => {
      vi.stubEnv("NEXT_RUNTIME", "nodejs");
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as typeof process.exit);
      const { register } = await import("@/instrumentation");
      for (const [name, value, why] of [
        ["MAIL_SOURCE", "", "Gmail is not set up"],
        ["INBOX_SCHEDULER", "off", "INBOX_SCHEDULER is off"],
      ] as const) {
        vi.stubEnv(name, value);
        resetEnvForTests();
        await register();
        expect(exit).not.toHaveBeenCalled();
        expect(isSchedulerRunning()).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        expect(console.info).toHaveBeenLastCalledWith(maintenanceOnly(why));
        resetSchedulerForTests();
      }
    });

    it("does not start it during the build or on the edge runtime", async () => {
      const { register } = await import("@/instrumentation");
      vi.stubEnv("NEXT_RUNTIME", "nodejs");
      vi.stubEnv("NEXT_PHASE", "phase-production-build");
      await register();
      expect(isSchedulerRunning()).toBe(false);
      vi.stubEnv("NEXT_PHASE", "");
      vi.stubEnv("NEXT_RUNTIME", "edge");
      await register();
      expect(isSchedulerRunning()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("a tick", () => {
  it("runs the due connections oldest first, one after another, each followed by a sweep", async () => {
    const h = harness({ due: ["user-a", "user-b", "user-c"] });
    const first = deferred<{ complete: boolean }>();
    h.results.set("user-a", () => first.promise);
    startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: fakeProcess().host });

    await advance(TICK_MS);
    expect(h.calls).toEqual(["sync user-a"]);
    first.resolve({ complete: true });
    await advance(0);
    expect(h.calls).toEqual([
      "sync user-a",
      "done user-a",
      "sweep user-a",
      "sync user-b",
      "done user-b",
      "sweep user-b",
      "sync user-c",
      "done user-c",
      "sweep user-c",
    ]);
    expect(h.lines.at(-1)).toBe("inbox: scheduler: synced 3");
  });

  it("never overlaps the previous one", async () => {
    const h = harness({ due: ["user-a"] });
    const slow = deferred<{ complete: boolean }>();
    h.results.set("user-a", () => slow.promise);
    startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: fakeProcess().host });

    await advance(TICK_MS);
    await advance(TICK_MS);
    await advance(TICK_MS);
    expect(h.deps.nextDue).toHaveBeenCalledTimes(1);
    expect(h.deps.sync).toHaveBeenCalledTimes(1);

    h.due.push("user-b");
    slow.resolve({ complete: true });
    await advance(0);
    // The same tick goes on with the user that became due meanwhile.
    expect(h.calls).toEqual(["sync user-a", "done user-a", "sweep user-a", "sync user-b", "done user-b", "sweep user-b"]);
    expect(h.deps.nextDue).toHaveBeenCalledTimes(3);
    await advance(TICK_MS);
    expect(h.deps.nextDue).toHaveBeenCalledTimes(4);
  });

  it("goes on after a user's failure, logs codes only, and tries that user again on the next tick", async () => {
    const h = harness({ due: ["user-a", "user-b", "user-c"] });
    h.results.set("user-a", () => Promise.reject(inboxError("google_unavailable")));
    h.results.set("user-b", () => Promise.reject(new Error("text that must not reach the log")));
    startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: fakeProcess().host });

    await advance(TICK_MS);
    expect(h.calls).toEqual(["sync user-a", "done user-a", "sync user-b", "done user-b", "sync user-c", "done user-c", "sweep user-c"]);
    expect(h.deps.nextDue).toHaveBeenLastCalledWith(expect.any(Date), ["user-a", "user-b", "user-c"]);
    expect(h.lines.at(-1)).toBe("inbox: scheduler: synced 1, failed 2 (google_unavailable, Error)");

    // Still due (nothing moved next_sync_at): tried once per tick, not in a loop.
    h.calls.length = 0;
    h.results.set("user-b", () => Promise.reject(inboxError("google_unavailable")));
    await advance(TICK_MS);
    expect(h.calls).toEqual(["sync user-a", "done user-a", "sync user-b", "done user-b"]);
    expect(h.lines.at(-1)).toBe("inbox: scheduler: failed 2 (google_unavailable x2)");
  });

  it("asks for due connections at the tick's time, so the engine's back-off decides when a user runs again", async () => {
    // As repo.ts writes it: a failure pushes next_sync_at back (2 × 15 minutes here).
    let nextAt = Date.now() + TICK_MS;
    const h = harness();
    h.deps.nextDue = vi.fn(async (now: Date, skip: readonly string[]) =>
      now.getTime() >= nextAt && !skip.includes("user-a") ? "user-a" : null,
    );
    h.deps.sync = vi.fn(async () => {
      nextAt = Date.now() + 30 * 60_000;
      throw inboxError("google_unavailable");
    });
    startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: fakeProcess().host });

    await advance(TICK_MS);
    expect(h.deps.sync).toHaveBeenCalledTimes(1);
    await advance(29 * TICK_MS);
    expect(h.deps.sync).toHaveBeenCalledTimes(1);
    await advance(TICK_MS);
    expect(h.deps.sync).toHaveBeenCalledTimes(2);
  });

  it("sweeps after a complete sync only; a busy or incomplete run is logged as such", async () => {
    const h = harness({ due: ["user-a", "user-b", "user-c", "user-d"] });
    h.results.set("user-b", async () => ({ complete: false }));
    h.results.set("user-c", async () => ({ complete: false, busy: true }));
    h.results.set("user-d", () => Promise.reject(inboxError("stopped")));
    startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: fakeProcess().host });

    await advance(TICK_MS);
    expect(h.deps.sweep).toHaveBeenCalledTimes(1);
    expect(h.deps.sweep).toHaveBeenCalledWith("user-a", expect.any(Date));
    expect(h.lines.at(-1)).toBe("inbox: scheduler: synced 2 (1 not complete), busy 1 (lease held elsewhere), failed 1 (stopped)");
  });

  it("sweeps every user the gate lets through at least every 6 hours, and at once in a new process", async () => {
    const h = harness({ sweepable: ["user-a", "user-x"] });
    let marked = 2;
    h.deps.sweep = vi.fn(async () => {
      const n = marked;
      marked = 0;
      return n;
    });
    const start = () => startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: fakeProcess().host });
    start();

    await advance(TICK_MS);
    expect(vi.mocked(h.deps.sweep).mock.calls.map(([u]) => u)).toEqual(["user-a", "user-x"]);
    expect(h.lines.at(-1)).toBe("inbox: scheduler: marked 2 no response");
    const linesAfterFirst = h.lines.length;

    // A complete sync of user-a two hours later sweeps it and restarts its 6 hours.
    await advance(2 * HOUR - TICK_MS);
    h.due.push("user-a");
    await advance(TICK_MS);
    expect(vi.mocked(h.deps.sweep).mock.calls.map(([u]) => u)).toEqual(["user-a", "user-x", "user-a"]);

    // Six hours after the first sweep: user-x again, user-a not yet.
    await advance(SWEEP_EVERY_MS - 2 * HOUR);
    expect(vi.mocked(h.deps.sweep).mock.calls.map(([u]) => u)).toEqual(["user-a", "user-x", "user-a", "user-x"]);
    await advance(2 * HOUR);
    expect(vi.mocked(h.deps.sweep).mock.calls.map(([u]) => u)).toEqual(["user-a", "user-x", "user-a", "user-x", "user-a"]);
    // Sweeps that marked nothing and no runs: no log lines, apart from the one sync.
    expect(h.lines.slice(linesAfterFirst)).toEqual(["inbox: scheduler: synced 1"]);

    // A new process remembers nothing: its first tick sweeps everyone the gate lets through.
    resetSchedulerForTests();
    vi.mocked(h.deps.sweep).mockClear();
    start();
    await advance(TICK_MS);
    expect(vi.mocked(h.deps.sweep).mock.calls.map(([u]) => u)).toEqual(["user-a", "user-x"]);
    expect(h.deps.sweepable).toHaveBeenLastCalledWith(new Date(Date.now()));
  });

  it("logs a failed sweep and tries it again on the next tick", async () => {
    const h = harness({ sweepable: ["user-a"] });
    h.deps.sweep = vi.fn().mockRejectedValueOnce(Object.assign(new Error("deadlock"), { code: "40P01" })).mockResolvedValue(1);
    startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: fakeProcess().host });

    await advance(TICK_MS);
    expect(h.lines.at(-1)).toBe("inbox: scheduler: sweep failed 1 (40P01)");
    await advance(TICK_MS);
    expect(h.deps.sweep).toHaveBeenCalledTimes(2);
    expect(h.lines.at(-1)).toBe("inbox: scheduler: marked 1 no response");
    await advance(TICK_MS);
    expect(h.deps.sweep).toHaveBeenCalledTimes(2);
  });

  it("logs a failed query as a code and keeps ticking", async () => {
    const h = harness({ due: ["user-a"] });
    h.deps.nextDue = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))
      .mockResolvedValue(null);
    startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: fakeProcess().host });

    await advance(TICK_MS);
    expect(h.lines.at(-1)).toBe("inbox: scheduler: tick failed (ECONNREFUSED)");
    await advance(TICK_MS);
    expect(h.deps.nextDue).toHaveBeenCalledTimes(2);
    expect(h.lines).toHaveLength(2);
  });

  it("cleans the ledger of every user on a new process's first tick, then every 6 hours", async () => {
    const h = harness();
    const deleted = [3, 0, 2];
    h.deps.cleanLedger = vi.fn(async () => deleted.shift() ?? 0);
    const start = () => startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: fakeProcess().host });
    start();

    await advance(TICK_MS);
    expect(h.deps.cleanLedger).toHaveBeenCalledTimes(1);
    expect(h.deps.cleanLedger).toHaveBeenLastCalledWith(new Date(Date.now()));
    expect(h.lines.at(-1)).toBe("inbox: scheduler: deleted 3 old ledger rows");

    // Six hours after the first one, not a tick sooner.
    await advance(LEDGER_CLEANUP_EVERY_MS - TICK_MS);
    expect(h.deps.cleanLedger).toHaveBeenCalledTimes(1);
    await advance(TICK_MS);
    expect(h.deps.cleanLedger).toHaveBeenCalledTimes(2);
    // Nothing deleted: no line.
    expect(h.lines).toHaveLength(2);

    // A new process cleans on its first tick.
    resetSchedulerForTests();
    start();
    await advance(TICK_MS);
    expect(h.deps.cleanLedger).toHaveBeenCalledTimes(3);
    expect(h.lines.at(-1)).toBe("inbox: scheduler: deleted 2 old ledger rows");
  });

  it("runs the clean-up when the due query fails, and tries a failed clean-up again on the next tick", async () => {
    const h = harness();
    h.deps.nextDue = vi.fn().mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })).mockResolvedValue(null);
    h.deps.cleanLedger = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("deadlock"), { code: "40P01" }))
      .mockResolvedValue(1);
    const warnings: string[] = [];
    h.deps.log = (line, level) => void (level === "warn" ? warnings : h.lines).push(line);
    startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: fakeProcess().host });

    await advance(TICK_MS);
    expect(warnings).toEqual(["inbox: scheduler: ledger clean-up failed (40P01), tick failed (ECONNREFUSED)"]);
    await advance(TICK_MS);
    expect(h.deps.cleanLedger).toHaveBeenCalledTimes(2);
    expect(h.lines.at(-1)).toBe("inbox: scheduler: deleted 1 old ledger rows");
    await advance(TICK_MS);
    expect(h.deps.cleanLedger).toHaveBeenCalledTimes(2);
  });

  it("writes no log line when there was nothing to do", async () => {
    const h = harness({ sweepable: ["user-a"] });
    startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: fakeProcess().host });
    await advance(5 * TICK_MS);
    expect(h.deps.nextDue).toHaveBeenCalledTimes(5);
    expect(h.lines).toEqual([STARTED]);
  });
});

describe("stopping", () => {
  it("clears the timer, stops every sync, and ends the tick after the user it is on", async () => {
    const h = harness({ due: ["user-a", "user-b"], sweepable: ["user-x"] });
    const running = deferred<{ complete: boolean }>();
    h.results.set("user-a", () => running.promise);
    startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: fakeProcess().host });
    await advance(TICK_MS);
    expect(h.signals[0].aborted).toBe(false);

    stopInboxScheduler("test");
    expect(isSchedulerRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.signals[0].aborted).toBe(true);
    expect(h.deps.stopAllSyncs).toHaveBeenCalledTimes(1);
    expect(h.lines).toContain("inbox: scheduler stopped (test), during a tick");

    running.reject(inboxError("stopped"));
    await advance(10 * TICK_MS);
    expect(h.calls).toEqual(["sync user-a", "done user-a"]);
    expect(h.deps.sweep).not.toHaveBeenCalled();
    expect(h.deps.sweepable).not.toHaveBeenCalled();
    expect(h.deps.cleanLedger).not.toHaveBeenCalled();
    expect(h.lines.at(-1)).toBe("inbox: scheduler: failed 1 (stopped)");

    // A stopped scheduler still counts as running for register(): no second one.
    expect(startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: fakeProcess().host })).toBe("running");
    stopInboxScheduler("again");
    expect(h.deps.stopAllSyncs).toHaveBeenCalledTimes(1);
  });

  it.each(["SIGTERM", "SIGINT"] as const)("%s stops it beside Next's own listener, which still runs", (signal) => {
    const h = harness();
    const proc = fakeProcess();
    const nextShutdown = vi.fn();
    proc.emitter.on(signal, nextShutdown); // start-server.js registers before register() runs
    startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: proc.host });

    proc.send(signal);
    expect(nextShutdown).toHaveBeenCalledTimes(1);
    expect(h.deps.stopAllSyncs).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.lines.at(-1)).toBe(`inbox: scheduler stopped (${signal})`);
    expect(proc.kills).toEqual([]);

    // Ctrl+C in a shell can deliver the signal twice: nothing happens twice.
    proc.send(signal);
    expect(h.deps.stopAllSyncs).toHaveBeenCalledTimes(1);
  });

  it("alone (no Next.js listener), it unsubscribes and raises the signal again instead of swallowing it", () => {
    const h = harness();
    const proc = fakeProcess();
    startInboxScheduler({ deps: h.deps, env: FIXTURE, signals: proc.host });

    proc.send("SIGTERM");
    expect(h.deps.stopAllSyncs).toHaveBeenCalledTimes(1);
    expect(proc.kills).toEqual(["SIGTERM"]);
    expect(proc.emitter.listenerCount("SIGTERM")).toBe(0);
    expect(proc.emitter.listenerCount("SIGINT")).toBe(0);
  });
});
