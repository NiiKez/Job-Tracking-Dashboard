"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False on the server and during hydration, true afterwards.
 *
 * Client-fetched views render their skeleton until this is true. Otherwise a
 * Suspense boundary that hydrates late can find the query already cached (e.g.
 * settings fetched by the sidebar), render data instead of the server's
 * skeleton, and trigger a hydration mismatch.
 */
export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
