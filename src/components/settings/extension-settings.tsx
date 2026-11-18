"use client";

import { Copy, Download, Loader2, Puzzle, RotateCw, Terminal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDemo } from "@/hooks/use-demo";
import { useHydrated } from "@/hooks/use-hydrated";
import { ApiError, EXTENSION_DOWNLOAD_HREF } from "@/lib/api/client";
import { useExtensionOverview, useRevokeExtensionKey } from "@/lib/api/hooks";
import { formatDate, formatDateTime, formatRelative } from "@/lib/format";
import type { ExtensionKey } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CONTROL_H, SettingsCard, SettingsRow } from "./settings-layout";

/** Chrome's extensions page. A page can't link to chrome:// URLs, so it is shown to copy. */
const EXTENSIONS_PAGE = "chrome://extensions";

const BUILD_COMMAND = "npm run build:extension";

/** Inline code: a command or an address to type. */
function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded border bg-surface-sunken px-1.5 py-0.5 font-mono text-xs break-all text-foreground">
      {children}
    </code>
  );
}

/**
 * Settings, Chrome extension. In the public demo (me.demo) an info card instead, and no request
 * to /api/extension: the demo switches the extension off, and its routes answer 403. Until
 * /api/me has answered, the skeleton, so the demo never asks and the real app never shows the card.
 */
export function ExtensionSettings() {
  const { settled, demo } = useDemo();
  if (demo) return <NotInDemo />;
  if (!settled) return <ExtensionSkeleton />;
  return <ExtensionPanel />;
}

/** What the demo shows in place of the extension's settings. */
function NotInDemo() {
  return (
    <SettingsCard>
      <div className="flex min-w-0 items-start gap-3 px-4 py-4">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-surface-sunken text-muted-foreground"
        >
          <Puzzle className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium">The Chrome extension isn&apos;t available in the demo.</p>
          <p className="mt-1 text-xs text-pretty text-muted-foreground">
            In your own copy of the app you install it from here and connect it once. Its popup then fills in the job
            from the page you&apos;re on.
          </p>
        </div>
      </div>
    </SettingsCard>
  );
}

function ExtensionPanel() {
  const query = useExtensionOverview();
  const hydrated = useHydrated();
  const overview = hydrated ? query.data : undefined;

  if (hydrated && query.isError && !overview) {
    return (
      <SettingsCard>
        <div className="flex flex-col items-start gap-3 px-4 py-6">
          <p className="text-sm">Couldn’t load the extension’s settings.</p>
          <p className="text-xs text-muted-foreground">{query.error.message}</p>
          <Button variant="outline" className={CONTROL_H} onClick={() => query.refetch()}>
            <RotateCw aria-hidden />
            Try again
          </Button>
        </div>
      </SettingsCard>
    );
  }
  if (!overview) return <ExtensionSkeleton />;

  return (
    <div className="flex flex-col gap-6">
      <Install version={overview.version} />
      <ConnectedBrowsers keys={overview.keys} />
    </div>
  );
}

/* ------------------------------------------------------------------ install */

function Install({ version }: { version: string | null }) {
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(EXTENSIONS_PAGE);
      toast.success("Address copied", { description: `Paste ${EXTENSIONS_PAGE} into the address bar.` });
    } catch {
      toast.error("Couldn't copy the address", { description: "Your browser blocked the clipboard." });
    }
  };

  return (
    <SettingsCard>
      {version ? (
        <SettingsRow>
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-surface-sunken text-muted-foreground"
            >
              <Puzzle className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">Job Tracker extension</p>
              <p className="text-xs text-muted-foreground">
                Version <span className="tabular">{version}</span> · Chrome 120 or newer, Edge and Brave too
              </p>
            </div>
          </div>
          <Button asChild className={cn(CONTROL_H, "w-full sm:w-auto")}>
            {/* A plain link: the browser downloads the zip with the session cookie. */}
            <a href={EXTENSION_DOWNLOAD_HREF} download>
              <Download aria-hidden />
              Download
            </a>
          </Button>
        </SettingsRow>
      ) : (
        <div className="flex min-w-0 items-start gap-3 px-4 py-4">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-surface-sunken text-muted-foreground"
          >
            <Terminal className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">This server has no build of the extension</p>
            <p className="mt-1 text-xs text-pretty text-muted-foreground">
              A deployed release always has one: deploy it again. In development, build it with{" "}
              <Code>{BUILD_COMMAND}</Code>, then reload this page.
            </p>
          </div>
        </div>
      )}

      <div className="px-4 py-4">
        <p id="extension-install-title" className="text-sm font-medium">
          Install it
        </p>
        <ol aria-labelledby="extension-install-title" className="mt-3 flex flex-col gap-3 text-sm [counter-reset:step]">
          <Step>Unzip the download.</Step>
          <Step>
            Open <Code>{EXTENSIONS_PAGE}</Code>
            <Button
              variant="ghost"
              size="icon-xs"
              className="mx-0.5 -my-1 align-middle text-muted-foreground pointer-coarse:size-8"
              onClick={copyAddress}
              aria-label={`Copy ${EXTENSIONS_PAGE}`}
              title="Copy"
            >
              <Copy aria-hidden />
            </Button>{" "}
            in a new tab and turn on <span className="font-medium">Developer mode</span>, top right.
          </Step>
          <Step>
            Click <span className="font-medium">Load unpacked</span> and pick the unzipped folder.
          </Step>
          <Step>
            Pin the extension to the toolbar. Then, on this page, click its icon and choose{" "}
            <span className="font-medium">Connect</span>.
          </Step>
        </ol>
        {/* An unpacked extension's id comes from its folder: a new folder would install a second,
            unconnected copy, so an update goes into the same one. */}
        <p className="mt-4 text-xs text-pretty text-muted-foreground">
          To update it, unzip the new download over the same folder, replacing its files, then click the reload icon on
          the extension in <Code>{EXTENSIONS_PAGE}</Code>. It stays connected. Loading it from another folder would add
          a second copy that isn’t connected.
        </p>
      </div>
    </SettingsCard>
  );
}

