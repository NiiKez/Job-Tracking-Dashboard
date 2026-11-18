import type { ExtensionSession, UpsertResult } from "@/lib/types";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createApi, DISCONNECTED_MESSAGE, isDisconnected, isNoAccess } from "../lib/api";
import { hostOf, originPattern } from "../lib/origin";
import { forgetConnection, type Connection } from "../lib/storage";
import type { TargetTab } from "../lib/tab";
import { isNewerVersion } from "../lib/version";
import { DoneScreen } from "./done-screen";
import { JobEditor, type CaptureStatus } from "./job-editor";
import { emptyRead, readJob, type ReadOutcome } from "./read-job";
import { ErrorNotice, Screen, Spinner, useAnnounce } from "./ui";

/*
 * The popup while connected: reading the page (step 2), the form (3), done (4), and the footer
 * (6) with the tracker, the account, Disconnect and the update hint. The key routes' 401 forgets
 * the connection and goes back to step 1 with "This browser was disconnected" (5). Withdrawn site
 * access keeps it: the footer (or the form, when the read met it) offers Allow access.
 */

type Phase =
  | { name: "reading" }
  | { name: "editing"; read: ReadOutcome }
  | { name: "done"; result: UpsertResult; status: CaptureStatus };

const VERSION = chrome.runtime.getManifest().version;

function Footer({
  connection,
  session,
  notice,
  onDisconnect,
  disconnecting,
}: {
  connection: Connection;
  session: ExtensionSession | null;
  /** A problem with the connection itself, above the account. */
  notice: ReactNode;
  onDisconnect: () => void;
  disconnecting: boolean;
}) {
  const host = hostOf(connection.origin);
  const email = session?.email ?? connection.email;
  const latest = session?.latestVersion ?? null;
  return (
    <footer className="footer">
      {notice}
      <div className="footer-row">
        <p className="account" title={`${host} · ${email}`}>
          <span className="account-host">{host}</span>
          <span aria-hidden> · </span>
          <span className="account-email">{email}</span>
        </p>
        <button
          type="button"
          className="button button-ghost button-sm"
          onClick={onDisconnect}
          aria-busy={disconnecting || undefined}
        >
          {disconnecting && <Spinner />}
          Disconnect
        </button>
      </div>
      {isNewerVersion(latest, VERSION) && (
        <p className="update">
          Version {latest} is available in{" "}
          <a href={`${connection.origin}/settings`} target="_blank" rel="noreferrer">
            Settings
          </a>
          .
        </p>
      )}
    </footer>
  );
}

function Reading() {
  return (
    <Screen title="Reading the page">
      <div className="skeleton" aria-hidden>
        <span className="skeleton-label" />
        <span className="skeleton-input" />
        <span className="skeleton-label" />
        <span className="skeleton-input" />
        <span className="skeleton-label" />
        <span className="skeleton-input" />
        <span className="skeleton-label" />
        <span className="skeleton-box" />
      </div>
    </Screen>
  );
}

export function Connected({
  connection,
  tab,
  onDisconnected,
}: {
  connection: Connection;
  tab: TargetTab | null;
  /** The connection is gone; `notice` says why on the Connect screen. */
  onDisconnected: (notice: string) => void;
}) {
  const announce = useAnnounce();
  const api = useMemo(() => createApi(connection), [connection]);
  const [phase, setPhase] = useState<Phase>({ name: "reading" });
  const [session, setSession] = useState<ExtensionSession | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  /** The account check met withdrawn site access (a "no-access" ApiError). */
  const [accessError, setAccessError] = useState<unknown>(null);

  /** A 401: the key was revoked (in Settings, or its account left the allowlist). */
  const lost = useCallback(async () => {
    await forgetConnection(connection.token);
    onDisconnected(DISCONNECTED_MESSAGE);
  }, [connection.token, onDisconnected]);

  // Who this browser saves for, and whether the tracker serves a newer extension. Only a 401 and
  // withdrawn site access matter here; any other failure shows on the read. Withdrawn access is
  // shown here too, because a page that can't be read never asks the tracker.
  const checkSession = useCallback(() => {
    api.session().then(
      (found) => {
        setSession(found);
        setAccessError(null);
      },
      (error: unknown) => {
        if (isDisconnected(error)) void lost();
        else if (isNoAccess(error)) setAccessError(error);
      },
    );
  }, [api, lost]);

  useEffect(checkSession, [checkSession]);

  useEffect(() => {
    let current = true;
    announce("Reading the page");
    readJob(api, tab).then(
      (read) => {
        if (!current) return;
        setPhase({ name: "editing", read });
        if (read.duplicateOf) announce("Page read. It is already in your tracker; saving updates it.");
        else announce(read.notice ? "Fill in the job yourself" : "Page read. Check the details.");
      },
      (error: unknown) => {
        if (!current) return;
        if (isDisconnected(error)) void lost();
        else setPhase({ name: "editing", read: emptyRead(tab, { kind: "failed", error }) });
      },
    );
    return () => {
      current = false;
    };
  }, [api, tab, lost, announce]);

  async function disconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    const host = hostOf(connection.origin);
    let notice = `Disconnected from ${host}.`;
    try {
      await api.revoke();
    } catch (error) {
      // A 401 means the key was revoked already; anything else leaves it valid on the tracker.
      if (!isDisconnected(error)) {
        notice = `Disconnected here, but ${host} couldn't be reached to revoke this browser's key. Revoke it in the tracker's Settings.`;
      }
    }
    await forgetConnection(connection.token);
    // Fails for an origin the manifest requires (the e2e build's <all_urls>); nothing to undo then.
    await chrome.permissions.remove({ origins: [originPattern(connection.origin)] }).catch(() => false);
    onDisconnected(notice);
  }

  /** Asks Chrome for the tracker's site access again (within the click), then checks again. */
  function allowAccess() {
    void api.requestAccess().then((granted) => {
      if (granted) checkSession();
      else announce("Access wasn't allowed");
    });
  }

  // Not while reading (the read may meet the same failure), and not when the form shows it for
  // the read already, with its own Allow access that reads again.
  const readShowsIt =
    phase.name === "editing" && phase.read.notice?.kind === "failed" && isNoAccess(phase.read.notice.error);
  const accessNotice =
    accessError !== null && phase.name !== "reading" && !readShowsIt ? (
      <ErrorNotice error={accessError} onAllowAccess={allowAccess} />
    ) : null;

  return (
    <>
      {phase.name === "reading" && <Reading />}
      {phase.name === "editing" && (
        <JobEditor
          api={api}
          tab={tab}
          read={phase.read}
          onSaved={(result, status) => {
            // Saved, so the tracker can be reached: whatever the account check met is past.
            setAccessError(null);
            setPhase({ name: "done", result, status });
          }}
          onDisconnected={() => void lost()}
        />
      )}
      {phase.name === "done" && <DoneScreen result={phase.result} status={phase.status} origin={connection.origin} />}
      <Footer
        connection={connection}
        session={session}
        notice={accessNotice}
        onDisconnect={disconnect}
        disconnecting={disconnecting}
      />
    </>
  );
}
