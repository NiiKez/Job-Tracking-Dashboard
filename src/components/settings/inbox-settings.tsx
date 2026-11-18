"use client";

import { CircleAlert, History, Info, Loader2, Mail, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  connectResultToast,
  disconnectResultToast,
  INBOX_STATE_LABEL,
  scanProgressText,
  withoutConnectResult,
  type ToastCopy,
} from "@/components/email/inbox-copy";
import { useRunInboxCheck } from "@/components/email/use-run-inbox-check";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { INBOX_CONNECT_HREF } from "@/lib/api/client";
import { useDisconnectInbox, useScanAgain } from "@/lib/api/hooks";
import { formatDateTime } from "@/lib/format";
import type { Settings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CONTROL_H, SELECT_H, SettingsCard, SettingsNote, SettingsRow } from "./settings-layout";
import { useSaveSettings } from "./use-save-settings";

const INTERVALS = [5, 15, 30, 60];

/** Shows a ToastCopy. A link follows the description, opens in a new tab, and keeps the toast open. */
function showToast(copy: ToastCopy, id?: string) {
  const description = copy.link ? (
    <>
      {copy.description}{" "}
      <a
        href={copy.link.href}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-foreground underline underline-offset-4"
      >
        {copy.link.label}
      </a>
    </>
  ) : (
    copy.description
  );
  toast[copy.kind](copy.title, {
    id,
    description,
    ...(copy.link ? { duration: Infinity, closeButton: true } : {}),
  });
}

/**
 * After Google sends the browser back (/settings?inbox=connected or ?inbox=error&reason=…): one
 * toast with fixed text for the result, then the parameters leave the address bar without a
 * reload, so a reload or a shared link doesn't repeat it.
 */
function useConnectResultToast(inbox: Settings["inbox"]) {
  const { address } = inbox;
  useEffect(() => {
    const url = new URL(window.location.href);
    const copy = connectResultToast(url.searchParams, { address });
    const clean = withoutConnectResult(url);
    // Next keeps useSearchParams in step with history.replaceState.
    if (clean !== null) window.history.replaceState(null, "", clean);
    if (copy) showToast(copy, "inbox-connect");
  }, [address]);
}

