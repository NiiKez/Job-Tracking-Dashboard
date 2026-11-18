import "server-only";
import { z } from "zod";
import { DEFAULT_USER_SETTINGS } from "@/lib/domain/defaults";
import { withTx, type Db } from "@/lib/server/db/client";
import { toSettings, type SettingsRow } from "@/lib/server/db/rows";
import { pullNextSyncForward } from "@/lib/server/inbox/repo";
import { getInboxStatus } from "@/lib/server/inbox/status";
import { findSettingsRow, updateSettingsRow } from "@/lib/server/repo/settings";
import type { Settings } from "@/lib/types";

/**
 * Settings: the user's settings row plus the mailbox status from area 2 (getInboxStatus).
 * Connecting a mailbox is area 2's flow, so the inbox block takes only intervalMinutes here.
 */

/** Ranges as in the user_settings checks (and settingsPatchSchema). Unknown keys are dropped. */
const patchSchema = z
  .object({
    noResponseDays: z.number().int().min(7).max(120),
    createFromConfirmation: z.boolean(),
    reviewUncertain: z.boolean(),
    languages: z.array(z.string()),
    inbox: z.object({ intervalMinutes: z.number().int().min(5).max(1440) }).partial(),
  })
  .partial();

export type SettingsPatch = z.input<typeof patchSchema>;

export async function getSettings(db: Db, userId: string): Promise<Settings> {
  const [row, inbox] = await Promise.all([findSettingsRow(db, userId), getInboxStatus(db, userId)]);
  return toSettings(row ?? defaultRow(), inbox);
}

/** Changes the given settings and returns all of them. A value out of range throws a ZodError (400). */
export async function updateSettings(userId: string, patch: SettingsPatch): Promise<Settings> {
  const p = patchSchema.parse(patch);
  return withTx(async (tx) => {
    const row = await updateSettingsRow(tx, userId, {
      noResponseDays: p.noResponseDays,
      createFromConfirmation: p.createFromConfirmation,
      reviewUncertain: p.reviewUncertain,
      languages: p.languages,
      inboxIntervalMinutes: p.inbox?.intervalMinutes,
    });
    // A shorter interval applies now, not only after the run already scheduled.
    if (p.inbox?.intervalMinutes !== undefined) await pullNextSyncForward(tx, userId, p.inbox.intervalMinutes);
    return toSettings(row, await getInboxStatus(tx, userId));
  });
}

/** What a user without a settings row sees (the row is created at first sign-in). */
function defaultRow(): SettingsRow {
  return {
    no_response_days: DEFAULT_USER_SETTINGS.noResponseDays,
    create_from_confirmation: DEFAULT_USER_SETTINGS.createFromConfirmation,
    review_uncertain: DEFAULT_USER_SETTINGS.reviewUncertain,
    languages: [...DEFAULT_USER_SETTINGS.languages],
    inbox_interval_minutes: DEFAULT_USER_SETTINGS.inboxIntervalMinutes,
  };
}
