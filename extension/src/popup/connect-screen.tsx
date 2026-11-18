import { CircleAlert, ExternalLink, Info } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { isConnectReply, type ConnectRequest } from "../lib/messages";
import { hostOf, normalizeOrigin, originPattern } from "../lib/origin";
import { Screen, Spinner, useAnnounce } from "./ui";

/*
 * Step 1 of the popup: not connected. The address is the one connected last, else the open
 * tab's when that tab looks like the tracker (App works that out). Connect asks Chrome for access to that
 * one origin, and the service worker opens the tracker's connect page, where the user confirms;
 * the page hands this browser its own key (lib/connect.ts). The popup usually closes as the tab
 * opens; when it stays (opened as a page), it moves on by itself once the key is stored.
 *
 * While Chrome is asked, Connect takes no second click: each would send the service worker
 * another Connect. Once that is answered, Connect starts over (the tab was closed, say).
 */

export function ConnectScreen({
  suggested,
  notice,
  onConnected,
}: {
  suggested: string;
  /** Why the popup is here again: "This browser was disconnected. Connect again." */
  notice: string | null;
  onConnected: () => void;
}) {
  const announce = useAnnounce();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState(suggested);
  const [error, setError] = useState<string | null>(null);
  /** The origin being connected: "asking" while Chrome asks for access, "opened" once the tab is up. */
  const [progress, setProgress] = useState<{ step: "asking" | "opened"; origin: string } | null>(null);
  /** True while the step is "asking"; a ref, so a second submit before the next render sees it too. */
  const asking = useRef(false);

  useEffect(() => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes.connection?.newValue) onConnected();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [onConnected]);

  // A live region reads out a change of its text, not the text it appears with, and the address
  // field takes the focus as the screen opens: the notice is said through the popup's own region.
  useEffect(() => {
    if (notice) announce(notice);
  }, [notice, announce]);

  function fail(message: string) {
    asking.current = false;
    setProgress(null);
    setError(message);
    input.current?.focus();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (asking.current) return;
    const checked = normalizeOrigin(address);
    if (!checked.ok) return fail(checked.error);
    const { origin } = checked;
    const host = hostOf(origin);
    setAddress(origin);
    setError(null);

    // Both start inside the click: Chrome asks for a permission only during one, and its prompt
    // can close the popup, so the service worker hears of the Connect first and waits for the answer.
    const request: ConnectRequest = { type: "connect", origin };
    const reply: Promise<unknown> = chrome.runtime.sendMessage(request);
    const granted = chrome.permissions.request({ origins: [originPattern(origin)] });
    asking.current = true;
    setProgress({ step: "asking", origin });
    announce(`Connecting to ${host}`);

    Promise.all([granted, reply]).then(
      ([allowed, answer]) => {
        if (!allowed) return fail(`Connect needs access to ${host}. Click Connect again and choose Allow.`);
        if (!isConnectReply(answer)) return fail("The extension didn't answer. Try again.");
        if (!answer.ok) return fail(answer.error);
        asking.current = false;
        setProgress({ step: "opened", origin });
        announce(`Confirm on ${host} in the new tab`);
      },
      () => fail(`Chrome couldn't ask for access to ${host}. Try again.`),
    );
  }

  return (
    <Screen title="Connect to your Job Tracker">
      <form noValidate className="connect-form" onSubmit={onSubmit}>
        {notice && (
          <div className="notice">
            <Info aria-hidden />
            <p>{notice}</p>
          </div>
        )}
        <p className="lead">
          Enter your tracker&apos;s address. You confirm on its page, and this browser gets its own key.
        </p>
        <div className="field">
          <label htmlFor={id}>Tracker address</label>
          <input
            ref={input}
            id={id}
            type="url"
            inputMode="url"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="https://tracker.example.com"
            autoComplete="url"
            spellCheck={false}
            autoFocus
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : `${id}-help`}
          />
          {error ? (
            <p id={`${id}-error`} className="hint hint-error" role="alert">
              <CircleAlert aria-hidden />
              {error}
            </p>
          ) : (
            <p id={`${id}-help`} className="hint">
              https, or http for localhost and 127.0.0.1.
            </p>
          )}
        </div>
        {/* aria-disabled, not disabled: the button keeps the focus a click or Enter gave it. */}
        <button
          type="submit"
          className="button button-primary button-block"
          aria-busy={!!progress || undefined}
          aria-disabled={progress?.step === "asking" || undefined}
        >
          {progress ? <Spinner /> : <ExternalLink aria-hidden />}
          Connect
        </button>
        {progress?.step === "asking" && <p className="hint">Connecting to {hostOf(progress.origin)}…</p>}
        {progress?.step === "opened" && (
          <p className="hint">
            Confirm on {hostOf(progress.origin)} in the tab that opened. If you&apos;re signed out, sign in
            there first.
          </p>
        )}
      </form>
    </Screen>
  );
}
