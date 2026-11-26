import { describe, expect, it } from "vitest";
import { buildSeed } from "@/lib/server/demo/fixtures";
import { compareInStage, groupByStage, STAGES, stageOf } from "@/lib/stages";
import { PRIORITIES, type Priority } from "@/lib/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Every time of the seed that has already happened: emails, job creations, status changes. */
function pastTimes(now: number): number[] {
  const { jobs, emails } = buildSeed(now);
  return [
    ...emails.map((e) => e.receivedAt),
    ...jobs.flatMap((j) => [j.createdAt, ...j.history.map((h) => h.at)]),
  ].map((t) => Date.parse(t));
}

describe("buildSeed's dates", () => {
  // Today's items sit at fixed clock times up to 10:00 (local), so a workspace made early in
  // the day would otherwise show mail and changes from later today.
  const start = new Date(2026, 10, 19, 0, 0).getTime();
  const times = Array.from({ length: 48 }, (_, i) => start + i * (HOUR / 2));

  it.each(times.map((t) => [new Date(t).toISOString(), t]))("never dates what happened in the future (%s)", (_, now) => {
    expect(Math.max(...pastTimes(now))).toBeLessThanOrEqual(now);
  });

  it("moves the past back by one whole day at most, and only early in the day", () => {
    const noon = new Date(2026, 10, 19, 12, 0).getTime();
    const early = new Date(2026, 10, 19, 6, 0).getTime();
    // At noon nothing moves: the newest item is from this morning.
    expect(noon - Math.max(...pastTimes(noon))).toBeLessThan(DAY);
    // At 06:00 the whole past is yesterday's (the clock times hang on the date only): the gaps
    // between items stay as they are.
    expect(pastTimes(early)).toEqual(pastTimes(noon - DAY));
    expect(pastTimes(early)).not.toEqual(pastTimes(noon));
  });

  it("keeps what is still to come in the future", () => {
    for (const now of times) {
      const upcoming = buildSeed(now).jobs.flatMap((j) => [j.nextInterview?.at, j.offerDeadline]);
      for (const t of upcoming) if (t) expect(Date.parse(t)).toBeGreaterThan(now);
    }
  });
});

describe("buildSeed's priorities", () => {
  const now = new Date(2026, 10, 19, 12, 0).getTime();
  const { jobs } = buildSeed(now);

  it("uses all three priorities, mostly medium", () => {
    const count = (p: Priority) => jobs.filter((j) => j.priority === p).length;
    for (const p of PRIORITIES) expect(count(p), p).toBeGreaterThan(0);
    expect(count("medium")).toBeGreaterThan(count("high"));
    expect(count("medium")).toBeGreaterThan(count("low"));
  });

  it("has a high-priority job in Saved, Applied and Interview", () => {
    for (const stage of ["saved", "applied", "interview"] as const) {
      expect(jobs.some((j) => stageOf(j.status) === stage && j.priority === "high"), stage).toBe(true);
    }
  });

  it("shows the priority sort: in some stage a high job comes before one the default order puts first", () => {
    const columns = groupByStage(jobs);
    const moved = STAGES.some((stage) => {
      const byDefault = [...columns[stage]].sort(compareInStage);
      return columns[stage][0]?.priority === "high" && byDefault[0] !== columns[stage][0];
    });
    expect(moved).toBe(true);
  });
});
