"use client";

import { Briefcase, Check, CircleAlert, Loader2 } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/hooks/use-hydrated";
import { cn } from "@/lib/utils";
import { currentBrowserLabel } from "./browser-label";
import { useExtensionConnect, type ConnectState } from "./use-extension-connect";

/** Settings, Chrome extension: the download, the steps and the connected browsers. */
const SETTINGS_HREF = "/settings#extension";

const BUTTON = "h-10 md:h-9";

const linkClass =
  "rounded-sm font-medium text-foreground underline underline-offset-4 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";

/** What a connected extension can do with its key: the extension's routes only. */
const ABILITIES = [
  "Read the job page you’re on, when you click its icon",
  "Save jobs to your tracker as Saved or Applied",
  "Tell you when a job is already in your tracker",
];

/**
 * /extension/connect: the extension opens this page from its popup's Connect; the user confirms
 * here, and the page hands the extension a key of its own (use-extension-connect.ts).
 */
export function ConnectView() {
  const { state, version, connect } = useExtensionConnect();
  const hydrated = useHydrated();
  // The browser's name is known in the browser only; the server renders the waiting state.
  const label = useMemo(() => (hydrated ? currentBrowserLabel() : null), [hydrated]);

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 px-4 py-12">
      <div className="w-full max-w-md rounded-xl border bg-card p-6">
        <div className="flex items-center gap-2">
          <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Briefcase aria-hidden className="size-4" />
          </span>
          <span className="text-sm font-semibold text-foreground">Job Tracker</span>
        </div>
        <Body state={state} version={version} label={label} onConnect={connect} />
      </div>
    </main>
  );
}

function Body({
  state,
  version,
  label,
  onConnect,
}: {
  state: ConnectState;
  version: string | null;
  label: string | null;
  onConnect: () => void;
}) {
  if (state.phase === "connected") {
    return (
      <>
        <h1 className="mt-6 flex items-center gap-2 text-section font-semibold">
          <Check aria-hidden className="size-5 shrink-0" />
          Extension connected
        </h1>
        <p role="status" className="mt-1 text-sm text-pretty text-muted-foreground">
          {state.email ? (
            <>
              Connected as <span className="font-medium break-all text-foreground">{state.email}</span>.
            </>
          ) : (
            "Connected."
          )}{" "}
          You can close this tab.
        </p>
        <p className="mt-6 border-t pt-4 text-meta text-muted-foreground">
          Connected browsers are listed in{" "}
          <Link href={SETTINGS_HREF} className={linkClass}>
            Settings
          </Link>
          , where you can revoke them.
        </p>
      </>
    );
  }

  if (state.phase === "unconfirmed") {
    return (
      <>
        <h1 className="mt-6 text-section font-semibold">The extension didn’t confirm</h1>
        <div role="status" className="mt-1 text-sm text-pretty text-muted-foreground">
          <p>
            It got its key but didn’t say whether it kept it. Open the extension from your browser’s toolbar to check:
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-foreground">
            <li className="flex gap-2">
              <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>If it offers to save the page as a job, it’s connected. You can close this tab.</span>
            </li>
            <li className="flex gap-2">
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                If it asks you to connect, revoke this browser in{" "}
                <Link href={SETTINGS_HREF} className={linkClass}>
                  Settings, under Chrome extension
                </Link>
                , then connect again.
              </span>
            </li>
          </ul>
        </div>
        <Actions>
          <Button asChild variant="outline" className={BUTTON}>
            <Link href={SETTINGS_HREF}>Open Settings</Link>
          </Button>
        </Actions>
      </>
    );
  }

  if (state.phase === "failed") {
    return (
      <>
        <h1 className="mt-6 text-section font-semibold">Couldn’t connect the extension</h1>
        <p role="alert" className="mt-3 flex gap-2 text-meta text-destructive">
          <CircleAlert aria-hidden className="mt-px size-4 shrink-0" />
          <span className="min-w-0 break-words">{state.error}</span>
        </p>
        {state.settingsLink && (
          <p className="mt-2 text-meta text-muted-foreground">
            <Link href={SETTINGS_HREF} className={linkClass}>
              Open Settings
            </Link>
          </p>
        )}
        <Actions>
          <Button className={BUTTON} onClick={onConnect}>
            Try again
          </Button>
          <CancelButton />
        </Actions>
      </>
    );
  }

  const found = state.phase !== "waiting";
  const connecting = state.phase === "connecting";
  return (
    <>
      <h1 className="mt-6 text-section font-semibold">Connect the extension</h1>
      {found ? (
        <>
          <p className="mt-1 text-sm text-pretty text-muted-foreground">
            The extension in <span className="font-medium text-foreground">{label}</span> will be able to:
          </p>
          <ul className="mt-3 flex flex-col gap-1.5 text-sm">
            {ABILITIES.map((ability) => (
              <li key={ability} className="flex gap-2">
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span>{ability}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-meta text-pretty text-muted-foreground">
            It can’t read your mail or change your settings. You can revoke it in Settings at any time.
          </p>
        </>
      ) : (
        <p className="mt-1 text-sm text-pretty text-muted-foreground">
          Open the Job Tracker extension from your browser’s toolbar and click Connect. It brings you to this page to
          confirm.
        </p>
      )}

      <p
        role="status"
        className={cn(
          "mt-4 flex items-center gap-2 text-xs text-muted-foreground",
          // Keeps the line's height while the text changes.
          "min-h-4",
        )}
      >
        {found ? (
          <>
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground/60" />
            {version ? (
              <span>
                Extension <span className="tabular">{version}</span> is ready
              </span>
            ) : (
              <span>The extension is ready</span>
            )}
          </>
        ) : (
          <>
            <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
            <span>Waiting for the extension…</span>
          </>
        )}
      </p>

      <Actions>
        <Button className={BUTTON} onClick={onConnect} disabled={!found || connecting}>
          {connecting && <Loader2 aria-hidden className="animate-spin" />}
          {connecting ? "Connecting…" : "Connect"}
        </Button>
        <CancelButton disabled={connecting} />
      </Actions>

      {!found && (
        <p className="mt-6 border-t pt-4 text-meta text-pretty text-muted-foreground">
          Not installed yet? Download it in{" "}
          <Link href={SETTINGS_HREF} className={linkClass}>
            Settings, under Chrome extension
          </Link>
          .
        </p>
      )}
    </>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse sm:justify-start">{children}</div>;
}

/** Back to the dashboard. While connecting it waits: the key is on its way to the extension. */
function CancelButton({ disabled = false }: { disabled?: boolean }) {
  if (disabled) {
    return (
      <Button variant="outline" className={BUTTON} disabled>
        Cancel
      </Button>
    );
  }
  return (
    <Button asChild variant="outline" className={BUTTON}>
      <Link href="/">Cancel</Link>
    </Button>
  );
}
