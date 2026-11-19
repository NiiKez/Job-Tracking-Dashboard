"use client";

import { useEffect } from "react";
import { useHydrated } from "@/hooks/use-hydrated";
import { useMe } from "@/lib/api/hooks";
import type { Me } from "@/lib/types";

export type DemoWorkspace = NonNullable<Me["demo"]>;

/**
 * The public demo, as /api/me tells it (docs/plan/5-public-demo.md, "Step 7"). The demo and the
 * real app are the same build, so only the server's answer tells them apart: `me.demo` is there
 * in the demo and absent everywhere else.
 *
 *   demo      the visitor's workspace ({ expiresAt }) in the demo; null in the real app, and
 *             until the answer is known
 *   settled   the answer (or its failure) is known: a view that differs in the demo waits for
 *             this instead of showing the real app's version first. A failed /api/me counts as
 *             "not the demo" (a 401 leaves for the login page anyway).
 *
 * Both are false/null on the server and during hydration, like every client-fetched view
 * (useHydrated). No request of its own: useMe is the account menu's query, which every signed-in
 * page has and which never goes stale.
 */
export function useDemo(): { settled: boolean; demo: DemoWorkspace | null } {
  const hydrated = useHydrated();
  const { data, isError } = useMe();
  if (!hydrated) return { settled: false, demo: null };
  return { settled: data !== undefined || isError, demo: data?.demo ?? null };
}

/**
 * In the demo, a page the browser brings back from its history (bfcache) loads again. As it was
 * left, it may belong to a workspace that is gone: Back after "Start over" or "Leave the demo"
 * would show the old workspace's data, or the "Start over" dialog still sending. Loaded again,
 * it shows the visitor's current workspace, or the entry page. Nothing in the real app.
 * Called once, from a component every signed-in page has (DemoBanner).
 */
export function useReloadFromHistoryInDemo(): void {
  const inDemo = useDemo().demo !== null;
  useEffect(() => {
    if (!inDemo) return;
    const reload = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", reload);
    return () => window.removeEventListener("pageshow", reload);
  }, [inDemo]);
}
