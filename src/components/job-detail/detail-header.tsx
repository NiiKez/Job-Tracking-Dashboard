"use client";

import {
  Copy,
  ExternalLink,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Pencil,
  Send,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { CompanyAvatar } from "@/components/jobs/company-avatar";
import { StatusMenu, useChangeStatus } from "@/components/jobs/status-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDeleteJob } from "@/lib/api/hooks";
import { hostOf } from "@/lib/format";
import type { Job } from "@/lib/types";
import { cn } from "@/lib/utils";

/** h-8 on desktop, 40px touch target on phones. */
const ACTION = "h-8 max-sm:h-10";

export function DetailHeader({
  job,
  variant,
  onEdit,
  onDeleted,
}: {
  job: Job;
  variant: "sheet" | "page";
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const changeStatus = useChangeStatus();
  const remove = useDeleteJob();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // "Edit details" swaps the header for a form: don't send focus back to the
  // (now unmounted) menu trigger, the form focuses its first field.
  const skipFocusReturn = useRef(false);

  const copyLink = async () => {
    if (!job.url) return;
    try {
      await navigator.clipboard.writeText(job.url);
      toast.success("Link copied", { description: hostOf(job.url) });
    } catch {
      toast.error("Couldn't copy the link", { description: "Your browser blocked the clipboard." });
    }
  };

  const confirmDelete = () => {
    remove.mutate(job.id, {
      onSuccess: () => {
        setConfirmOpen(false);
        toast.success("Job deleted", { description: `${job.company} · ${job.title}` });
        onDeleted();
      },
      onError: (err) => toast.error("Couldn't delete the job", { description: err.message }),
    });
  };

  return (
    <header
      className={cn(
        "flex flex-col gap-4",
        variant === "page" && "@2xl:flex-row @2xl:items-start @2xl:justify-between @2xl:gap-8",
      )}
    >
      <div className={cn("flex min-w-0 flex-1 items-start gap-4", variant === "sheet" && "pr-8")}>
        <CompanyAvatar company={job.company} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-lg leading-snug font-semibold tracking-tight text-balance">
            {job.title}
          </h2>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{job.company}</span>
            {job.location && (
              <>
                <span aria-hidden className="mx-1.5">
                  ·
                </span>
                {job.location}
              </>
            )}
          </p>
          {job.url ? (
            <a
              href={job.url}
              target="_blank"
              rel="noreferrer"
              className="-mx-1 inline-flex w-fit max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors duration-150 outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:py-2"
            >
              <ExternalLink aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate underline-offset-4 hover:underline">{hostOf(job.url)}</span>
              <span className="sr-only">(original posting, opens in a new tab)</span>
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">No link to the posting</span>
          )}
        </div>
      </div>

      <div
        className={cn(
          "flex flex-wrap items-center",
          variant === "sheet" ? "gap-1.5" : "gap-2 @2xl:shrink-0 @2xl:justify-end",
        )}
      >
        {job.status === "saved" && (
          <Button className={ACTION} onClick={() => changeStatus(job, "applied")}>
            <Send aria-hidden />
            Mark as applied
          </Button>
        )}
        <StatusMenu job={job} variant="button" align="end" className={ACTION} />
        {variant === "sheet" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="outline"
                className="size-8 max-sm:size-10 @md:w-auto @md:px-2.5"
              >
                <Link href={`/jobs/${job.id}`} aria-label="Open full page">
                  <Maximize2 aria-hidden />
                  <span aria-hidden className="hidden @md:inline">
                    Open full page
                  </span>
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open full page</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="max-sm:size-10" aria-label="More actions">
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>More actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="end"
            className="w-48"
            onCloseAutoFocus={(e) => {
              if (skipFocusReturn.current) {
                e.preventDefault();
                skipFocusReturn.current = false;
              }
            }}
          >
            <DropdownMenuItem
              className="gap-2"
              onSelect={() => {
                skipFocusReturn.current = true;
                onEdit();
              }}
            >
              <Pencil aria-hidden />
              Edit details
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2" disabled={!job.url} onSelect={copyLink}>
              <Copy aria-hidden />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-2"
              variant="destructive"
              onSelect={() => setConfirmOpen(true)}
            >
              <Trash2 aria-hidden />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!remove.isPending) setConfirmOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this job?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">
                {job.company} · {job.title}
              </span>{" "}
              and its status history will be removed. Linked emails stay in Email activity. This
              can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
            >
              {remove.isPending ? (
                <Loader2 aria-hidden className="animate-spin" />
              ) : (
                <Trash2 aria-hidden />
              )}
              Delete job
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  );
}
