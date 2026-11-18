"use client";

import { useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { JobDetailView } from "@/components/jobs/job-detail-view";

/**
 * Right-hand sheet for `?job=<id>`. Keeps rendering the last job while the
 * close animation runs, so the content doesn't blank out mid-slide.
 */
export function JobSheet({ jobId, onClose }: { jobId: string | null; onClose: () => void }) {
  const [shownId, setShownId] = useState(jobId);
  if (jobId && jobId !== shownId) setShownId(jobId);
  // There's no SheetTrigger (the URL opens it), so remember who had focus and
  // hand it back on close — the card or row the user came from.
  const opener = useRef<HTMLElement | null>(null);

  return (
    <Sheet open={!!jobId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        // Match SheetContent's own `data-[side=right]:` variants so these win.
        className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        onOpenAutoFocus={() => {
          const el = document.activeElement;
          opener.current = el instanceof HTMLElement && el !== document.body ? el : null;
        }}
        onCloseAutoFocus={(e) => {
          const el = opener.current;
          opener.current = null;
          if (el?.isConnected) {
            e.preventDefault();
            el.focus({ preventScroll: true });
          }
        }}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Job details</SheetTitle>
          <SheetDescription>
            Description, link to the posting, status history and linked emails.
          </SheetDescription>
        </SheetHeader>
        {shownId && <JobDetailView jobId={shownId} variant="sheet" onDeleted={onClose} />}
      </SheetContent>
    </Sheet>
  );
}
