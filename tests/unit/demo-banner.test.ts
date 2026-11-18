import { describe, expect, it } from "vitest";
import { deletionTime } from "@/components/app-shell/demo-banner";

// src/components/app-shell/demo-banner.tsx: when the public demo's workspace is deleted, as the
// banner says it inside a sentence. The banner shows the browser's local time, so the dates here
// are built in local time too (new Date(y, m, d, h, min)) and the test holds in any time zone.

const NOW = new Date(2026, 10, 18, 22, 15);
const iso = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();

describe("the demo banner's deletion time", () => {
  it("says today or tomorrow, with the time", () => {
    expect(deletionTime(iso(2026, 10, 18, 23, 59), NOW)).toBe("today at 23:59");
    expect(deletionTime(iso(2026, 10, 19, 22, 15), NOW)).toBe("tomorrow at 22:15");
    expect(deletionTime(iso(2026, 10, 19, 0, 5), NOW)).toBe("tomorrow at 00:05");
  });

  it("names the day and date further out, with the year only when it isn't this year", () => {
    expect(deletionTime(iso(2026, 10, 20, 9, 0), NOW)).toBe("Fri 20 Nov at 09:00");
    expect(deletionTime(iso(2027, 0, 2, 9, 0), new Date(2026, 11, 31, 12, 0))).toBe("Sat 2 Jan 2027 at 09:00");
  });

  it("says today for a time that has just passed (a slow clock): the next request signs out", () => {
    expect(deletionTime(iso(2026, 10, 18, 22, 0), NOW)).toBe("today at 22:00");
  });
});
