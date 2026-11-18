import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDb } from "@/lib/server/db/client";
import { resetEnvForTests } from "@/lib/server/env";
import { ensureDemoConnection } from "@/lib/server/inbox/repo";
import { createMailSource } from "@/lib/server/inbox/source";
import type { MailSource } from "@/lib/server/inbox/source/types";
import { abortSync, isSyncing, runInboxCheck, runSync, settleWithin } from "@/lib/server/inbox/sync/engine";
import { inboxError, MailSourceError } from "@/lib/server/inbox/sync/errors";
import { ConflictError } from "@/lib/server/errors";
import { createUser } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";
import {
  connectionRow,
  demoUser,
  folderSource,
  ledger,
  NOW,
  restoreInboxEnv,
  snapshot,
  stubBackfillDays,
  stubInboxEnv,
  sync,
  WINDOWS,
} from "./support";

// The sync engine's bookkeeping on the connection row, the in-process registry, and the mail
// source factory.

const MINUTE = 60_000;

/** A source whose getProfile or listing throws `err`. */
function failingSource(err: unknown, where: "getProfile" | "listMessageIds" = "listMessageIds"): MailSource {
  const base = folderSource();
  return { ...base, [where]: async () => Promise.reject(err) };
}

describeDb("the sync engine", () => {
  beforeEach(stubInboxEnv);
  afterEach(restoreInboxEnv);

  it("ensureDemoConnection connects the user's own account once, and re-connects a row that is not connected", async () => {
    const userId = await createUser();
    await ensureDemoConnection(getDb(), userId);
    const [user] = await testSql()<{ email: string; google_sub: string }[]>`SELECT email, google_sub FROM users WHERE id = ${userId}`;
    const created = await connectionRow(userId);
    expect(created).toMatchObject({
      status: "connected",
      demo: true,
      email_address: user.email,
      google_sub: user.google_sub,
      refresh_token_enc: null,
      history_id: null,
      backfill_state: "pending",
    });
    expect(Math.abs(created.next_sync_at.getTime() - Date.now())).toBeLessThan(MINUTE);

    await testSql()`UPDATE inbox_connections SET next_sync_at = NULL WHERE user_id = ${userId}`;
    await ensureDemoConnection(getDb(), userId);
    expect((await connectionRow(userId)).next_sync_at).toBeNull(); // connected: left alone

    await testSql()`
      UPDATE inbox_connections SET status = 'needs_reconnect', history_id = '100005', last_error_code = 'token_revoked',
        last_error_at = now(), consecutive_failures = 2
      WHERE user_id = ${userId}`;
    await ensureDemoConnection(getDb(), userId);
    expect(await connectionRow(userId)).toMatchObject({
      status: "connected",
      history_id: "100005",
      next_sync_at: expect.any(Date),
      last_error_code: null,
      last_error_at: null,
      consecutive_failures: 0,
    });

    await testSql()`UPDATE inbox_connections SET status = 'disconnected' WHERE user_id = ${userId}`;
    await ensureDemoConnection(getDb(), userId);
    expect((await connectionRow(userId)).status).toBe("connected");
  });

  it.each(WINDOWS)("a first scan stores the position and its window (%i days) before it lists anything", async (days) => {
    stubBackfillDays(days);
    const { userId } = await demoUser();
    await expect(sync(userId, failingSource(inboxError("network")))).rejects.toMatchObject({ code: "network" });
    expect(await connectionRow(userId)).toMatchObject({
      history_id: "100015",
      backfill_state: "running",
      backfill_after: new Date(NOW.getTime() - days * 86_400_000),
      backfill_total: null,
      backfill_done: 0,
    });
  });

  it("records a failure on the connection, backs off, and a success resets it", async () => {
    const { userId } = await demoUser();
    await testSql()`UPDATE user_settings SET inbox_interval_minutes = 20 WHERE user_id = ${userId}`;
    const started = Date.now();

    await expect(sync(userId, failingSource(inboxError("google_unavailable"), "getProfile"))).rejects.toBeInstanceOf(MailSourceError);
    let row = await connectionRow(userId);
    expect(row).toMatchObject({ status: "connected", last_error_code: "google_unavailable", consecutive_failures: 1, last_sync_ok_at: null });
    // The wait doubles: 40 minutes after one failure, then capped at 60.
    expect(row.next_sync_at.getTime() - started).toBeGreaterThanOrEqual(40 * MINUTE - MINUTE);
    expect(row.next_sync_at.getTime() - started).toBeLessThan(40 * MINUTE + MINUTE);
    await expect(sync(userId, failingSource(new Error("boom"), "getProfile"))).rejects.toThrow("boom");
    row = await connectionRow(userId);
    expect(row).toMatchObject({ last_error_code: "internal", consecutive_failures: 2 });
    expect(row.next_sync_at.getTime() - started).toBeLessThan(60 * MINUTE + MINUTE);

    await sync(userId, folderSource());
    row = await connectionRow(userId);
    expect(row).toMatchObject({ last_error_code: null, last_error_at: null, consecutive_failures: 0, backfill_state: "done" });
    expect(row.last_sync_ok_at.getTime()).toBeGreaterThanOrEqual(started - 1000);
    expect(row.next_sync_at.getTime() - row.last_sync_ok_at.getTime()).toBe(20 * MINUTE);
  });

  it("marks the connection needs_reconnect when Google no longer accepts the token", async () => {
    const { userId } = await demoUser();
    await expect(sync(userId, failingSource(inboxError("token_revoked"), "getProfile"))).rejects.toMatchObject({
      kind: "needs_reconnect",
    });
    expect(await connectionRow(userId)).toMatchObject({ status: "needs_reconnect", last_error_code: "token_revoked" });
    await expect(sync(userId, folderSource())).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a user without a connected inbox", async () => {
    const userId = await createUser();
    await expect(runSync(userId, { source: folderSource() })).rejects.toThrow("Connect Gmail in Settings first.");
    await ensureDemoConnection(getDb(), userId);
    await testSql()`UPDATE inbox_connections SET status = 'disconnected' WHERE user_id = ${userId}`;
    await expect(runSync(userId, { source: folderSource() })).rejects.toBeInstanceOf(ConflictError);
  });

  it("abortSync stops a run between messages without recording a failure; the next run finishes the scan", async () => {
    const { userId } = await demoUser();
    const base = folderSource();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let fetching!: () => void;
    const fetched = new Promise<void>((resolve) => (fetching = resolve));
    const slow: MailSource = {
      ...base,
      getMessage: async (id) => {
        fetching();
        await gate;
        return base.getMessage(id);
      },
    };
    const before = await snapshot(userId);

    const run = runInboxCheck(userId, { source: slow, now: () => NOW });
    await fetched;
    expect(isSyncing(userId)).toBe(true);
    abortSync(userId);
    release();
    await expect(run).rejects.toMatchObject({ kind: "temporary", code: "stopped" });
    expect(isSyncing(userId)).toBe(false);
    expect(await connectionRow(userId)).toMatchObject({ last_error_code: null, consecutive_failures: 0, backfill_state: "running" });
    expect(await snapshot(userId)).toEqual(before);

    const resumed = await sync(userId, folderSource());
    expect(resumed).toMatchObject({ mode: "full_scan", scanned: 14, complete: true });
    expect((await ledger(userId)).size).toBe(14);
  });

  it("an outside stop signal stops the run too", async () => {
    const { userId } = await demoUser();
    const controller = new AbortController();
    controller.abort();
    await expect(runInboxCheck(userId, { source: folderSource(), now: () => NOW, signal: controller.signal })).rejects.toMatchObject({
      code: "stopped",
    });
    expect((await ledger(userId)).size).toBe(0);
  });

  it("settleWithin answers the value in time, or 'not done' after the wait", async () => {
    expect(await settleWithin(Promise.resolve(7), 1000)).toEqual({ done: true, value: 7 });
    expect(await settleWithin(new Promise(() => {}), 10)).toEqual({ done: false });
    await expect(settleWithin(Promise.reject(new Error("no")), 1000)).rejects.toThrow("no");
  });
});

describeDb("the mail source factory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it("serves the demo mail with MAIL_SOURCE=fixture, for the connection's own address", async () => {
    vi.stubEnv("MAIL_SOURCE", "fixture");
    resetEnvForTests();
    const source = createMailSource({ userId: "u", emailAddress: "owner@example.com" }, { now: () => NOW });
    expect(await source.getProfile()).toEqual({ emailAddress: "owner@example.com", historyId: "100015" });
    expect(await source.listMessageIds(new Date(NOW.getTime() - 30 * 86_400_000))).toHaveLength(14);
  });

  it("serves Gmail otherwise, with the connection's stored token (the requests: gmail-sync.test.ts)", async () => {
    vi.stubEnv("MAIL_SOURCE", "");
    resetEnvForTests();
    // No connection: the token cannot be read, so the source stops before any request.
    const userId = await createUser();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const source = createMailSource({ userId, emailAddress: "owner@example.com" });
      await expect(source.getProfile()).rejects.toMatchObject({ kind: "temporary", code: "stopped" });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
