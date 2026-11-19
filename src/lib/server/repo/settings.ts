import "server-only";
import type { Db, Tx } from "@/lib/server/db/client";
import type { SettingsRow } from "@/lib/server/db/rows";
import { MAX_SETTINGS_LANGUAGES } from "@/lib/server/schemas";

/**
 * SQL for user_settings: one row per user, created in the first sign-in's transaction. The
 * writers below still create it when it is missing, so a write never silently does nothing.
 */

/** The user's settings row, or null if the user has none yet. */
export async function findSettingsRow(db: Db, userId: string): Promise<SettingsRow | null> {
  const [row] = await db<SettingsRow[]>`
    SELECT no_response_days, create_from_confirmation, review_uncertain, languages, inbox_interval_minutes
    FROM user_settings WHERE user_id = ${userId}`;
  return row ?? null;
}

async function ensureSettingsRow(tx: Tx, userId: string): Promise<void> {
  await tx`INSERT INTO user_settings (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`;
}

export interface SettingsRowPatch {
  noResponseDays?: number;
  createFromConfirmation?: boolean;
  reviewUncertain?: boolean;
  languages?: readonly string[];
  inboxIntervalMinutes?: number;
}

/** Writes the given fields and keeps the others. The table's checks enforce the ranges. */
export async function updateSettingsRow(tx: Tx, userId: string, patch: SettingsRowPatch): Promise<SettingsRow> {
  await ensureSettingsRow(tx, userId);
  const [row] = await tx<SettingsRow[]>`
    UPDATE user_settings SET
      no_response_days = coalesce(${patch.noResponseDays ?? null}::int, no_response_days),
      create_from_confirmation = coalesce(${patch.createFromConfirmation ?? null}::boolean, create_from_confirmation),
      review_uncertain = coalesce(${patch.reviewUncertain ?? null}::boolean, review_uncertain),
      languages = coalesce(${patch.languages ?? null}::text[], languages),
      inbox_interval_minutes = coalesce(${patch.inboxIntervalMinutes ?? null}::int, inbox_interval_minutes)
    WHERE user_id = ${userId}
    RETURNING no_response_days, create_from_confirmation, review_uncertain, languages, inbox_interval_minutes`;
  return row;
}

/**
 * Appends the language to settings.languages unless it is already there, or the list already
 * holds MAX_SETTINGS_LANGUAGES (what PATCH /api/settings allows). Without that cap, adding a rule
 * in a new language and deleting it again, over and over, would grow the list without end. A
 * language left out costs little: the list only feeds the language guess (lib/inbox/pipeline/
 * language.ts), and Settings lists every rule's language anyway.
 */
export async function addSettingsLanguage(tx: Tx, userId: string, language: string): Promise<void> {
  await ensureSettingsRow(tx, userId);
  await tx`
    UPDATE user_settings SET languages = array_append(languages, ${language}::text)
    WHERE user_id = ${userId} AND NOT (${language}::text = ANY(languages))
      AND cardinality(languages) < ${MAX_SETTINGS_LANGUAGES}::int`;
}