export function InboxSettings({ settings }: { settings: Settings }) {
  const { save } = useSaveSettings();
  const check = useRunInboxCheck();
  const disconnect = useDisconnectInbox();
  const scanAgain = useScanAgain();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const inbox = settings.inbox;
  useConnectResultToast(inbox);

  const confirmDisconnect = () => {
    disconnect.mutate(undefined, {
      onSuccess: (res) => {
        setConfirmOpen(false);
        showToast(disconnectResultToast(res));
      },
      onError: (err) => toast.error("Couldn't disconnect the inbox", { description: err.message }),
    });
  };

  const confirmScanAgain = () => {
    scanAgain.mutate(undefined, {
      onSuccess: () => {
        setScanOpen(false);
        toast.success("Scanning the mailbox again", {
          description: "Progress shows under Last synced. New finds land on the board or in Needs review.",
        });
      },
      onError: (err) => {
        setScanOpen(false);
        toast.error("Couldn't start the scan", { description: err.message });
      },
    });
  };
  // A run that is going reads the mailbox already: Scan again waits for it (the server refuses).
  // A scan that is unfinished between runs may be started over.
  const busy = inbox.syncing;

  // Connecting is a full-page trip to Google, so Connect and Reconnect are links. Without the
  // server's Gmail setup the trip can only fail: the button stays, disabled, and the note says why.
  const connectButton = (label: string) =>
    inbox.configured ? (
      <Button asChild className={cn(CONTROL_H, "w-full sm:w-auto")}>
        <a href={INBOX_CONNECT_HREF}>{label}</a>
      </Button>
    ) : (
      <Button className={cn(CONTROL_H, "w-full sm:w-auto")} disabled>
        {label}
      </Button>
    );

  return (
    <SettingsCard>
      {/* Account */}
      <SettingsRow>
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-surface-sunken text-muted-foreground"
          >
            <Mail className="size-4" />
          </span>
          <div className="min-w-0">
            {inbox.address && (
              <p className="truncate text-sm font-medium" title={inbox.address}>
                {inbox.address}
              </p>
            )}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full transition-colors duration-200",
                  inbox.connected ? "bg-muted-foreground/60" : "bg-attention",
                )}
              />
              <span>{INBOX_STATE_LABEL[inbox.state]}</span>
              <span aria-hidden>·</span>
              <span>{inbox.demo ? "Demo mail" : "Gmail"}</span>
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {inbox.state === "not_connected" && connectButton("Connect")}
          {inbox.state === "needs_reconnect" && connectButton("Reconnect")}
          {inbox.state !== "not_connected" && (
            <Button
              variant="outline"
              className={cn(CONTROL_H, "w-full sm:w-auto")}
              onClick={() => setConfirmOpen(true)}
              disabled={disconnect.isPending}
            >
              Disconnect
            </Button>
          )}
        </div>
      </SettingsRow>

      {/* Interval */}
      <SettingsRow>
        <div className="min-w-0">
          <Label htmlFor="inbox-interval">Sync new emails</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            {inbox.connected
              ? "How often new emails are fetched."
              : "Connect the inbox to sync it automatically."}
          </p>
        </div>
        <Select
          value={String(inbox.intervalMinutes)}
          onValueChange={(v) => save({ inbox: { intervalMinutes: Number(v) } })}
          disabled={!inbox.connected}
        >
          <SelectTrigger id="inbox-interval" className={cn(SELECT_H, "w-full sm:w-48")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* Keep a custom value from the API selectable. */}
            {[...new Set([...INTERVALS, inbox.intervalMinutes])]
              .sort((a, b) => a - b)
              .map((m) => (
                <SelectItem key={m} value={String(m)}>
                  Every {m} min
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      {/* Last synced: an exact time, not "yesterday"; then the first scan and the last failure. */}
      <SettingsRow>
        <div className="min-w-0">
          <p className="text-sm font-medium">Last synced</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {inbox.lastCheckedAt ? (
              <time dateTime={inbox.lastCheckedAt} className="tabular">
                {formatDateTime(inbox.lastCheckedAt)}
              </time>
            ) : (
              "Not synced yet"
            )}
          </p>
          {inbox.backfill && (
            <p className="mt-1 text-xs text-muted-foreground tabular">
              {scanProgressText(inbox.backfill)}
            </p>
          )}
          {inbox.lastError && (
            <p className="mt-1 flex gap-1.5 text-xs text-destructive">
              <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
              <span>{inbox.lastError.message}</span>
            </p>
          )}
        </div>
        <Button
          variant="outline"
          className={cn(CONTROL_H, "w-full sm:w-auto")}
          onClick={check.run}
          disabled={check.isPending || !inbox.connected}
        >
          {check.isPending ? (
            <Loader2 aria-hidden className="animate-spin" />
          ) : (
            <RefreshCw aria-hidden />
          )}
          {check.isPending ? "Syncing…" : "Sync now"}
        </Button>
      </SettingsRow>

      {/* Scan again: the whole first-scan window, with the keywords of now. */}
      <SettingsRow>
        <div className="min-w-0">
          <p className="text-sm font-medium">Scan again</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Reads your mail as far back as the first scan did, with the keywords as they are now. Emails already
            filed are skipped.
          </p>
        </div>
        <Button
          variant="outline"
          className={cn(CONTROL_H, "w-full sm:w-auto")}
          onClick={() => setScanOpen(true)}
          disabled={scanAgain.isPending || !inbox.connected || busy}
        >
          {scanAgain.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <History aria-hidden />}
          Scan again
        </Button>
      </SettingsRow>

      {!inbox.configured ? (
        <SettingsNote>
          <Info aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>Gmail isn&apos;t set up on this server yet, so it can&apos;t be connected.</span>
        </SettingsNote>
      ) : inbox.demo ? (
        <SettingsNote>
          <Info aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>Demo mode: syncing reads invented sample emails, not your Gmail.</span>
        </SettingsNote>
      ) : null}

      <AlertDialog
        open={scanOpen}
        onOpenChange={(open) => {
          if (!scanAgain.isPending) setScanOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Scan the mailbox again?</AlertDialogTitle>
            <AlertDialogDescription>
              Every email from the first scan&apos;s period that isn&apos;t filed yet is read again with today&apos;s
              keywords. A confirmation or rejection that was missed can add an application or change its status, as a
              sync would. Emails already filed stay as they are, also ones you dismissed or whose application you
              deleted. A large mailbox can take a few minutes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={scanAgain.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={scanAgain.isPending}
              onClick={(e) => {
                e.preventDefault();
                confirmScanAgain();
              }}
            >
              {scanAgain.isPending && <Loader2 aria-hidden className="animate-spin" />}
              Scan again
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!disconnect.isPending) setConfirmOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect the inbox?</AlertDialogTitle>
            <AlertDialogDescription>
              {inbox.address && !inbox.demo ? (
                <>
                  Syncing stops and the app asks Google to revoke its access to{" "}
                  <span className="font-medium text-foreground">{inbox.address}</span>.
                </>
              ) : (
                "Syncing stops."
              )}{" "}
              Emails already filed stay, and connecting again picks up where it left off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnect.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnect.isPending}
              onClick={(e) => {
                e.preventDefault();
                confirmDisconnect();
              }}
            >
              {disconnect.isPending && <Loader2 aria-hidden className="animate-spin" />}
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  );
}
