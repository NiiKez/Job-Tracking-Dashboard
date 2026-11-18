"use client";

import {
  Briefcase,
  Inbox,
  LayoutGrid,
  Loader2,
  MailSearch,
  RefreshCw,
  Settings,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { AccountMenu } from "@/components/app-shell/account-menu";
import { INBOX_STATE_LABEL } from "@/components/email/inbox-copy";
import { useRunInboxCheck } from "@/components/email/use-run-inbox-check";
import { useHydrated } from "@/hooks/use-hydrated";
import { INBOX_CONNECT_HREF } from "@/lib/api/client";
import { useSettings, useStats } from "@/lib/api/hooks";
import { formatDateTime } from "@/lib/format";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: "review";
}

/* Four destinations need no section labels. */
const NAV: NavItem[] = [
  { href: "/", label: "Applications", icon: LayoutGrid },
  { href: "/review", label: "Needs review", icon: Inbox, badge: "review" },
  { href: "/activity", label: "Email activity", icon: MailSearch },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string | null, href: string) {
  if (!pathname) return false;
  if (href === "/") return pathname === "/" || pathname.startsWith("/jobs/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavMenu({ pathname }: { pathname: string | null }) {
  const { data: stats } = useStats();
  // Badge counts come from client-fetched data: render them only after hydration.
  const hydrated = useHydrated();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {NAV.map((item) => {
            const count = hydrated && item.badge === "review" ? stats?.reviewCount : undefined;
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                  asChild
                  isActive={isActive(pathname, item.href)}
                  tooltip={item.label}
                  className="h-9"
                >
                  <Link href={item.href} onClick={() => setOpenMobile(false)}>
                    <item.icon aria-hidden />
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
                {!!count && (
                  <SidebarMenuBadge
                    className="top-2 rounded-full bg-attention-subtle text-attention tabular peer-data-[active=true]/menu-button:text-attention"
                    aria-label={`${count} ${count === 1 ? "email" : "emails"} to match`}
                  >
                    {count}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function ActiveNavMenu() {
  const pathname = usePathname();
  return <NavMenu pathname={pathname} />;
}

/** Which inbox is read and when it was last synced — an exact time, not "yesterday". */
function InboxStatus() {
  const hydrated = useHydrated();
  const { data } = useSettings();
  const settings = hydrated ? data : undefined;
  const check = useRunInboxCheck();
  const inbox = settings?.inbox;

  return (
    <div className="flex flex-col gap-0.5 px-2 pb-1 text-xs group-data-[collapsible=icon]:hidden">
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        {inbox && !inbox.connected && (
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention" />
        )}
        {inbox ? `Inbox ${INBOX_STATE_LABEL[inbox.state].toLowerCase()}` : "Inbox"}
      </p>
      {/* No address before the first connection: name the kind of inbox instead. */}
      <p className="truncate text-muted-foreground">
        {inbox ? (inbox.address ?? (inbox.demo ? "Demo mail" : "Gmail")) : "…"}
      </p>
      <p className="text-muted-foreground tabular">
        {inbox?.lastCheckedAt ? `Last synced ${formatDateTime(inbox.lastCheckedAt)}` : "Not synced yet"}
      </p>
      {inbox?.state === "needs_reconnect" && inbox.configured ? (
        // Google no longer accepts the stored access: the one action that helps is the trip to Google.
        <Button asChild size="sm" className="mt-2 h-8 w-full">
          <a href={INBOX_CONNECT_HREF}>Reconnect</a>
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-8 w-full gap-1.5"
          onClick={check.run}
          disabled={check.isPending || !inbox?.connected}
        >
          {check.isPending ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw aria-hidden className="size-3.5" />
          )}
          {check.isPending ? "Syncing…" : "Sync now"}
        </Button>
      )}
    </div>
  );
}

export function AppSidebar() {
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="hover:bg-transparent">
              <Link href="/">
                <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Briefcase aria-hidden className="size-4" />
                </span>
                <span className="truncate text-sm font-semibold text-foreground">Job Tracker</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {/* usePathname suspends on dynamic routes (/jobs/[id]) under Cache Components. */}
        <Suspense fallback={<NavMenu pathname={null} />}>
          <ActiveNavMenu />
        </Suspense>
      </SidebarContent>
      <SidebarFooter>
        <InboxStatus />
        <AccountMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