/** One numbered step. The number is a CSS counter: the list's own numbering, not text in the item. */
function Step({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3 [counter-increment:step] before:flex before:size-5 before:shrink-0 before:items-center before:justify-center before:rounded-full before:border before:border-border before:text-[11px] before:font-medium before:text-muted-foreground before:tabular-nums before:content-[counter(step)]">
      <span className="min-w-0 pt-px text-pretty">{children}</span>
    </li>
  );
}

/* --------------------------------------------------------- connected browsers */

function ConnectedBrowsers({ keys }: { keys: ExtensionKey[] }) {
  const revoke = useRevokeExtensionKey();
  const [target, setTarget] = useState<ExtensionKey | null>(null);
  // Kept while the dialog closes, so its text doesn't change during the animation.
  const [shown, setShown] = useState<ExtensionKey | null>(null);

  const open = (key: ExtensionKey) => {
    setTarget(key);
    setShown(key);
  };

  const confirmRevoke = () => {
    if (!target) return;
    const { id, label } = target;
    const done = () => {
      setTarget(null);
      toast.success("Extension revoked", { description: label });
    };
    revoke.mutate(id, {
      onSuccess: done,
      onError: (err) => {
        // Revoked meanwhile (another tab, or Disconnect in the extension): what was asked for holds.
        if (err instanceof ApiError && err.status === 404) return done();
        toast.error("Couldn't revoke the extension", { description: err.message });
      },
    });
  };

  return (
    <section aria-labelledby="extension-browsers-title" className="flex flex-col gap-3">
      <h3 id="extension-browsers-title" className="text-sm font-medium">
        Connected browsers
      </h3>
      <SettingsCard>
        {keys.length === 0 ? (
          <p className="px-4 py-4 text-sm text-pretty text-muted-foreground">
            Browsers you connect the extension in show up here, with when each one was last used.
          </p>
        ) : (
          <ul className="divide-y">
            {keys.map((key) => (
              <li key={key.id}>
                <SettingsRow>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium" title={key.label}>
                      {key.label}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground tabular">
                      Connected{" "}
                      <time dateTime={key.createdAt} title={formatDateTime(key.createdAt)}>
                        {formatDate(key.createdAt)}
                      </time>
                      <span aria-hidden> · </span>
                      {key.lastUsedAt ? <LastUsed iso={key.lastUsedAt} /> : "Not used yet"}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    className={cn(CONTROL_H, "w-full sm:w-auto")}
                    onClick={() => open(key)}
                    aria-label={`Revoke ${key.label}`}
                    disabled={revoke.isPending && revoke.variables === key.id}
                  >
                    Revoke
                  </Button>
                </SettingsRow>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>

      <AlertDialog
        open={target !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !revoke.isPending) setTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this browser?</AlertDialogTitle>
            <AlertDialogDescription>
              The extension in <span className="font-medium text-foreground">{shown?.label}</span> stops working until
              you connect it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoke.isPending}
              onClick={(e) => {
                e.preventDefault();
                confirmRevoke();
              }}
            >
              {revoke.isPending && <Loader2 aria-hidden className="animate-spin" />}
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** "Last used 5m ago", "Last used yesterday", "Last used 2 Nov"; the exact time as a tooltip. */
function LastUsed({ iso }: { iso: string }) {
  const relative = formatRelative(iso);
  return (
    <>
      Last used{" "}
      <time dateTime={iso} title={formatDateTime(iso)}>
        {/^(Just now|Yesterday)$/.test(relative) ? relative.toLowerCase() : relative}
      </time>
    </>
  );
}

/* ------------------------------------------------------------------ loading */

function ExtensionSkeleton() {
  return (
    <div aria-busy aria-label="Loading the extension’s settings" className="flex flex-col gap-6">
      <SettingsCard>
        <div className="flex items-center justify-between gap-6 px-4 py-4">
          <div className="flex flex-1 items-center gap-3">
            <Skeleton className="size-9 shrink-0 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-64 max-w-full" />
            </div>
          </div>
          <Skeleton className="h-9 w-28 shrink-0" />
        </div>
        <div className="flex flex-col gap-3 px-4 py-4">
          <Skeleton className="h-4 w-20" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-4 w-full max-w-md" />
          ))}
        </div>
      </SettingsCard>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-36" />
        <SettingsCard>
          <div className="flex items-center justify-between gap-6 px-4 py-4">
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-52 max-w-full" />
            </div>
            <Skeleton className="h-9 w-20 shrink-0" />
          </div>
        </SettingsCard>
      </div>
    </div>
  );
}
