import "server-only";
import { DEFAULT_RULES, RETIRED_DEFAULT_RULES } from "@/lib/domain/defaults";
import { normalize } from "@/lib/domain/normalize";
import { getDb, withTx, type Db } from "@/lib/server/db/client";
import { toKeywordRule } from "@/lib/server/db/rows";
import { checkDemoCap } from "@/lib/server/demo/caps";
import { BadRequestError, NotFoundError } from "@/lib/server/errors";
import {
  deleteRuleRow,
  deleteRuleRowsByPhrase,
  insertRuleIfNew,
  insertRuleRowsIfNew,
  listRuleRows,
} from "@/lib/server/repo/rules";
import { addSettingsLanguage } from "@/lib/server/repo/settings";
import type { DefaultRulesUpdate, KeywordRule } from "@/lib/types";

/** The user's keyword rules (Settings → Keyword rules), in the order they were added. */
export async function listRules(db: Db, userId: string): Promise<KeywordRule[]> {
  return (await listRuleRows(db, userId)).map(toKeywordRule);
}

/**
 * Adds a rule. The same status and phrase (ignoring case and accents) returns the rule already
 * there. A new rule's language joins settings.languages when it is not in there yet. In the
 * public demo a new rule over the cap (demo/caps.ts) is a ConflictError, and nothing is added.
 */
export async function addRule(userId: string, input: Omit<KeywordRule, "id">): Promise<KeywordRule> {
  const phrase = input.phrase.trim();
  const language = input.language.trim();
  const phraseNorm = normalize(phrase);
  if (!phraseNorm) throw new BadRequestError("The phrase has nothing to match");
  return withTx(async (tx) => {
    const { row, created } = await insertRuleIfNew(tx, userId, {
      status: input.status,
      phrase,
      phraseNorm,
      language,
    });
    if (created) {
      // Counted after the insert: one the user already has is no new rule. Throwing rolls it back.
      await checkDemoCap(tx, userId, "keywordRules", 0);
      await addSettingsLanguage(tx, userId, language);
    }
    return toKeywordRule(row);
  });
}

/**
 * Brings the user's rules to the current defaults (Settings → Keyword rules → Update defaults):
 * removes the retired default phrases (RETIRED_DEFAULT_RULES) and adds the DEFAULT_RULES the user
 * does not have. Rules the user added stay, and so does a default the user deleted only if it is
 * retired: a current default that was deleted comes back. The defaults' languages join
 * settings.languages. Doing it again changes nothing. In the public demo, ending over the rule
 * cap (demo/caps.ts) is a ConflictError, and nothing changes.
 */
export async function updateDefaultRules(userId: string): Promise<DefaultRulesUpdate> {
  return withTx(async (tx) => {
    const removed = await deleteRuleRowsByPhrase(
      tx,
      userId,
      RETIRED_DEFAULT_RULES.map((r) => ({ status: r.status, phraseNorm: normalize(r.phrase) })),
    );
    const added = await insertRuleRowsIfNew(
      tx,
      userId,
      DEFAULT_RULES.map((r) => ({ ...r, phraseNorm: normalize(r.phrase) })),
    );
    if (added > 0) await checkDemoCap(tx, userId, "keywordRules", 0);
    for (const language of new Set(DEFAULT_RULES.map((r) => r.language))) {
      await addSettingsLanguage(tx, userId, language);
    }
    return { added, removed, rules: await listRules(tx, userId) };
  });
}

/** NotFoundError when the rule is not the user's. */
export async function deleteRule(userId: string, ruleId: string): Promise<void> {
  if (!(await deleteRuleRow(getDb(), userId, ruleId))) throw new NotFoundError("Rule not found");
}
