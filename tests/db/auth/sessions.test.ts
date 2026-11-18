import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createSession,
  endSession,
  extendSession,
  hashSessionToken,
  lookupSession,
  type SessionLookup,
} from "@/lib/server/auth/session";
import { getDb, withTx } from "@/lib/server/db/client";
import { deleteExpiredSessions, touchSession } from "@/lib/server/repo/sessions";
import { upsertUserOnSignIn, type User } from "@/lib/server/repo/users";
import { describeDb, testSql } from "../../helpers/test-db";
import { restoreEnv, signedInEnv } from "../../unit/auth/env";

const DAY = 24 * 60 * 60;

function requestWith(token: string | null): NextRequest {
  return new NextRequest("https://jobs.example.com/api/me", {
    headers: token === null ? {} : { cookie: `__Host-jt_session=${token}` },
  });
}

async function newUser(n = 1): Promise<User> {
  const { user } = await withTx((tx) =>
    upsertUserOnSignIn(tx, { sub: `sub-${n}`, email: `user${n}@example.com`, name: `User ${n}`, picture: null }),
  );
  return user;
}

/** Seconds from the database's now() to the session's expires_at / last_seen_at. */
async function timing(token: string) {
  const hash = hashSessionToken(token)!;
  const [row] = await testSql()<{ expires_in: number; seen_ago: number }[]>`
    SELECT
      extract(epoch FROM expires_at - now())::float8 AS expires_in,
      extract(epoch FROM now() - last_seen_at)::float8 AS seen_ago
    FROM sessions WHERE token_hash = ${hash}`;
  return row;
}

async function valid(token: string) {
  const found = await lookupSession(getDb(), requestWith(token));
  expect(found.status).toBe("valid");
  return found as Extract<SessionLookup, { status: "valid" }>;
}

