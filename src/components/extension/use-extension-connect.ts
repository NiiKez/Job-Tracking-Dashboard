"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { qk, useCreateExtensionKey, useRevokeExtensionKey } from "@/lib/api/hooks";
import { currentBrowserLabel } from "./browser-label";
import { postToExtension, readExtensionMessage } from "./protocol";

/**
 * The connect page's side of the handshake (protocol.ts):
 *
 *   waiting ──"ready"──► ready ──Connect──► connecting ──"connected"──► connected
 *                                              │
 *                                              ├─ no key (refused, or not made within CREATE_TIMEOUT_MS) ──► failed
 *                                              ├─ "failed" from the extension ─────────────────────────────► failed
 *                                              └─ key handed over, no answer within ANSWER_TIMEOUT_MS ─────► unconfirmed
 *   failed ──Try again──► connecting
 *   unconfirmed ──a late "connected"──► connected;  ──a late "failed"──► failed
 *
 * Two timers, one after the other: the first runs from the click until the key is handed to the
 * extension, the second from then until the extension answers.
 *
 * Deleting the key: a key that was never handed over is deleted (also one that arrives after the
 * attempt gave up), and so is one the extension answered "failed" for: it did not keep it. A key
 * that was handed over and got no answer is kept. The extension may have stored it (it answers
 * after storing and checking the key, which can take a slow tracker a while), and deleting it then
 * would disconnect a browser that just connected. The unconfirmed state says how to tell and what
 * to do; a stray key shows in Settings, where it can be revoked.
 *
 * The token lives in one closure: from the answer of POST /api/extension/keys to the "key"
 * message. It is never put into React state, the query cache, the address or storage, and never
 * logged.
 */
export type ConnectState =
  | { phase: "waiting" }
  | { phase: "ready" }
  | { phase: "connecting" }
  | { phase: "connected"; email: string | null }
  | { phase: "unconfirmed" }
  | { phase: "failed"; error: string; settingsLink?: boolean };

/** How long making the key may take (POST /api/extension/keys) before the attempt fails. */
export const CREATE_TIMEOUT_MS = 30_000;

/**
 * How long the page waits for the extension's answer once it has handed over the key. The
 * extension checks the key with one request (GET /api/extension/session, which it gives up on
 * after 15 seconds), stores it and answers.
 */
export const ANSWER_TIMEOUT_MS = 30_000;

/** POST /api/extension/keys answers 409 when the account has this many keys already. */
const MAX_KEYS = 20;

interface Attempt {
  /** The key this attempt made; null until the server answers. */
  keyId: string | null;
  /** The key went to the extension: from now on only the extension's answer may delete it. */
  posted: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

function createFailure(err: unknown): Extract<ConnectState, { phase: "failed" }> {
  if (err instanceof ApiError && err.status === 409) {
    return {
      phase: "failed",
      error: `Your account has ${MAX_KEYS} connected browsers, the most it can have. Revoke one in Settings, then try again.`,
      settingsLink: true,
    };
  }
  const reason = err instanceof Error && err.message ? ` ${err.message}` : "";
  return { phase: "failed", error: `Couldn't make a key for the extension.${reason}` };
}

export function useExtensionConnect() {
  const [state, setState] = useState<ConnectState>({ phase: "waiting" });
  const [version, setVersion] = useState<string | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const qc = useQueryClient();
  const { mutate: createKey } = useCreateExtensionKey();
  const { mutate: revokeKey } = useRevokeExtensionKey();

  /**
   * Ends `current` (once): the next state, and the key deleted again when it failed. Only called
   * for a failure before the key was handed over, or for the extension's own answer.
   */
  const finish = useCallback(
    (current: Attempt, next: ConnectState) => {
      if (attempt.current !== current) return;
      attempt.current = null;
      clearTimeout(current.timer);
      setState(next);
      if (next.phase === "failed" && current.keyId) {
        revokeKey(current.keyId, {
          // Gone already (404) is what was wanted. Otherwise the unused key stays: say where it is.
          onError: (err) => {
            if (err instanceof ApiError && err.status === 404) return;
            setState((s) =>
              s.phase === "failed"
                ? { ...s, error: `${s.error} The unused key couldn't be deleted: revoke it in Settings.`, settingsLink: true }
                : s,
            );
          },
        });
      }
      // The extension revokes the key it had for this tracker before: Settings changes again.
      if (next.phase === "connected") void qc.invalidateQueries({ queryKey: qk.extension });
    },
    [qc, revokeKey],
  );

  const onMessage = useEffectEvent((event: MessageEvent) => {
    const message = readExtensionMessage(event, { window, origin: window.location.origin });
    if (!message) return;
    if (message.type === "ready") {
      setVersion(message.version);
      setState((s) => (s.phase === "waiting" ? { phase: "ready" } : s));
      return;
    }
    // Only an answer to a key this page handed over counts, also after the page stopped waiting.
    const current = attempt.current;
    if (!current?.posted) return;
    if (message.type === "connected") finish(current, { phase: "connected", email: message.email });
    else finish(current, { phase: "failed", error: message.error ?? "The extension couldn't finish connecting." });
  });

  useEffect(() => {
    const listener = (event: MessageEvent) => onMessage(event);
    window.addEventListener("message", listener);
    // The bridge may have said "ready" before this listener existed: ask again.
    postToExtension({ type: "hello" });
    return () => {
      window.removeEventListener("message", listener);
      clearTimeout(attempt.current?.timer);
      attempt.current = null;
    };
  }, []);

  const connect = useCallback(() => {
    if (attempt.current) return;
    const current: Attempt = { keyId: null, posted: false };
    attempt.current = current;
    setState({ phase: "connecting" });
    current.timer = setTimeout(
      () => finish(current, { phase: "failed", error: "Making a key for the extension took too long. Try again." }),
      CREATE_TIMEOUT_MS,
    );
    createKey(
      {
        label: currentBrowserLabel(),
        handOver: ({ key, token }) => {
          // Given up (the timeout) or left (unmounted) while the key was being made: unused, delete it.
          if (attempt.current !== current) {
            revokeKey(key.id);
            return;
          }
          current.keyId = key.id;
          postToExtension({ type: "key", token, keyId: key.id });
          current.posted = true;
          clearTimeout(current.timer);
          // No answer: stop waiting, but keep the key and keep listening (see the header).
          current.timer = setTimeout(() => {
            if (attempt.current === current) setState({ phase: "unconfirmed" });
          }, ANSWER_TIMEOUT_MS);
        },
      },
      {
        onError: (err) => {
          // Once the key went out, the extension's answer decides (see the header).
          if (!current.posted) finish(current, createFailure(err));
        },
      },
    );
  }, [createKey, finish, revokeKey]);

  return { state, version, connect };
}
