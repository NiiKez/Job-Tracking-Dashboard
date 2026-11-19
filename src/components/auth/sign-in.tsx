"use client";

import { useQuery } from "@tanstack/react-query";
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

/** GET → { demoUrl: string | null } (src/app/auth/options/route.ts). Works signed out. */
export const AUTH_OPTIONS_PATH = "/auth/options";

/** The query's key: the fallback and the URL-reading actions share one fetch. */
export const AUTH_OPTIONS_KEY = ["auth-options"] as const;

/**
 * The demo's origin from /auth/options' answer, or null for anything else. Only an http or https
 * URL gets through, so a broken answer cannot put another kind of link on the page.
 */
export function demoUrlFrom(data: unknown): string | null {
  const value = (data as { demoUrl?: unknown } | null)?.demoUrl;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Asks /auth/options once. Never throws: a failed answer means no link. */
export async function fetchDemoUrl(): Promise<string | null> {
  try {
    const res = await fetch(AUTH_OPTIONS_PATH, { cache: "no-store" });
    return res.ok ? demoUrlFrom(await res.json()) : null;
  } catch {
    return null;
  }
}

/** The demo's origin once /auth/options has answered with one; null while loading and otherwise. */
function useDemoUrl(): string | null {
  const { data } = useQuery({ queryKey: AUTH_OPTIONS_KEY, queryFn: fetchDemoUrl, staleTime: Infinity, retry: false });
  return data ?? null;
}

/**
 * "Just looking? Try the demo" under the Google button, when DEMO_URL is set
 * (docs/plan/5-public-demo.md, "Step 8"). A plain link, not a form: the real site's
 * Content-Security-Policy has form-action 'self'. Nothing at all without one, so the page looks
 * as it did before.
 */
export function DemoLink({ href }: { href: string | null }) {
  if (!href) return null;
  return (
    <p className="text-center text-meta text-muted-foreground">
      Just looking?{" "}
      <a
        href={href}
        className="rounded-sm font-medium text-foreground underline underline-offset-4 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Try the demo
      </a>
    </p>
  );
}

/**
 * The error line (after a failed attempt), the "Continue with Google" link (a real link, since
 * sign-in is a full-page trip to Google and back) and, when the server names one, the demo link.
 */
export function SignInActions({ next, error }: { next?: string | null; error?: string | null }) {
  const demoUrl = useDemoUrl();
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
      <DemoLink href={demoUrl} />
    </>
  );
}

/** Reads ?next= and ?error= in the browser. Render inside <Suspense>. */
export function SignInFromUrl() {
  const params = useSearchParams();
  return <SignInActions next={params.get("next")} error={params.get("error")} />;
}
