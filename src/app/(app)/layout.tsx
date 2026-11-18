import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { AddJobProvider } from "@/components/jobs/add-job-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

/**
 * The signed-in app: sidebar and page panel. The "Add job" dialog and its "N"
 * shortcut live here too, so they don't exist on /login.
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <AddJobProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">{children}</SidebarInset>
      </SidebarProvider>
    </AddJobProvider>
  );
}
