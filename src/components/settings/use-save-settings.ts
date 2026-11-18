"use client";

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { qk, useUpdateSettings } from "@/lib/api/hooks";
import type { SettingsPatch } from "@/lib/api/client";
import type { Settings } from "@/lib/types";

/**
 * Autosave for settings controls: applies the patch to the cache right away
 * (so switches and selects feel instant), saves it, and confirms with one
 * subtle "Saved" toast that is reused instead of stacking.
 */
export function useSaveSettings() {
  const qc = useQueryClient();
  const update = useUpdateSettings();

  const save = async (patch: SettingsPatch, message = "Saved", description?: string) => {
    // A settings poll already on its way (Settings polls while a sync runs) would land after the
    // optimistic value and put the old one back until the next poll.
    await qc.cancelQueries({ queryKey: qk.settings });
    const prev = qc.getQueryData<Settings>(qk.settings);
    if (prev) {
      qc.setQueryData<Settings>(qk.settings, {
        ...prev,
        ...patch,
        inbox: { ...prev.inbox, ...patch.inbox },
      });
    }
    return update
      .mutateAsync(patch)
      .then((saved) => {
        toast.success(message, { id: "settings-saved", description, duration: 2000 });
        return saved;
      })
      .catch((err: Error) => {
        if (prev) qc.setQueryData(qk.settings, prev);
        toast.error("Couldn't save the setting", { description: err.message });
      });
  };

  return { save, isPending: update.isPending };
}