describeDb("sessions", () => {
  beforeEach(() => signedInEnv({ APP_URL: "https://jobs.example.com" }));
  afterEach(restoreEnv);

  it("creates a session: the table holds SHA-256 of the token's bytes, never the token", async () => {
    const user = await newUser();
    const { token, setCookie } = await createSession(getDb(), user.id);
    expect(setCookie.startsWith(`__Host-jt_session=${token}; `)).toBe(true);

    const rows = await testSql()<{ user_id: string; token_hash: Buffer }[]>`SELECT user_id, token_hash FROM sessions`;
    expect(rows).toHaveLength(1);
    const stored = rows[0].token_hash;
    expect(rows[0].user_id).toBe(user.id);
    expect(stored).toHaveLength(32);
    const raw = Buffer.from(token, "base64url");
    expect(stored.equals(raw)).toBe(false);
    expect(stored.toString("base64url")).not.toBe(token);
    expect(stored.equals(createHash("sha256").update(raw).digest())).toBe(true);

    const t = await timing(token);
    expect(t.expires_in).toBeGreaterThan(30 * DAY - 60);
    expect(t.expires_in).toBeLessThanOrEqual(30 * DAY);
  });

  it("looks a session up by its cookie, with its user", async () => {
    const user = await newUser();
    const { token } = await createSession(getDb(), user.id);
    const found = await valid(token);
    expect(found.user).toEqual(user);
    expect(found.token).toBe(token);
    expect(found.session.needsTouch).toBe(false);
  });

  it("no cookie → none; a malformed or unknown token → invalid", async () => {
    const user = await newUser();
    const { token } = await createSession(getDb(), user.id);
    const db = getDb();
    expect(await lookupSession(db, requestWith(null))).toEqual({ status: "none" });
    expect(await lookupSession(db, requestWith("not-a-token"))).toEqual({ status: "invalid" });
    const unknown = Buffer.alloc(32, 7).toString("base64url");
    expect(await lookupSession(db, requestWith(unknown))).toEqual({ status: "invalid" });
    // The hash itself as a cookie (a leaked table row) is not a session.
    const hash = hashSessionToken(token)!.toString("base64url");
    expect(await lookupSession(db, requestWith(hash))).toEqual({ status: "invalid" });
  });

  it("an expired session is not found", async () => {
    const user = await newUser();
    const { token } = await createSession(getDb(), user.id);
    await testSql()`UPDATE sessions SET expires_at = now() - interval '1 second'`;
    expect(await lookupSession(getDb(), requestWith(token))).toEqual({ status: "invalid" });
  });

  it("a session is extended at most once a day: 30 days from now, cookie re-sent", async () => {
    const user = await newUser();
    const { token } = await createSession(getDb(), user.id);
    const db = getDb();

    // Fresh: nothing to do, no query, no cookie.
    expect(await extendSession(db, await valid(token))).toBeNull();

    // Last extended 25 hours ago, 5 days left.
    await testSql()`
      UPDATE sessions SET last_seen_at = now() - interval '25 hours', expires_at = now() + interval '5 days'`;
    const due = await valid(token);
    expect(due.session.needsTouch).toBe(true);
    const cookie = await extendSession(db, due);
    expect(cookie).toMatch(new RegExp(`^__Host-jt_session=${token}; Path=/; Max-Age=${30 * DAY}; `));
    const after = await timing(token);
    expect(after.expires_in).toBeGreaterThan(30 * DAY - 60);
    expect(after.seen_ago).toBeLessThan(60);

    // Right after: not due again.
    expect((await valid(token)).session.needsTouch).toBe(false);
    expect(await extendSession(db, await valid(token))).toBeNull();

    // 23 hours later: still not due.
    await testSql()`UPDATE sessions SET last_seen_at = now() - interval '23 hours'`;
    expect((await valid(token)).session.needsTouch).toBe(false);
  });

  it("touchSession updates once even when two requests race", async () => {
    const user = await newUser();
    const { token } = await createSession(getDb(), user.id);
    await testSql()`UPDATE sessions SET last_seen_at = now() - interval '2 days'`;
    const { session } = await valid(token);
    const results = await Promise.all([
      touchSession(getDb(), session.id, 30 * DAY, DAY),
      touchSession(getDb(), session.id, 30 * DAY, DAY),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("touchSession does not revive an expired session", async () => {
    const user = await newUser();
    const { token } = await createSession(getDb(), user.id);
    const { session } = await valid(token);
    await testSql()`
      UPDATE sessions SET last_seen_at = now() - interval '31 days', expires_at = now() - interval '1 day'`;
    expect(await touchSession(getDb(), session.id, 30 * DAY, DAY)).toBeNull();
    expect(await lookupSession(getDb(), requestWith(token))).toEqual({ status: "invalid" });
  });

  it("endSession deletes the session the cookie names, and only that one", async () => {
    const user = await newUser();
    const a = await createSession(getDb(), user.id);
    const b = await createSession(getDb(), user.id);
    await endSession(getDb(), requestWith(a.token));
    expect(await lookupSession(getDb(), requestWith(a.token))).toEqual({ status: "invalid" });
    await valid(b.token);
    // No cookie, or a malformed one: nothing happens.
    await endSession(getDb(), requestWith(null));
    await endSession(getDb(), requestWith("junk"));
    const [{ count }] = await testSql()<{ count: number }[]>`SELECT count(*)::int AS count FROM sessions`;
    expect(count).toBe(1);
  });

  it("deleteExpiredSessions removes only that user's expired sessions", async () => {
    const one = await newUser(1);
    const two = await newUser(2);
    const live = await createSession(getDb(), one.id);
    const old = await createSession(getDb(), one.id);
    const otherOld = await createSession(getDb(), two.id);
    const sql = testSql();
    for (const s of [old, otherOld]) {
      await sql`UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE token_hash = ${hashSessionToken(s.token)!}`;
    }
    expect(await deleteExpiredSessions(getDb(), one.id)).toBe(1);
    const left = await sql<{ token_hash: Buffer }[]>`SELECT token_hash FROM sessions ORDER BY id`;
    expect(left.map((r) => r.token_hash.toString("hex")).sort()).toEqual(
      [live, otherOld].map((s) => hashSessionToken(s.token)!.toString("hex")).sort(),
    );
  });

  it("deleting a user deletes their sessions", async () => {
    const user = await newUser();
    const { token } = await createSession(getDb(), user.id);
    await testSql()`DELETE FROM users WHERE id = ${user.id}`;
    expect(await lookupSession(getDb(), requestWith(token))).toEqual({ status: "invalid" });
  });
});
