import { describe, expect, it } from "vitest";
import { comparePriority, compareInStage, groupByStage, PRIORITY_RANK } from "@/lib/stages";
import type { Job, Priority, Status } from "@/lib/types";

// Order inside a dashboard stage: priority first (High, Medium, Low), then the stage's own order
// or the list's chosen sort among jobs of the same priority.

const at = (day: number) => new Date(Date.UTC(2026, 10, day, 12)).toISOString();

function job(id: string, status: Status, priority: Priority, day: number): Job {
  return {
    id,
    title: `Role ${id}`,
    company: "Parcelwerk",
    location: "",
    url: null,
    description: "",
    status,
    priority,
    statusSource: "manual",
    statusLocked: false,
    captureMethod: "paste",
    createdAt: at(day),
    appliedAt: status === "saved" ? null : at(day),
    updatedAt: at(day),
    lastActivityAt: at(day),
    history: [{ id: `${id}_ev0`, from: null, to: status, at: at(day), source: "paste" }],
    emailCount: 0,
    nextInterview: null,
    offerDeadline: null,
  };
}

const ids = (jobs: Job[]) => jobs.map((j) => j.id);

describe("comparePriority", () => {
  it("ranks High before Medium before Low, and equal priorities as a tie", () => {
    expect(PRIORITY_RANK).toEqual({ high: 0, medium: 1, low: 2 });
    expect(comparePriority({ priority: "high" }, { priority: "medium" })).toBeLessThan(0);
    expect(comparePriority({ priority: "medium" }, { priority: "low" })).toBeLessThan(0);
    expect(comparePriority({ priority: "low" }, { priority: "high" })).toBeGreaterThan(0);
    for (const p of ["high", "medium", "low"] as const) expect(comparePriority({ priority: p }, { priority: p })).toBe(0);
  });
});

describe("groupByStage", () => {
  it("puts higher priority first in every stage, whatever the stage's own order says", () => {
    // Saved is newest first and Applied longest-waiting first: each priority sits where its
    // date alone would put it last.
    const jobs = [
      job("saved-high", "saved", "high", 1),
      job("saved-medium", "saved", "medium", 2),
      job("saved-low", "saved", "low", 3),
      job("applied-low", "applied", "low", 1),
      job("applied-medium", "applied", "medium", 2),
      job("applied-high", "applied", "high", 3),
      job("rejected-low", "rejected", "low", 9),
      job("no-response-high", "no_response", "high", 1),
    ];
    const stages = groupByStage(jobs);
    expect(ids(stages.saved)).toEqual(["saved-high", "saved-medium", "saved-low"]);
    expect(ids(stages.applied)).toEqual(["applied-high", "applied-medium", "applied-low"]);
    expect(ids(stages.closed)).toEqual(["no-response-high", "rejected-low"]);
    expect(stages.interview).toEqual([]);
    expect(stages.offer).toEqual([]);
  });

  it("orders jobs of the same priority by the stage's own order", () => {
    const jobs = [
      job("saved-medium-old", "saved", "medium", 1),
      job("saved-low", "saved", "low", 9),
      job("saved-medium-new", "saved", "medium", 5),
      job("saved-high-old", "saved", "high", 2),
      job("saved-high-new", "saved", "high", 4),
      job("applied-medium-new", "applied", "medium", 8),
      job("applied-medium-old", "applied", "medium", 3),
    ];
    const stages = groupByStage(jobs);
    // Saved: newest first inside each priority.
    expect(ids(stages.saved)).toEqual(["saved-high-new", "saved-high-old", "saved-medium-new", "saved-medium-old", "saved-low"]);
    // Applied: longest waiting first.
    expect(ids(stages.applied)).toEqual(["applied-medium-old", "applied-medium-new"]);
    expect(ids(stages.saved)).toEqual(ids([...stages.saved].sort((a, b) => comparePriority(a, b) || compareInStage(a, b))));
  });

  it("applies a chosen sort only among jobs of the same priority", () => {
    const jobs = [
      job("c-low", "applied", "low", 1),
      job("b-high", "applied", "high", 2),
      job("a-medium", "applied", "medium", 3),
      job("d-high", "applied", "high", 4),
      job("a-low", "applied", "low", 5),
    ];
    const byId = (a: Job, b: Job) => a.id.localeCompare(b.id);
    expect(ids(groupByStage(jobs, byId).applied)).toEqual(["b-high", "d-high", "a-medium", "a-low", "c-low"]);
    const byIdDesc = (a: Job, b: Job) => b.id.localeCompare(a.id);
    expect(ids(groupByStage(jobs, byIdDesc).applied)).toEqual(["d-high", "b-high", "a-medium", "c-low", "a-low"]);
  });

  it("leaves the input array as it was", () => {
    const jobs = [job("one", "saved", "low", 1), job("two", "saved", "high", 2)];
    groupByStage(jobs);
    expect(ids(jobs)).toEqual(["one", "two"]);
  });
});
