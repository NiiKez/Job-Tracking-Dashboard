import { cn } from "@/lib/utils";
import { initials } from "@/lib/format";

export function CompanyAvatar({
  company,
  size = "md",
  className,
}: {
  company: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        // One neutral style: a hue per company would be colour without meaning.
        "inline-flex shrink-0 items-center justify-center rounded-md bg-muted font-semibold text-muted-foreground select-none",
        size === "sm" && "size-6 text-[10px]",
        size === "md" && "size-8 text-xs",
        size === "lg" && "size-12 text-base",
        className,
      )}
    >
      {initials(company)}
    </span>
  );
}
