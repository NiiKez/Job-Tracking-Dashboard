import type { Metadata } from "next";
import { Suspense } from "react";
import { Dashboard } from "@/components/dashboard/dashboard";
import { DashboardSkeleton } from "@/components/dashboard/dashboard-skeleton";

export const metadata: Metadata = { title: "Applications" };

export default function Page() {
  return (
    // The dashboard reads filters from the URL (useSearchParams).
    <Suspense fallback={<DashboardSkeleton />}>
      <Dashboard />
    </Suspense>
  );
}
