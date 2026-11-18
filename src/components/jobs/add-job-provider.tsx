"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AddJobDialog } from "./add-job-dialog";

export interface AddJobOptions {
  /** Pre-fill the paste box (link or job text). */
  input?: string;
  /** Pre-select Saved or Applied. Defaults to "saved". */
  status?: "saved" | "applied";
}

const AddJobContext = createContext<{ openAddJob: (opts?: AddJobOptions) => void } | null>(null);

/** Opens the global "Add job" dialog from anywhere (header button, empty states, "N" key). */
export function useAddJob() {
  const ctx = useContext(AddJobContext);
  if (!ctx) throw new Error("useAddJob must be used inside <AddJobProvider>");
  return ctx;
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

export function AddJobProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<AddJobOptions>({});
  // Bumped on every open so the dialog can reset its internal state.
  const [session, setSession] = useState(0);

  const openAddJob = useCallback((opts: AddJobOptions = {}) => {
    setOptions(opts);
    setSession((s) => s + 1);
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target) || document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      openAddJob();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openAddJob]);

  const value = useMemo(() => ({ openAddJob }), [openAddJob]);

  return (
    <AddJobContext.Provider value={value}>
      {children}
      <AddJobDialog key={session} open={open} onOpenChange={setOpen} options={options} />
    </AddJobContext.Provider>
  );
}
