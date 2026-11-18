"use client";

import { CircleAlert } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { safeNextPath } from "@/lib/domain/safe-next";

/** ?error= codes from the /auth routes. Unknown codes get the generic line. */
function errorMessage(code: string) {
  switch (code) {
    case "not_allowed":
      return "That Google account isn't allowed to sign in here. Try another account.";
    case "not_configured":
      return "Sign-in isn't set up on this server yet.";
    case "failed":
      return "Sign-in was cancelled or didn't finish. Try again.";
    default:
      return "Sign-in failed. Try again.";
  }
}

function signInHref(next: string | null | undefined) {
  const path = safeNextPath(next);
  return path ? `/auth/google?next=${encodeURIComponent(path)}` : "/auth/google";
}

/**
 * The error line (after a failed attempt) and the "Continue with Google" link:
 * a real link, since sign-in is a full-page trip to Google and back.
 */
export function SignInActions({ next, error }: { next?: string | null; error?: string | null }) {
  return (
    <>
      {error && (
        <p role="alert" className="flex gap-2 text-meta text-destructive">
          <CircleAlert aria-hidden className="mt-px size-4 shrink-0" />
          {errorMessage(error)}
        </p>
      )}
      <Button asChild className="h-9 w-full pointer-coarse:h-10">
        <a href={signInHref(next)}>Continue with Google</a>
      </Button>
    </>
  );
}

/** Reads ?next= and ?error= in the browser. Render inside <Suspense>. */
export function SignInFromUrl() {
  const params = useSearchParams();
  return <SignInActions next={params.get("next")} error={params.get("error")} />;
}
