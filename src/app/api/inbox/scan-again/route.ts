import { route } from "@/lib/server/auth/guard";
import { scanAgain } from "@/lib/server/inbox/scan-again";

/**
 * Settings → Inbox → "Scan again": a new full scan of the mailbox, started at once (see
 * scanAgain). Answers { ok: true, forgotten } before the scan ends; Settings shows its progress.
 * 409 when not connected, when Gmail needs a reconnect, in demo mode on a Gmail connection, and
 * while a sync runs.
 */
export const POST = route(async ({ user }) => {
  const { forgotten } = await scanAgain(user.id);
  return { ok: true as const, forgotten };
});
