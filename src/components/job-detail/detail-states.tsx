"use client";

import { ArrowLeft, Loader2, RotateCw, SearchX, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export function JobNotFound() {
  return (
    <Empty className="border py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="size-10">
          <SearchX aria-hidden className="size-5" />
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold">
          This job doesn&apos;t exist anymore
        </EmptyTitle>
        <EmptyDescription>
          It may have been deleted, or the link is out of date.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline" className="h-10 sm:h-9">
          <Link href="/">
            <ArrowLeft aria-hidden />
            Back to Applications
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function JobLoadError({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <Empty className="border py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="size-10 bg-destructive/10 text-destructive">
          <TriangleAlert aria-hidden className="size-5" />
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold">Couldn&apos;t load this job</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" className="h-10 sm:h-9" onClick={onRetry} disabled={retrying}>
          {retrying ? (
            <Loader2 aria-hidden className="animate-spin" />
          ) : (
            <RotateCw aria-hidden />
          )}
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function JobDeleted() {
  return (
    <p role="status" className="py-10 text-center text-sm text-muted-foreground">
      Job deleted.
    </p>
  );
}
