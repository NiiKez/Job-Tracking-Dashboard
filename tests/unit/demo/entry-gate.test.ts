import { afterEach, describe, expect, it } from "vitest";
import { createEntryGate, ENTRY_LIMITS, resetEntryGateForTests, runEntry } from "@/lib/server/demo/entry-gate";

// The limit on creating demo workspaces (src/lib/server/demo/entry-gate.ts): one at a time, at
// most 10 waiting, at most 30 per minute. The clock is injected; no timers are faked.

/** A promise to settle by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createEntryGate", () => {
  afterEach(() => resetEntryGateForTests());

  it("defaults to the plan's limits: 10 waiting, 30 a minute", () => {
    expect(ENTRY_LIMITS).toEqual({ waiting: 10, perMinute: 30 });
  });

  it("runs one at a time, first come first served, and passes the result on", async () => {
    const gate = createEntryGate({ now: () => 0 });
    const started: number[] = [];
    const finish = [deferred(), deferred(), deferred()];
    const runs = finish.map((d, i) =>
      gate.run(async () => {
        started.push(i);
        await d.promise;
        return `result ${i}`;
      }),
    );
    await settle();
    expect(started).toEqual([0]);
    expect(gate.pending).toBe(3);

    // Finishing out of order changes nothing: the second waits for the first.
    finish[2].resolve();
    finish[1].resolve();
    await settle();
    expect(started).toEqual([0]);

    finish[0].resolve();
    expect(await Promise.all(runs)).toEqual(["result 0", "result 1", "result 2"]);
    expect(started).toEqual([0, 1, 2]);
    expect(gate.pending).toBe(0);
  });

  it("refuses at once, without running, when 10 already wait behind the one running", async () => {
    const gate = createEntryGate({ now: () => 0 });
    const block = deferred();
    let ran = 0;
    const work = async () => {
      ran++;
      await block.promise;
    };
    const admitted = Array.from({ length: 1 + ENTRY_LIMITS.waiting }, () => gate.run(work));
    await settle();
    expect(gate.pending).toBe(11);

    let refusedRan = false;
    expect(
      await gate.run(async () => {
        refusedRan = true;
      }),
    ).toBe("busy");
    expect(refusedRan).toBe(false);

    block.resolve();
    expect(await Promise.all(admitted)).toEqual(Array(11).fill(undefined));
    expect(ran).toBe(11);
    // The queue is empty again.
    expect(await gate.run(async () => "again")).toBe("again");
  });

  it("lets 30 in per minute in total, a sliding window", async () => {
    let now = 0;
    const gate = createEntryGate({ now: () => now });
    for (let i = 0; i < ENTRY_LIMITS.perMinute; i++) {
      now = i * 1_000; // one a second
      expect(await gate.run(async () => i)).toBe(i);
    }
    now = 59_999;
    expect(await gate.run(async () => "late")).toBe("busy");
    now = 60_000; // the first one has left the window
    expect(await gate.run(async () => "freed")).toBe("freed");
    expect(await gate.run(async () => "one more")).toBe("busy");
    now = 61_000; // and the second
    expect(await gate.run(async () => "freed again")).toBe("freed again");
  });

  it("does not count requests refused for a full queue against the minute", async () => {
    const gate = createEntryGate({ maxWaiting: 1, perMinute: 3, now: () => 0 });
    const block = deferred();
    const first = gate.run(() => block.promise);
    const second = gate.run(async () => "second");
    for (let i = 0; i < 5; i++) expect(await gate.run(async () => "refused")).toBe("busy");
    block.resolve();
    await Promise.all([first, second]);
    // Two of three used; the refusals took none.
    expect(await gate.run(async () => "third")).toBe("third");
    expect(await gate.run(async () => "fourth")).toBe("busy");
  });

  it("passes an error on and runs the next one", async () => {
    const gate = createEntryGate({ now: () => 0 });
    const block = deferred();
    const failing = gate.run(async () => {
      await block.promise;
      throw new Error("creation failed");
    });
    const next = gate.run(async () => "next");
    block.resolve();
    await expect(failing).rejects.toThrow("creation failed");
    expect(await next).toBe("next");
    expect(gate.pending).toBe(0);
  });

  it("frees the turn after a function that throws before it awaits", async () => {
    const gate = createEntryGate({ now: () => 0 });
    await expect(
      gate.run(() => {
        throw new Error("at once");
      }),
    ).rejects.toThrow("at once");
    expect(await gate.run(async () => "after")).toBe("after");
  });
});

describe("runEntry", () => {
  afterEach(() => resetEntryGateForTests());

  it("is one gate for the process: a second entry waits for the first", async () => {
    const block = deferred();
    const order: string[] = [];
    const first = runEntry(async () => {
      order.push("first");
      await block.promise;
      order.push("first done");
    });
    const second = runEntry(async () => {
      order.push("second");
    });
    await settle();
    expect(order).toEqual(["first"]);
    block.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "first done", "second"]);
  });

  it("counts every entry against the minute until reset", async () => {
    for (let i = 0; i < ENTRY_LIMITS.perMinute; i++) await runEntry(async () => i);
    expect(await runEntry(async () => "over")).toBe("busy");
    resetEntryGateForTests();
    expect(await runEntry(async () => "fresh")).toBe("fresh");
  });
});
