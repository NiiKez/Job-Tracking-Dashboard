import { describe, expect, it } from "vitest";
import { FETCHES_PER_WINDOW, WINDOW_MS, createRateLimiter } from "@/lib/server/parse/rate-limit";

describe("createRateLimiter", () => {
  it("defaults to 10 fetches a minute", () => {
    expect([FETCHES_PER_WINDOW, WINDOW_MS]).toEqual([10, 60_000]);
  });

  it("allows the limit within the window, then refuses", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 1_000, now: () => now });
    expect([1, 2, 3, 4].map(() => limiter.take("user-1"))).toEqual([true, true, true, false]);
    now = 999;
    expect(limiter.take("user-1")).toBe(false);
  });

  it("slides: each fetch frees its slot one window later", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => now });
    limiter.take("u");
    now = 500;
    limiter.take("u");
    now = 1_000; // the first one has left the window
    expect(limiter.take("u")).toBe(true);
    expect(limiter.take("u")).toBe(false);
    now = 1_500; // the second one has left
    expect(limiter.take("u")).toBe(true);
  });

  it("counts each key on its own, and refusals do not count", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => 0 });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true);
  });

  it("stays bounded with many keys", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => now });
    for (let i = 0; i < 5_000; i++) limiter.take(`user-${i}`);
    now = 10;
    // The most recent key is kept, so it is still limited.
    expect(limiter.take("user-4999")).toBe(false);
  });
});
