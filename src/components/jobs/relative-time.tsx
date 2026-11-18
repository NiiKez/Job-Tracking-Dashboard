"use client";

import { formatDateTime, formatRelative } from "@/lib/format";

/** "5d ago" with the exact timestamp in a native tooltip + <time> for a11y. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {formatRelative(iso)}
    </time>
  );
}
