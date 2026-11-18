import type { Job, Status } from "@/lib/types";

/**
 * Manual status changes (the status menu, the board, "Mark as applied") and their Undo. Shared
 * by useChangeStatus (the patches), useUpdateJob's optimistic update and updateJob on the
 * server (the lock rule), so the screen shows the lock the server is about to store.
 *
 * A manual change locks the job against email (Job.statusLocked), except saved -> applied, the
 * normal "Mark as applied" flow; an explicit statusLocked in the patch wins over that rule.
 * Undo is itself a manual change, so on its own it would lock the job: an accidental drag plus
 * Undo would leave later interview or rejection emails unable to move it. The Undo patch
 * therefore carries the lock the job had before the change, as well as its status.
 */

/** The part of a job patch a status change sends. */
export interface StatusPatch {
  status: Status;
  statusLocked?: boolean;
}

/** A manual status change as the client sends it, and the patch that undoes it. */
export interface ManualStatusChange {
  patch: StatusPatch;
  undo: StatusPatch;
}

/**
 * The patches for moving `job` to `to` by hand; null when `to` is its status already. The
 * change sends the status alone, so the server applies the lock rule; `job.statusLocked` must
 * be the job's real lock, not a default, since Undo restores it.
 */
export function manualStatusChange(job: Pick<Job, "status" | "statusLocked">, to: Status): ManualStatusChange | null {
  if (to === job.status) return null;
  return {
    patch: { status: to },
    undo: { status: job.status, statusLocked: job.statusLocked },
  };
}

/**
 * The lock a manual change from `from` to `to` leaves on the job: an explicit `statusLocked`
 * from the patch when it is a boolean, otherwise locked unless it is saved -> applied.
 */
export function lockAfterManualChange(from: Status, to: Status, statusLocked?: boolean | null): boolean {
  return typeof statusLocked === "boolean" ? statusLocked : !(from === "saved" && to === "applied");
}
