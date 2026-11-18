import "server-only";
import type { Db, Tx } from "@/lib/server/db/client";
import { isUuid, type RuleRow } from "@/lib/server/db/rows";
import type { KeywordRule } from "@/lib/types";

/** SQL for keyword_rules. Every function filters by user_id. */

/** In the order they were added (the default rules first, as at sign-up). */
export async function listRuleRows(db: Db, userId: string): Promise<RuleRow[]> {
  return db<RuleRow[]>`
    SELECT id, status, phrase, language FROM keyword_rules
    WHERE user_id = ${userId}
    ORDER BY created_at, id`;
}

/**
 * Inserts the rule unless the user has one with the same status and phrase_norm; returns the
 * new rule (created: true) or the one already there (created: false).
 */
export async function insertRuleIfNew(
  tx: Tx,
  userId: string,
  rule: { status: KeywordRule["status"]; phrase: string; phraseNorm: string; language: string },
): Promise<{ row: RuleRow; created: boolean }> {
  const [inserted] = await tx<RuleRow[]>`
    INSERT INTO keyword_rules (user_id, status, phrase, phrase_norm, language)
    VALUES (${userId}, ${rule.status}, ${rule.phrase}, ${rule.phraseNorm}, ${rule.language})
    ON CONFLICT (user_id, status, phrase_norm) DO NOTHING
    RETURNING id, status, phrase, language`;
  if (inserted) return { row: inserted, created: true };
  // The conflict waited for the other insert to commit, so a new statement sees its row.
  const [existing] = await tx<RuleRow[]>`
    SELECT id, status, phrase, language FROM keyword_rules
    WHERE user_id = ${userId} AND status = ${rule.status} AND phrase_norm = ${rule.phraseNorm}`;
  return { row: existing, created: false };
}

/** Inserts the rules the user does not have yet (by status and phrase_norm); returns how many were new. */
export async function insertRuleRowsIfNew(
  tx: Tx,
  userId: string,
  rules: ReadonlyArray<{ status: KeywordRule["status"]; phrase: string; phraseNorm: string; language: string }>,
): Promise<number> {
  if (rules.length === 0) return 0;
  const rows = rules.map((r) => ({
    user_id: userId,
    status: r.status,
    phrase: r.phrase,
    phrase_norm: r.phraseNorm,
    language: r.language,
  }));
  const inserted = await tx`
    INSERT INTO keyword_rules ${tx(rows, "user_id", "status", "phrase", "phrase_norm", "language")}
    ON CONFLICT (user_id, status, phrase_norm) DO NOTHING
    RETURNING id`;
  return inserted.length;
}

/** Deletes the user's rules with one of these statuses and phrase_norms; returns how many there were. */
export async function deleteRuleRowsByPhrase(
  tx: Tx,
  userId: string,
  rules: ReadonlyArray<{ status: KeywordRule["status"]; phraseNorm: string }>,
): Promise<number> {
  let deleted = 0;
  for (const rule of rules) {
    const rows = await tx`
      DELETE FROM keyword_rules
      WHERE user_id = ${userId} AND status = ${rule.status} AND phrase_norm = ${rule.phraseNorm}
      RETURNING id`;
    deleted += rows.length;
  }
  return deleted;
}

export async function deleteRuleRow(db: Db, userId: string, ruleId: string): Promise<boolean> {
  if (!isUuid(ruleId)) return false;
  const rows = await db`DELETE FROM keyword_rules WHERE user_id = ${userId} AND id = ${ruleId} RETURNING id`;
  return rows.length > 0;
}
