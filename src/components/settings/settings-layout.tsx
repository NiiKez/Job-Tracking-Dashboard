import { cn } from "@/lib/utils";

/** Shared control sizing: 40px touch targets on mobile, 36px from md. */
export const CONTROL_H = "h-10 md:h-9";
export const SELECT_H = "data-[size=default]:h-10 md:data-[size=default]:h-9";

/**
 * One Swiss-style settings row: title + one-sentence description on the left
 * (1/3 on lg), the controls on the right. Sections are separated by a rule.
 */
export function SettingsSection({
  id,
  title,
  description,
  children,
  className,
}: {
  id: string;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        "grid scroll-mt-20 gap-4 border-t py-8 first:border-t-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-10",
        className,
      )}
    >
      <div className="flex flex-col gap-1.5">
        <h2 id={`${id}-title`} className="text-section font-semibold">
          {title}
        </h2>
        <div className="text-sm text-pretty text-muted-foreground">{description}</div>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** Bordered card that holds a section's controls; rows are divided by rules. */
export function SettingsCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("divide-y overflow-hidden rounded-lg border bg-card text-card-foreground", className)}
      {...props}
    />
  );
}

/** Label/description on the left, control on the right (stacks on mobile). */
export function SettingsRow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6",
        className,
      )}
      {...props}
    />
  );
}

/** Muted strip at the bottom of a card for notes. */
export function SettingsNote({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 bg-surface-sunken px-4 py-3 text-xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
