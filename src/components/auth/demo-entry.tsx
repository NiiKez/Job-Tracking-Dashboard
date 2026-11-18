"use client";

import { CircleAlert } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** Where the entry form posts (src/app/auth/demo/route.ts): answers 303 to / or back here. */
export const DEMO_ENTRY_ACTION = "/auth/demo";

/**
 * ?error= codes POST /auth/demo (and nginx's own limit, which answers like it) sends back here.
 * Unknown codes get the "couldn't start" line.
 */
export function demoEntryError(code: string): string {
  return code === "busy"
    ? "The demo is busy right now. Try again in a minute."
    : "The demo couldn't start. Try again.";
}

/**
 * The error line and "Try the demo": a plain HTML form that posts to /auth/demo, so it works
 * without JavaScript and under a form-action 'self' policy. With JavaScript, the button turns off
 * once pressed, so a double click does not make two workspaces; it turns on again when the
 * browser brings the page back from its history (bfcache).
 */
export function DemoEntryActions({ error }: { error?: string | null }) {
  const [sending, setSending] = useState(false);
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setSending(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  return (
    <>
      {error && (
        <p role="alert" className="flex gap-2 text-meta text-destructive">
          <CircleAlert aria-hidden className="mt-px size-4 shrink-0" />
          {demoEntryError(error)}
        </p>
      )}
      <form method="post" action={DEMO_ENTRY_ACTION} onSubmit={() => setSending(true)}>
        <Button type="submit" disabled={sending} className="h-9 w-full pointer-coarse:h-10">
          Try the demo
        </Button>
      </form>
    </>
  );
}

/** Reads ?error= in the browser. Render inside <Suspense>. */
export function DemoEntryFromUrl() {
  const params = useSearchParams();
  return <DemoEntryActions error={params.get("error")} />;
}
