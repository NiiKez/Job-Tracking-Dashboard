"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAddJob } from "@/components/jobs/add-job-provider";
import { cn } from "@/lib/utils";

/**
 * Sticky top bar of every page: sidebar toggle, page title (h1), page-specific
 * actions and the global "Add job" button. (Theme lives in Settings.)
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
  hideAddJob,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  hideAddJob?: boolean;
}) {
  const { openAddJob } = useAddJob();
  return (
    <header
      className={cn(
        "sticky top-0 z-20 flex min-h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-4",
        className,
      )}
    >
      <SidebarTrigger className="-ml-1 size-9" />
      <Separator orientation="vertical" className="mr-1 self-center data-[orientation=vertical]:h-5" />
      <div className="min-w-0 flex-1 py-2">
        <h1 className="truncate text-[15px] leading-tight font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {actions}
        {!hideAddJob && (
          <Button size="sm" onClick={() => openAddJob()} className="h-9 gap-1.5">
            <Plus aria-hidden className="size-4" />
            <span className="hidden sm:inline">Add job</span>
            <Kbd className="hidden border-0 bg-white/20 text-[10px] text-primary-foreground md:inline-flex">
              N
            </Kbd>
          </Button>
        )}
      </div>
    </header>
  );
}
