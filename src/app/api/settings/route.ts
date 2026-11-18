import { readJson, route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { settingsPatchSchema } from "@/lib/server/schemas";
import { getSettings, updateSettings } from "@/lib/server/services/settings";

export const GET = route(({ user }) => getSettings(getDb(), user.id));

// The inbox block takes only intervalMinutes: connecting a mailbox is Gmail ingest's own flow.
export const PATCH = route(async ({ req, user }) => updateSettings(user.id, await readJson(req, settingsPatchSchema)));
