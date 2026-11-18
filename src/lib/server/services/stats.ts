import "server-only";
import type { Db } from "@/lib/server/db/client";
import { countEmailsWithOutcome } from "@/lib/server/repo/emails";
import { countJobsByStatus } from "@/lib/server/repo/jobs";
import { STATUSES, type Stats, type Status } from "@/lib/types";

/** Jobs per status (all six present), the total, and how many emails wait for review. */
export async function getStats(db: Db, userId: string): Promise<Stats> {
  const [counts, reviewCount] = await Promise.all([
    countJobsByStatus(db, userId),
    countEmailsWithOutcome(db, userId, "review"),
  ]);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  let total = 0;
  for (const { status, count } of counts) {
    byStatus[status] = count;
    total += count;
  }
  return { byStatus, total, reviewCount };
}
