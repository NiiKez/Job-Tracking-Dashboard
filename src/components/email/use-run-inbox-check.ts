"use client";

import { toast } from "sonner";
import { useCheckInbox, useSettings } from "@/lib/api/hooks";
import { checkResultToast } from "./inbox-copy";

/**
 * "Check inbox now" with a summary toast. Used by the sidebar, the activity and review pages and
 * Settings.
 * - `connected` is false until a mailbox is connected (and while settings load): a sync then has
 *   nothing to read, so callers disable their button.
 * - `isPending` is also true while the server runs a sync on its own (Settings.inbox.syncing: a
 *   scheduled sync, the first scan): a click would only wait for it, so callers show it as running.
 *   A first scan that is paused between runs (backfill set, not syncing) leaves the button free.
 * A failed check (409 not connected, 502 Google failed) shows the server's message.
 */
export function useRunInboxCheck() {
  const check = useCheckInbox();
  const inbox = useSettings().data?.inbox;
  const connected = inbox?.connected ?? false;
  const run = () =>
    check.mutate(undefined, {
      onSuccess: (res) => {
        const { kind, title, description } = checkResultToast(res);
        toast[kind](title, { description });
      },
      onError: (err) => toast.error("Couldn't check the inbox", { description: err.message }),
    });
  return { run, isPending: check.isPending || (inbox?.syncing ?? false), connected };
}
