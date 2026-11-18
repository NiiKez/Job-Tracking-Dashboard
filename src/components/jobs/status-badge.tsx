import { cn } from "@/lib/utils";
import { STATUS_META } from "@/lib/status";
import type { Status } from "@/lib/types";

/** Tinted pill with icon + label. Never color-only. */
export function StatusBadge({
  status,
  size = "sm",
  className,
}: {
  status: Status;
  size?: "sm" | "md";
  className?: string;
}) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "h-5 px-2 text-[11px]" : "h-6 px-2.5 text-xs",
        meta.badgeClass,
        className,
      )}
    >
      <Icon aria-hidden className={size === "sm" ? "size-3" : "size-3.5"} />
      {meta.label}
    </span>
  );
}

/** Small solid dot, e.g. in column headers and selects. Decorative. */
export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", STATUS_META[status].dotClass, className)}
    />
  );
}
