import { Briefcase } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SignInActions, SignInFromUrl } from "@/components/auth/sign-in";

export const metadata: Metadata = { title: "Sign in" };

/**
 * A static page. ?next= and ?error= are read in the browser, inside the
 * Suspense boundary; its fallback is the same link without them.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 px-4 py-12">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6">
        <div className="flex items-center gap-2">
          <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Briefcase aria-hidden className="size-4" />
          </span>
          <span className="text-sm font-semibold text-foreground">Job Tracker</span>
        </div>
        <h1 className="mt-6 text-section font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">
          Use the Google account this tracker belongs to.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <Suspense fallback={<SignInActions />}>
            <SignInFromUrl />
          </Suspense>
        </div>
      </div>
      {/* Google's consent screen links to /privacy too (docs/gmail-setup.md). */}
      <Link
        href="/privacy"
        className="rounded-sm text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Privacy
      </Link>
    </main>
  );
}
