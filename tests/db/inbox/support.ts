// Shared by the inbox database tests (inside a describeDb block only). Invented people,
// companies and addresses.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { getDb, withTx } from "@/lib/server/db/client";
import { resetEnvForTests } from "@/lib/server/env";
import { ensureDemoConnection } from "@/lib/server/inbox/repo";
import { createFixtureSource, type FixtureSourceOptions } from "@/lib/server/inbox/source/fixture-source";
import type { GmailMessage, MailSource } from "@/lib/server/inbox/source/types";
import { runSync, type RunOptions, type SyncResult } from "@/lib/server/inbox/sync/engine";
import { listEmails } from "@/lib/server/services/emails";
import { listAllJobs } from "@/lib/server/services/jobs";
import { seedUser } from "../../../db/seed/seed";
import { createUser } from "../../helpers/factories";
import { testSql } from "../../helpers/test-db";

/** The fixed "now" of the seed, the fixture source and the engine: Friday 13 November 2026, noon UTC. */
export const NOW = new Date(Date.UTC(2026, 10, 13, 12));
export const DAY = 86_400_000;

const MAIL_DIR = path.resolve(import.meta.dirname, "../../../fixtures/mail");

/**
 * The scan windows (INBOX_BACKFILL_DAYS) the window-sensitive tests run with: the code's default,
 * and this deployment's (owner, 2026-11-17), which reaches back past the 90 days the ledger keeps
 * (repo.ts LEDGER_DAYS). Elsewhere the mail is days old, so the window makes no difference.
 */
export const WINDOWS = [30, 180] as const;

/** The environment the engine reads, fixed (CI sets MAIL_SOURCE=fixture, locally it is unset). */
export function stubInboxEnv(): void {
  vi.stubEnv("INBOX_BACKFILL_DAYS", "30");
  vi.stubEnv("MAIL_SOURCE", "fixture");
  resetEnvForTests();
}

/**
 * Another INBOX_BACKFILL_DAYS for one test, over the environment the block set up. A function of
 * its own: stubInboxEnv is passed to beforeEach, which would hand it the test context.
 */
export function stubBackfillDays(days: number): void {
  vi.stubEnv("INBOX_BACKFILL_DAYS", String(days));
  resetEnvForTests();
}

export function restoreInboxEnv(): void {
  vi.unstubAllEnvs();
  resetEnvForTests();
}

/** The demo mail in fixtures/mail, as the fixture source serves it at NOW. */
export function folderSource(opts: FixtureSourceOptions = {}): MailSource {
  return createFixtureSource({ now: () => NOW, ...opts });
}

/** Messages as given (no date moving), for tests that build their own mailbox. */
export function messageSource(messages: GmailMessage[], opts: FixtureSourceOptions = {}): MailSource {
  return createFixtureSource({ messages, now: () => NOW, shiftDates: false, ...opts });
}

/** The fixture files by name, with their Gmail message id. */
export async function fixtureFiles(): Promise<Array<{ file: string; id: string; message: GmailMessage }>> {
  const files = (await readdir(MAIL_DIR)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (file) => {
      const message = JSON.parse(await readFile(path.join(MAIL_DIR, file), "utf8")) as GmailMessage;
      return { file, id: message.id, message };
    }),
  );
}

/** A user with the default rules, the demo jobs and emails (dated at NOW), and a demo connection. */
export async function demoUser(): Promise<{ userId: string; address: string }> {
  const userId = await createUser({ rules: true });
  await withTx((tx) => seedUser(tx, userId, NOW.getTime()));
  await ensureDemoConnection(getDb(), userId);
  const [{ email }] = await testSql()<{ email: string }[]>`SELECT email FROM users WHERE id = ${userId}`;
  return { userId, address: email };
}

/** One run at NOW. */
export function sync(userId: string, source: MailSource, opts: RunOptions = {}): Promise<SyncResult> {
  return runSync(userId, { source, now: () => NOW, ...opts });
}

let seq = 0;

/** A plain-text Gmail message (format=full). */
export function gmailMessage(m: {
  id?: string;
  threadId?: string;
  from: string;
  subject: string;
  body: string;
  at: Date;
  labels?: string[];
}): GmailMessage {
  const id = m.id ?? `1a00000000000${String(++seq).padStart(3, "0")}`;
  const data = Buffer.from(m.body, "utf8").toString("base64url");
  return {
    id,
    threadId: m.threadId ?? id,
    labelIds: m.labels ?? ["INBOX", "UNREAD"],
    snippet: m.body.slice(0, 100),
    internalDate: String(m.at.getTime()),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: m.from },
        { name: "Subject", value: m.subject },
        { name: "Date", value: m.at.toUTCString() },
        { name: "Content-Type", value: 'text/plain; charset="UTF-8"' },
      ],
      body: { size: Buffer.byteLength(m.body), data },
    },
  };
}

/** Everything a run can change, for "nothing changed" comparisons. */
export async function snapshot(userId: string) {
  const [jobs, emails, ledger, events] = await Promise.all([
    listAllJobs(getDb(), userId),
    listEmails(getDb(), userId),
    testSql()`
      SELECT gmail_message_id, result, attempts, internal_date FROM inbox_seen_messages
      WHERE user_id = ${userId} ORDER BY gmail_message_id`,
    testSql()`SELECT count(*)::int AS count FROM job_status_events WHERE user_id = ${userId}`,
  ]);
  return { jobs, emails, ledger: [...ledger], events: events[0].count as number };
}

/** The user's ledger rows, by message id. */
export async function ledger(userId: string) {
  const rows = await testSql()<Array<{ gmail_message_id: string; result: string; attempts: number; internal_date: Date | null }>>`
    SELECT gmail_message_id, result, attempts, internal_date FROM inbox_seen_messages WHERE user_id = ${userId}`;
  return new Map(rows.map((r) => [r.gmail_message_id, r]));
}

/** The user's sync columns. */
export async function connectionRow(userId: string) {
  const [row] = await testSql()`SELECT * FROM inbox_connections WHERE user_id = ${userId}`;
  return row;
}
