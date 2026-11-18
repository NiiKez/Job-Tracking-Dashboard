import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { ReviewList, ReviewListSkeleton } from "@/components/review/review-list";

export const metadata: Metadata = {
  title: "Needs review",
};

export default function ReviewPage() {
  return (
    <>
      <PageHeader
        title="Needs review"
        description="Emails that matched no job, several jobs, or no status. Pick the job and status for each."
      />
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <Suspense fallback={<ReviewListSkeleton />}>
          <ReviewList />
        </Suspense>
      </div>
    </>
  );
}
