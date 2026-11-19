"use client";

import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** Where the entry form posts (src/app/auth/demo/route.ts): answers 303 to / or back here. */
export const DEMO_ENTRY_ACTION = "/auth/demo";

/**
 * ?error= codes POST /auth/demo (and nginx's own limit, which answers like it) sends back here:
 *
 *   busy        the demo is full, or too many visitors are entering at once
 *   busy_kept   the same, for a visitor in a workspace ("Start over"), which stays as it was
 *   failed      anything else
 *
 * Unknown codes get the "couldn't start" line.
 */
export function demoEntryError(code: string): string {
  if (code === "busy") return "The demo is busy right now. Try again in a minute.";
  if (code === "busy_kept") return "The demo is busy right now, so your workspace was not replaced.";
  return "The demo couldn't start. Try again.";
}

/**
 * The error line and "Try the demo": a plain HTML form that posts to /auth/demo, so it works
 * without JavaScript and under a form-action 'self' policy. With JavaScript, the button turns off
 * once pressed, so a double click does not make two workspaces; it turns on again when the
 * browser brings the page back from its history (bfcache). After a refused "Start over"
 * (busy_kept), a link back to the visitor's workspace instead: pressing "Try the demo" would only
 * try to replace it again.
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
      {error === "busy_kept" ? (
        <Button asChild className="h-9 w-full pointer-coarse:h-10">
          <Link href="/">Back to your workspace</Link>
        </Button>
      ) : (
        <form method="post" action={DEMO_ENTRY_ACTION} onSubmit={() => setSending(true)}>
          <Button type="submit" disabled={sending} className="h-9 w-full pointer-coarse:h-10">
            Try the demo
          </Button>
        </form>
      )}
    </>
  );
}

/** Reads ?error= in the browser. Render inside <Suspense>. */
export function DemoEntryFromUrl() {
  const params = useSearchParams();
  return <DemoEntryActions error={params.get("error")} />;
}
