import "server-only";
import { getEnv } from "@/lib/server/env";
import { getRefreshToken } from "../connection";
import { connectionAccessTokens } from "../oauth/google-tokens";
import { createPacer, type PacerOptions } from "../sync/pace";
import { createFixtureSource } from "./fixture-source";
import { createGmailSource } from "./gmail-source";
import type { MailSource } from "./types";

/**
 * The mail source for one connection, chosen by MAIL_SOURCE (read on every call, never at import
 * time):
 *
 *   fixture  the demo mail in fixtures/mail (development, tests, CI). Its mailbox address is the
 *            connection's, so "mail from the own address" means the same as with Gmail.
 *   gmail    the Gmail REST API (gmail-source.ts) with:
 *            - the connection's access-token cache (oauth/google-tokens.ts), kept across runs and
 *              dropped when the stored token changes; a refresh reads and decrypts the stored
 *              refresh token (connection.ts getRefreshToken);
 *            - a new pacer per call, i.e. per run: Gmail's quota is per mailbox, and runs of one
 *              mailbox never overlap (the lease and the in-process registry, sync/engine.ts).
 *
 * `signal` ends the run (abortSync, stopAllSyncs, a lost lease): the Gmail source stops its waits
 * and requests with it; the engine also checks it between messages.
 */
export interface MailSourceFor {
  userId: string;
  emailAddress: string;
}

export interface MailSourceOptions {
  signal?: AbortSignal;
  /** The clock the fixture source moves its dates by (default: the system clock). */
  now?: () => Date;
  /** Test seam: the Gmail pacer's options (its clock and its waits). */
  pace?: PacerOptions;
}

export function createMailSource(conn: MailSourceFor, opts: MailSourceOptions = {}): MailSource {
  if (getEnv().mailSource === "fixture") {
    return createFixtureSource({ emailAddress: conn.emailAddress, now: opts.now });
  }
  const { userId } = conn;
  return createGmailSource({
    accessTokens: connectionAccessTokens(userId, () => getRefreshToken(userId)),
    pacer: createPacer(opts.pace),
    signal: opts.signal,
  });
}
