import "server-only";
import { jobKeys } from "@/lib/domain/normalize";
import type { Db } from "@/lib/server/db/client";
import { parseJobInput } from "@/lib/server/parse/link";
import { findDuplicateJobRow } from "@/lib/server/repo/jobs";
import { loadJob } from "@/lib/server/services/jobs";
import type { ParseResult } from "@/lib/types";

export interface ParseInputOptions {
  /**
   * False: a link is not opened; its fields come from the link's own text only (host and path),
   * as when a fetch fails. Default true. (The public demo, where visitors are anonymous.)
   */
  fetchLink?: boolean;
}

/**
 * The add-job dialog's "read this": the fields found in a pasted link or text, and the user's
 * job they would duplicate (the same lookup upsertJob uses: link first, then company and title).
 * A link is fetched and read (see src/lib/server/parse/link.ts), counted against this user's
 * fetch budget; any failure falls back to the heuristics, so this does not fail on the page.
 * With `fetchLink: false` it is never fetched.
 */
export async function parseInput(
  db: Db,
  userId: string,
  input: string,
  opts: ParseInputOptions = {},
): Promise<ParseResult> {
  const parsed = await parseJobInput(input, { rateLimitKey: userId, fetchLink: opts.fetchLink });
  const duplicate = await findDuplicateJobRow(db, userId, jobKeys(parsed));
  return { ...parsed, duplicateOf: duplicate ? await loadJob(db, userId, duplicate.id) : null };
}
