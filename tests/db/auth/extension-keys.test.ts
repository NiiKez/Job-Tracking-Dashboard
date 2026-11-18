import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { authenticateExtensionKey, hashExtensionKey } from "@/lib/server/auth/extension-key";
import { getDb } from "@/lib/server/db/client";
import { touchExtensionKey } from "@/lib/server/repo/extension-keys";
import {
  createExtensionKey,
  disconnectExtension,
  getExtensionOverview,
  MAX_EXTENSION_KEYS,
  revokeExtensionKey,
} from "@/lib/server/services/extension";
import { createUser } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";
import { restoreEnv, signedInEnv } from "../../unit/auth/env";

// The Chrome extension's keys on the database: what is stored, the 20-key limit (also under
// concurrent requests), revoking, last_used_at, the allowlist, and the cascade from users.
// Tokens are made at runtime; none is ever written into this file.

/** A request carrying `token` as the extension sends it. */
const withKey = (token: string) =>
  new Request("https://jobs.example.com/api/extension/session", { headers: { authorization: `Bearer ${token}` } });

async function keyRows() {
  return testSql()<{ id: string; user_id: string; token_hash: Buffer; label: string; last_used_at: Date | null }[]>`
    SELECT id, user_id, token_hash, label, last_used_at FROM extension_keys ORDER BY created_at, id`;
}

/** Seconds since the key was last used, by the database clock; null when never. */
async function usedAgo(keyId: string): Promise<number | null> {
  const [row] = await testSql()<{ ago: number | null }[]>`
    SELECT extract(epoch FROM now() - last_used_at)::float8 AS ago FROM extension_keys WHERE id = ${keyId}`;
  return row.ago;
}

/** The email createUser() gives its n-th user is person<n>@example.com; allow this user's. */
async function allow(userId: string) {
  const [{ email }] = await testSql()<{ email: string }[]>`SELECT email FROM users WHERE id = ${userId}`;
  signedInEnv({ ALLOWED_EMAILS: email });
}

