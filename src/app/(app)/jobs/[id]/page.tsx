import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { JobDetailSkeleton } from "@/components/job-detail/detail-skeleton";
import { JobDetailView } from "@/components/jobs/job-detail-view";

export const metadata: Metadata = {
  title: "Job details",
};

/** Params are runtime data (no generateStaticParams): read them inside Suspense. */
async function JobDetailFromParams({ params }: { params: PageProps<"/jobs/[id]">["params"] }) {
  const { id } = await params;
  return <JobDetailView jobId={id} variant="page" />;
}

export default function JobPage({ params }: PageProps<"/jobs/[id]">) {
  return (
    <>
      <PageHeader title="Job details" />
      <div className="mx-auto w-full max-w-6xl px-4 pt-3 pb-16 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="-ml-2 mb-3 inline-flex h-10 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors duration-150 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Applications
        </Link>
        <Suspense fallback={<JobDetailSkeleton variant="page" />}>
          <JobDetailFromParams params={params} />
        </Suspense>
      </div>
    </>
  );
}
