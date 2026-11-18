import "server-only";
import { DEFAULT_USER_SETTINGS } from "@/lib/domain/defaults";
import { classifyEmail } from "@/lib/inbox/pipeline/classify";
import type { Db } from "@/lib/server/db/client";
import { findSettingsRow } from "@/lib/server/repo/settings";
import { listAllJobs } from "@/lib/server/services/jobs";
import { listRules } from "@/lib/server/services/rules";
import type { ClassifyInput, ClassifyResult } from "@/lib/types";

/**
 * The rule tester (Settings → Test an email): what the pipeline would do with this email, given
 * the user's jobs, rules and settings, as if it arrived now, outside any thread, from an address
 * never seen before. Reads only; nothing is stored.
 */
export async function classify(db: Db, userId: string, input: ClassifyInput): Promise<ClassifyResult> {
  const [jobs, rules, settings] = await Promise.all([
    listAllJobs(db, userId),
    listRules(db, userId),
    findSettingsRow(db, userId),
  ]);
  const createFromConfirmation = settings?.create_from_confirmation ?? DEFAULT_USER_SETTINGS.createFromConfirmation;
  const languages = settings?.languages ?? DEFAULT_USER_SETTINGS.languages;
  return classifyEmail(input, jobs, rules, createFromConfirmation, { languages });
}
