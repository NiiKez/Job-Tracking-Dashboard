import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Mirrors the detail layout so nothing jumps when the job arrives. */
export function JobDetailSkeleton({ variant }: { variant: "sheet" | "page" }) {
  const facts = (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-3 w-16" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className={cn("h-4", i === 0 ? "w-36" : i % 2 ? "w-20" : "w-28")} />
        </div>
      ))}
    </div>
  );
  const description = (
    <div className="flex flex-col gap-2.5">
      <Skeleton className="h-3 w-24" />
      {[92, 100, 84, 96, 70, 88, 60].map((w, i) => (
        <Skeleton key={i} className="h-3.5" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
  const list = (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-20 w-full rounded-lg" />
      <Skeleton className="h-20 w-full rounded-lg" />
    </div>
  );

  return (
    <div role="status" aria-live="polite" className="@container flex flex-col gap-6">
      <span className="sr-only">Loading job…</span>
      <div
        className={cn(
          "flex flex-col gap-4",
          variant === "page" && "@2xl:flex-row @2xl:items-start @2xl:justify-between",
        )}
      >
        <div className={cn("flex items-start gap-4", variant === "sheet" && "pr-8")}>
          <Skeleton className="size-12 shrink-0 rounded-md" />
          <div className="flex flex-col gap-2 pt-0.5">
            <Skeleton className="h-5 w-56 max-w-[60vw]" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3.5 w-32" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="size-8" />
        </div>
      </div>
      {variant === "page" ? (
        <div className="grid gap-x-10 gap-y-8 border-t pt-6 @4xl:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="flex flex-col gap-8">
            {description}
            {list}
          </div>
          <div className="flex flex-col gap-6 rounded-lg border p-5">
            {facts}
            {list}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-6 border-t pt-6">
          {facts}
          {description}
          {list}
        </div>
      )}
    </div>
  );
}
