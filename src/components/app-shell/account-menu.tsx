"use client";

import { ChevronsUpDown, Loader2, LogOut, RotateCcw } from "lucide-react";
import { useId, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { useHydrated } from "@/hooks/use-hydrated";
import { useMe } from "@/lib/api/hooks";
import { initials } from "@/lib/format";
import type { Me } from "@/lib/types";

/** A hairline above the account, under the inbox block. The icon rail shows the avatar alone. */
const FRAME =
  "border-t border-sidebar-border pt-2 group-data-[collapsible=icon]:border-t-0 group-data-[collapsible=icon]:pt-0";

function UserAvatar({ me }: { me: Me }) {
  return (
    <Avatar>
      {me.pictureUrl && <AvatarImage src={me.pictureUrl} alt="" referrerPolicy="no-referrer" />}
      {/* Neutral initials when there is no picture (or while it loads). */}
      <AvatarFallback delayMs={me.pictureUrl ? 600 : undefined} className="text-xs font-semibold">
        {initials(me.name || me.email)}
      </AvatarFallback>
    </Avatar>
  );
}

function Identity({ me }: { me: Me }) {
  return (
    <span className="grid min-w-0 flex-1 text-left leading-tight">
      <span className="truncate text-sm font-medium text-foreground">{me.name || me.email}</span>
      {me.name && <span className="truncate text-xs text-muted-foreground">{me.email}</span>}
    </span>
  );
}

/** Same footprint as the account button: a 48 px row, or the 32 px avatar on the icon rail. */
function AccountSkeleton() {
  return (
    <div
      aria-hidden
      className="flex h-12 items-center gap-2 p-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
    >
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <span className="grid flex-1 gap-1.5 group-data-[collapsible=icon]:hidden">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-3 w-36" />
      </span>
    </div>
  );
}

/** "Sign out": a real form post to /auth/signout, which ends the session and opens /login. */
function SignOutItem() {
  return (
    <form method="post" action="/auth/signout">
      {/* Keep the menu open: closing it would unmount the button mid-submit. */}
      <DropdownMenuItem asChild className="w-full gap-2" onSelect={(e) => e.preventDefault()}>
        <button type="submit">
          <LogOut aria-hidden />
          Sign out
        </button>
      </DropdownMenuItem>
    </form>
  );
}

/**
 * The public demo's two ways out of the workspace, in place of "Sign out":
 *
 *   Start over       opens StartOverDialog: a form post to /auth/demo, which replaces the
 *                    workspace with a fresh one and comes back to /
 *   Leave the demo   the same form post as "Sign out" (/auth/signout), which in the demo deletes
 *                    the workspace at once and opens the demo's entry page. The item says so.
 */
function DemoItems({ onStartOver }: { onStartOver: () => void }) {
  const leaveHint = useId();
  return (
    <>
      <DropdownMenuItem className="gap-2" onSelect={onStartOver}>
        <RotateCcw aria-hidden />
        Start over
      </DropdownMenuItem>
      <form method="post" action="/auth/signout">
        {/* Keep the menu open: closing it would unmount the button mid-submit. */}
        <DropdownMenuItem asChild className="w-full gap-2" onSelect={(e) => e.preventDefault()}>
          <button type="submit" aria-describedby={leaveHint}>
            <LogOut aria-hidden className="mt-0.5 self-start" />
            <span className="grid text-left">
              <span>Leave the demo</span>
              {/* Its description, not part of its name (aria-describedby still reads it). */}
              <span id={leaveHint} aria-hidden className="text-xs text-muted-foreground">
                Deletes this workspace
              </span>
            </span>
          </button>
        </DropdownMenuItem>
      </form>
    </>
  );
}

/**
 * "Start over?" A plain form post to /auth/demo (no body), so the browser follows the server's
 * redirect: to / with a fresh workspace, or to the demo's entry page when the demo is full. The
 * submit button is not an AlertDialogAction: that closes the dialog on click, which would unmount
 * the form before the browser submits it.
 */
function StartOverDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [pending, setPending] = useState(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <form method="post" action="/auth/demo" onSubmit={() => setPending(true)} className="contents">
          <AlertDialogHeader>
            <AlertDialogTitle>Start over?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything you changed in this demo is deleted, and you get a fresh copy of the invented jobs and
              emails.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}
              Start over
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Who is signed in, and "Sign out" (a real form post to /auth/signout). In the public demo
 * (me.demo), "Start over" and "Leave the demo" instead. Hidden when /api/me fails: the rest of
 * the app keeps working.
 */
export function AccountMenu() {
  // Client-fetched: show the skeleton until hydration, like the inbox block.
  const hydrated = useHydrated();
  const { data, isError } = useMe();
  const { isMobile, state } = useSidebar();
  const [startOverOpen, setStartOverOpen] = useState(false);
  if (hydrated && isError) return null;
  const me = hydrated ? data : undefined;
  // On the icon rail the menu opens beside the avatar; otherwise above the full-width button.
  const rail = state === "collapsed" && !isMobile;

  return (
    <SidebarMenu className={FRAME}>
      <SidebarMenuItem>
        {me ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <UserAvatar me={me} />
                <Identity me={me} />
                <ChevronsUpDown aria-hidden className="ml-auto text-muted-foreground" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side={rail ? "right" : "top"}
              align={rail ? "end" : "start"}
              className="min-w-56"
            >
              <DropdownMenuLabel className="flex items-center gap-2 px-1.5 py-1.5 font-normal">
                <UserAvatar me={me} />
                <Identity me={me} />
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {me.demo ? <DemoItems onStartOver={() => setStartOverOpen(true)} /> : <SignOutItem />}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <AccountSkeleton />
        )}
      </SidebarMenuItem>
      {me?.demo && <StartOverDialog open={startOverOpen} onOpenChange={setStartOverOpen} />}
    </SidebarMenu>
  );
}
