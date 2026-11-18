"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useRunInboxCheck } from "@/components/email/use-run-inbox-check";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Header action on /activity. Icon-only below lg (label stays for screen readers). */
export function CheckInboxButton() {
  const { run, isPending, connected } = useRunInboxCheck();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          onClick={run}
          disabled={isPending || !connected}
          aria-busy={isPending || undefined}
          className="size-9 gap-1.5 lg:w-auto lg:px-3"
        >
          {isPending ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : (
            <RefreshCw aria-hidden className="size-4" />
          )}
          <span className="max-lg:sr-only">{isPending ? "Syncing…" : "Sync inbox now"}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="lg:hidden">Sync inbox now</TooltipContent>
    </Tooltip>
  );
}
