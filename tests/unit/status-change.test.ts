import { describe, expect, it } from "vitest";
import { lockAfterManualChange, manualStatusChange } from "@/lib/domain/status-change";
import { STATUSES } from "@/lib/types";

// The rules behind the "Moved to … / Undo" toast. useUpdateJob's optimistic update and updateJob
// on the server both apply lockAfterManualChange to the patch, so the round trip below is what
// the screen shows and what the database stores (pinned on the database in
// tests/db/services/status-undo.test.ts).

const PAIRS = STATUSES.flatMap((from) => STATUSES.filter((to) => to !== from).map((to) => [from, to] as const));

describe("manualStatusChange", () => {
  it("is null when the status would not change", () => {
    for (const status of STATUSES) {
      expect(manualStatusChange({ status, statusLocked: false }, status)).toBeNull();
      expect(manualStatusChange({ status, statusLocked: true }, status)).toBeNull();
    }
  });

  it("sends the status alone, so the server applies the lock rule", () => {
    expect(manualStatusChange({ status: "applied", statusLocked: false }, "interview")?.patch).toEqual({
      status: "interview",
    });
    expect(manualStatusChange({ status: "interview", statusLocked: true }, "rejected")?.patch).toEqual({
      status: "rejected",
    });
  });

  it("undoes with the status and the lock the job had before", () => {
    expect(manualStatusChange({ status: "applied", statusLocked: false }, "interview")?.undo).toEqual({
      status: "applied",
      statusLocked: false,
    });
    expect(manualStatusChange({ status: "interview", statusLocked: true }, "rejected")?.undo).toEqual({
      status: "interview",
      statusLocked: true,
    });
  });

  it("brings back the status and lock after any change and its Undo", () => {
    for (const [from, to] of PAIRS) {
      for (const locked of [false, true]) {
        const change = manualStatusChange({ status: from, statusLocked: locked }, to)!;
        const afterChange = lockAfterManualChange(from, change.patch.status, change.patch.statusLocked);
        expect(afterChange, `${from} -> ${to}`).toBe(!(from === "saved" && to === "applied"));
        expect(change.undo.status).toBe(from);
        expect(lockAfterManualChange(to, change.undo.status, change.undo.statusLocked), `undo ${from} -> ${to}`).toBe(locked);
      }
    }
  });
});

describe("lockAfterManualChange", () => {
  it("locks every manual change except saved -> applied", () => {
    for (const [from, to] of PAIRS) {
      expect(lockAfterManualChange(from, to), `${from} -> ${to}`).toBe(!(from === "saved" && to === "applied"));
    }
    expect(lockAfterManualChange("saved", "applied")).toBe(false);
    expect(lockAfterManualChange("applied", "saved")).toBe(true);
  });

  it("lets an explicit statusLocked win, and only a boolean", () => {
    expect(lockAfterManualChange("applied", "rejected", false)).toBe(false);
    expect(lockAfterManualChange("saved", "applied", true)).toBe(true);
    expect(lockAfterManualChange("applied", "rejected", undefined)).toBe(true);
    expect(lockAfterManualChange("saved", "applied", null)).toBe(false);
  });
});