describeDb("extension keys", () => {
  beforeEach(() => signedInEnv());
  afterEach(restoreEnv);

  /* ------------------------------------------------------------ create */

  it("creates a key: the table holds SHA-256 of its 32 bytes and the trimmed label, never the token", async () => {
    const userId = await createUser();
    const created = await createExtensionKey(userId, "  Chrome on Linux  ");
    expect(created.token).toMatch(/^jtx_[A-Za-z0-9_-]{43}$/);
    expect(created.key).toEqual({
      id: expect.any(String),
      label: "Chrome on Linux",
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      lastUsedAt: null,
    });

    const [row] = await keyRows();
    expect(row).toMatchObject({ id: created.key.id, user_id: userId, label: "Chrome on Linux", last_used_at: null });
    const raw = Buffer.from(created.token.slice(4), "base64url");
    expect(row.token_hash).toEqual(createHash("sha256").update(raw).digest());
    expect(row.token_hash).toEqual(hashExtensionKey(created.token));
    const stored = JSON.stringify(await testSql()`SELECT * FROM extension_keys`);
    expect(stored).not.toContain(created.token.slice(4));
  });

  it("lists the user's keys, newest first, and nobody else's", async () => {
    const userId = await createUser();
    const other = await createUser();
    const first = await createExtensionKey(userId, "Chrome on Linux");
    const second = await createExtensionKey(userId, "Chrome on macOS");
    await createExtensionKey(other, "Edge on Windows");
    const overview = await getExtensionOverview(getDb(), userId);
    expect(overview.keys.map((k) => k.id)).toEqual([second.key.id, first.key.id]);
    expect(overview.keys.map((k) => k.label)).toEqual(["Chrome on macOS", "Chrome on Linux"]);
  });

  it(`refuses a key past ${MAX_EXTENSION_KEYS} per user with a ConflictError`, async () => {
    const userId = await createUser();
    const other = await createUser();
    for (let i = 0; i < MAX_EXTENSION_KEYS; i++) await createExtensionKey(userId, `Browser ${i}`);
    await expect(createExtensionKey(userId, "One too many")).rejects.toMatchObject({ name: "ConflictError" });
    // Per user: another account is not affected.
    await createExtensionKey(other, "Chrome on Linux");
    // Revoking one makes room again.
    const [oldest] = await keyRows();
    await revokeExtensionKey(userId, oldest.id);
    await createExtensionKey(userId, "Room again");
    const [{ n }] = await testSql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM extension_keys WHERE user_id = ${userId}`;
    expect(n).toBe(MAX_EXTENSION_KEYS);
  });

  it("does not pass the limit with requests at the same time", async () => {
    const userId = await createUser();
    for (let i = 0; i < MAX_EXTENSION_KEYS - 2; i++) await createExtensionKey(userId, `Browser ${i}`);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => createExtensionKey(userId, `Parallel ${i}`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ name: "ConflictError" });
    }
    expect(await keyRows()).toHaveLength(MAX_EXTENSION_KEYS);
  });

  /* ------------------------------------------------------------ revoke */

  it("revokes only the user's own key; another's, an unknown or a malformed id is a NotFoundError", async () => {
    const userId = await createUser();
    const other = await createUser();
    const mine = await createExtensionKey(userId, "Chrome on Linux");
    const theirs = await createExtensionKey(other, "Chrome on Linux");

    for (const id of [theirs.key.id, "0190f5a2-0000-7000-8000-000000000000", "not-a-uuid", ""]) {
      await expect(revokeExtensionKey(userId, id), id).rejects.toMatchObject({ name: "NotFoundError" });
    }
    await revokeExtensionKey(userId, mine.key.id);
    expect((await keyRows()).map((r) => r.id)).toEqual([theirs.key.id]);
    await expect(revokeExtensionKey(userId, mine.key.id)).rejects.toMatchObject({ name: "NotFoundError" });

    // Disconnect does not fail on a key that is already gone, nor touch another user's.
    await disconnectExtension(userId, mine.key.id);
    await disconnectExtension(userId, theirs.key.id);
    expect(await keyRows()).toHaveLength(1);
  });

  it("deletes a user's keys with the user", async () => {
    const userId = await createUser();
    const other = await createUser();
    await createExtensionKey(userId, "Chrome on Linux");
    await createExtensionKey(other, "Chrome on Linux");
    await testSql()`DELETE FROM users WHERE id = ${userId}`;
    expect((await keyRows()).map((r) => r.user_id)).toEqual([other]);
  });

  /* ------------------------------------------------------- authenticate */

  it("finds the key's user, and moves last_used_at at most every 5 minutes", async () => {
    const userId = await createUser();
    await allow(userId);
    const { token, key } = await createExtensionKey(userId, "Chrome on Linux");

    const auth = await authenticateExtensionKey(getDb(), withKey(token));
    expect(auth).toMatchObject({ ok: true, keyId: key.id, user: { id: userId } });
    expect(await usedAgo(key.id)).toBeLessThan(5);

    // Within 5 minutes: not written again.
    await testSql()`UPDATE extension_keys SET last_used_at = now() - interval '4 minutes'`;
    await authenticateExtensionKey(getDb(), withKey(token));
    expect(await usedAgo(key.id)).toBeGreaterThan(200);

    await testSql()`UPDATE extension_keys SET last_used_at = now() - interval '6 minutes'`;
    await authenticateExtensionKey(getDb(), withKey(token));
    expect(await usedAgo(key.id)).toBeLessThan(5);

    const overview = await getExtensionOverview(getDb(), userId);
    expect(overview.keys[0].lastUsedAt).toEqual(expect.stringMatching(/^\d{4}-/));
  });

  it("touches a key once when requests come together", async () => {
    const userId = await createUser();
    const { key } = await createExtensionKey(userId, "Chrome on Linux");
    const touched = await Promise.all(Array.from({ length: 4 }, () => touchExtensionKey(getDb(), key.id, 300)));
    expect(touched.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a missing, malformed, unknown or revoked key", async () => {
    const userId = await createUser();
    await allow(userId);
    const { token, key } = await createExtensionKey(userId, "Chrome on Linux");
    const unknown = `jtx_${Buffer.alloc(32, 7).toString("base64url")}`;
    for (const value of [null, "", "Bearer", "x", unknown, token.toUpperCase(), token.slice(0, -1)]) {
      const req =
        value === null
          ? new Request("https://jobs.example.com/api/extension/session")
          : withKey(value);
      expect(await authenticateExtensionKey(getDb(), req), String(value).slice(0, 8)).toEqual({ ok: false });
    }
    // The bare key without "Bearer".
    const bare = new Request("https://jobs.example.com/x", { headers: { authorization: token } });
    expect(await authenticateExtensionKey(getDb(), bare)).toEqual({ ok: false });

    await revokeExtensionKey(userId, key.id);
    expect(await authenticateExtensionKey(getDb(), withKey(token))).toEqual({ ok: false });
  });

  it("deletes the key once its user is no longer on ALLOWED_EMAILS", async () => {
    const userId = await createUser();
    const { token } = await createExtensionKey(userId, "Chrome on Linux");
    await createExtensionKey(userId, "Chrome on macOS");
    signedInEnv({ ALLOWED_EMAILS: "someone-else@example.com" });
    expect(await authenticateExtensionKey(getDb(), withKey(token))).toEqual({ ok: false });
    // Only the key used: the others end at their own next request.
    expect((await keyRows()).map((r) => r.label)).toEqual(["Chrome on macOS"]);
    // Back on the list: that key is gone for good.
    await allow(userId);
    expect(await authenticateExtensionKey(getDb(), withKey(token))).toEqual({ ok: false });
  });

  it("refuses every key while sign-in is locked, and keeps them", async () => {
    const userId = await createUser();
    await allow(userId);
    const { token } = await createExtensionKey(userId, "Chrome on Linux");
    signedInEnv({ GOOGLE_CLIENT_ID: "" });
    expect(await authenticateExtensionKey(getDb(), withKey(token))).toEqual({ ok: false });
    expect(await keyRows()).toHaveLength(1);
    expect((await keyRows())[0].last_used_at).toBeNull();
  });

  /* ------------------------------------------------------------ table */

  it("the table refuses a blank or long label, a hash that is not 32 bytes, and a hash twice", async () => {
    const userId = await createUser();
    const hash = (n: number) => createHash("sha256").update(`invented-${n}`).digest();
    const insert = (tokenHash: Buffer, label: string) =>
      testSql()`INSERT INTO extension_keys (user_id, token_hash, label) VALUES (${userId}, ${tokenHash}, ${label})`;

    await insert(hash(1), "x".repeat(80));
    await expect(insert(hash(2), "")).rejects.toMatchObject({ constraint_name: "extension_keys_label_check" });
    await expect(insert(hash(3), "x".repeat(81))).rejects.toMatchObject({ constraint_name: "extension_keys_label_check" });
    await expect(insert(hash(4).subarray(0, 31), "Short hash")).rejects.toMatchObject({
      constraint_name: "extension_keys_token_hash_check",
    });
    await expect(insert(hash(1), "Same hash")).rejects.toMatchObject({ constraint_name: "extension_keys_token_hash_key" });
  });
});
