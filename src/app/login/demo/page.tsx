import { Briefcase } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DemoEntryActions, DemoEntryFromUrl } from "@/components/auth/demo-entry";

export const metadata: Metadata = {
  title: "Try the demo",
  // The proxy also sends X-Robots-Tag in demo mode; outside it this page redirects to /login.
  robots: { index: false, follow: false },
};

/**
 * The public demo's entry page (docs/plan/5-public-demo.md, "Step 6"), in place of /login: the
 * proxy (src/proxy.ts) sends /login and every signed-out page here in demo mode, and sends this
 * page to /login outside it. Static, like /login: the same in every build and environment, and
 * ?error= is read in the browser, inside the Suspense boundary; its fallback is the same form
 * without it. The form is plain HTML (src/components/auth/demo-entry.tsx), so entering works
 * without JavaScript.
 */
export default function DemoEntryPage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 px-4 py-12">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6">
        <div className="flex items-center gap-2">
          <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Briefcase aria-hidden className="size-4" />
          </span>
          <span className="text-sm font-semibold text-foreground">Job Tracker</span>
        </div>
        <h1 className="mt-6 text-section font-semibold">Try the demo</h1>
        <div className="mt-1 flex flex-col gap-2 text-sm text-pretty text-muted-foreground">
          <p>Explore the tracker with invented jobs and emails.</p>
          <p>Your workspace is private to this browser and is deleted after 24 hours, or when you leave.</p>
          <p>Don&apos;t enter real personal data.</p>
        </div>
        <div className="mt-6 flex flex-col gap-3">
          <Suspense fallback={<DemoEntryActions />}>
            <DemoEntryFromUrl />
          </Suspense>
        </div>
      </div>
      <Link
        href="/privacy"
        className="rounded-sm text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Privacy
      </Link>
    </main>
  );
}
