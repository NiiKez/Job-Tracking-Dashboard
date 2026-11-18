import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";
import type { Email } from "@/lib/types";

/*
 * Emails the inbox check couldn't file, as one line under the KPI row. It says
 * how many are waiting and why that matters for the board below; sorting them
 * out happens on the Needs-review page.
 */

export function ReviewBanner({
  emails,
}: {
  /** Emails waiting for review; undefined while loading. */
  emails: Email[] | undefined;
}) {
  if (!emails || emails.length === 0) return null;

  const count = emails.length;
  const one = count === 1;

  return (
    <section
      aria-label="Emails to review"
      className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 @2xl:flex-row @2xl:items-center @2xl:gap-4"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-attention" />
        <p className="min-w-0 text-meta leading-5">
          <strong className="font-semibold">
            {plural(count, "email")} {one ? "needs" : "need"} your review.
          </strong>{" "}
          <span className="text-foreground/80">
            {one
              ? "It couldn’t be filed automatically, so an application may be out of date."
              : "They couldn’t be filed automatically, so some applications may be out of date."}
          </span>
        </p>
      </div>
      <div className="pl-7 @2xl:shrink-0 @2xl:pl-0">
        <Button asChild variant="outline" className="h-9 bg-background pointer-coarse:h-10">
          <Link href="/review">{one ? "Review email" : "Review emails"}</Link>
        </Button>
      </div>
    </section>
  );
}
