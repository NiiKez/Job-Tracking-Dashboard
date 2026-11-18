import { Briefcase, CircleAlert, LoaderCircle, LockOpen, RefreshCw } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { ApiError, failureMessage } from "../lib/api";

/*
 * The popup's few building blocks, styled by popup.css on the app's tokens (DESIGN.md): the
 * screen frame with the brand mark, the error notice, and the live region that reads state
 * changes aloud.
 */

/** The sidebar's brand mark: a briefcase on a primary square. */
function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden>
      <Briefcase />
    </span>
  );
}

/** The brand mark with the screen's heading. */
export function ScreenHeader({ title }: { title?: string }) {
  return (
    <header className="screen-header">
      <BrandMark />
      {title && <h1>{title}</h1>}
    </header>
  );
}

/** One screen: its heading, then its content, which scrolls when the popup runs out of height. */
export function Screen({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <>
      <ScreenHeader title={title} />
      <main className="screen-body">{children}</main>
    </>
  );
}

export function Spinner() {
  return <LoaderCircle aria-hidden className="spinner" />;
}

/**
 * A failure and the way on: Try again when it may pass (ApiError "retryable"), Allow access when
 * the tracker's site access was withdrawn ("no-access"). `onAllowAccess` must ask Chrome straight
 * away (Api.requestAccess): Chrome shows its prompt only within the click.
 */
export function ErrorNotice({
  error,
  detail,
  onRetry,
  onAllowAccess,
  retrying,
}: {
  error: unknown;
  detail?: string;
  onRetry?: () => void;
  onAllowAccess?: () => void;
  retrying?: boolean;
}) {
  const kind = error instanceof ApiError ? error.kind : null;
  return (
    <div className="notice notice-error" role="alert">
      <CircleAlert aria-hidden />
      <div className="notice-content">
        <p>{failureMessage(error)}</p>
        {detail && <p className="notice-detail">{detail}</p>}
        {kind === "retryable" && onRetry && (
          <button
            type="button"
            className="button button-outline button-sm"
            onClick={onRetry}
            aria-busy={retrying || undefined}
          >
            {retrying ? <Spinner /> : <RefreshCw aria-hidden />}
            Try again
          </button>
        )}
        {kind === "no-access" && onAllowAccess && (
          <button
            type="button"
            className="button button-outline button-sm"
            onClick={onAllowAccess}
            aria-busy={retrying || undefined}
          >
            {retrying ? <Spinner /> : <LockOpen aria-hidden />}
            Allow access
          </button>
        )}
      </div>
    </div>
  );
}

/** "Ctrl" or "⌘" for the shortcut hints. */
export const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

/* ------------------------------------------------------------------ announcements */

/**
 * Says a change aloud through the popup's one polite live region (App renders it), for changes
 * that move no focus: "Reading the page", "Saving". Errors use role="alert" where they appear.
 */
export const AnnounceContext = createContext<(message: string) => void>(() => {});

export function useAnnounce() {
  return useContext(AnnounceContext);
}
