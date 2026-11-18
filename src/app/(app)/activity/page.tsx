import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { ActivityFeed, ActivityFeedSkeleton } from "@/components/activity/activity-feed";
import { CheckInboxButton } from "@/components/activity/check-inbox-button";
import { InboxSummary } from "@/components/activity/inbox-summary";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = {
  title: "Email activity",
};

export default function ActivityPage() {
  return (
    <>
      <PageHeader
        title="Email activity"
        description="Every job email from your inbox, and what it changed."
        actions={<CheckInboxButton />}
      />
      <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
        <Suspense fallback={<Skeleton className="h-[42px] w-full rounded-lg" />}>
          <InboxSummary />
        </Suspense>
        {/* useSearchParams (?filter=) needs a Suspense boundary under Cache Components. */}
        <Suspense fallback={<ActivityFeedSkeleton />}>
          <ActivityFeed />
        </Suspense>
      </div>
    </>
  );
}
