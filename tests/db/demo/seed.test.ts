import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@/lib/domain/defaults";
import { createSession, hashSessionToken } from "@/lib/server/auth/session";
import { withTx, type Tx } from "@/lib/server/db/client";
import { buildSeed, EMAILS } from "@/lib/server/demo/fixtures";
import { seedUser } from "@/lib/server/demo/seed";
import { insertDefaults } from "@/lib/server/repo/users";
import * as oldFixtures from "../../../db/seed/fixtures";
import * as oldSeed from "../../../db/seed/seed";
import { describeDb, testSql } from "../../helpers/test-db";

// The seed in the app's source tree (src/lib/server/demo), where the public demo's workspaces
// will use it. tests/db/seed.test.ts checks what it writes; this checks that it composes with the
// rest of a new user in one transaction, and that the old paths still lead to it.

const NOW = Date.UTC(2026, 0, 15, 12);
const DAY = 24 * 60 * 60;

describe("the old paths (db/seed)", () => {
  it("re-export the same functions and data", () => {
    expect(oldSeed.seedUser).toBe(seedUser);
    expect(oldFixtures.buildSeed).toBe(buildSeed);
    expect(oldFixtures.EMAILS).toBe(EMAILS);
  });
});

/** Rows of every table a new, seeded user has, by user. */
async function rowsOf(userId: string) {
  type Counts = Record<"users" | "settings" | "rules" | "jobs" | "events" | "emails" | "sessions", number>;
  const [row] = await testSql()<Counts[]>`
    SELECT
      (SELECT count(*)::int FROM users WHERE id = ${userId}) AS users,
      (SELECT count(*)::int FROM user_settings WHERE user_id = ${userId}) AS settings,
      (SELECT count(*)::int FROM keyword_rules WHERE user_id = ${userId}) AS rules,
      (SELECT count(*)::int FROM jobs WHERE user_id = ${userId}) AS jobs,
      (SELECT count(*)::int FROM job_status_events WHERE user_id = ${userId}) AS events,
      (SELECT count(*)::int FROM emails WHERE user_id = ${userId}) AS emails,
      (SELECT count(*)::int FROM sessions WHERE user_id = ${userId}) AS sessions`;
  return row;
}

/** A new user with defaults, the seed and a fixed-lifetime session, in the caller's transaction. */
async function newSeededUser(tx: Tx, n: number) {
  const [user] = await tx<{ id: string }[]>`
    INSERT INTO users (google_sub, email, name)
    VALUES (${`seed-sub-${n}`}, ${`seeded${n}@example.com`}, 'Seeded Person')
    RETURNING id`;
  await insertDefaults(tx, user.id);
  const counts = await seedUser(tx, user.id, NOW);
  const session = await createSession(tx, user.id, { fixedLifetimeSeconds: DAY });
  return { userId: user.id, counts, session };
}

describeDb("seedUser in the caller's transaction", () => {
  const seed = buildSeed(NOW);

  it("is kept with the user, its defaults and its session", async () => {
    const { userId, counts, session } = await withTx((tx) => newSeededUser(tx, 1));
    expect(counts).toEqual({ jobs: seed.jobs.length, emails: seed.emails.length });

    const rows = await rowsOf(userId);
    expect(rows).toMatchObject({
      users: 1,
      settings: 1,
      rules: DEFAULT_RULES.length,
      jobs: seed.jobs.length,
      emails: seed.emails.length,
      sessions: 1,
    });
    expect(rows.events).toBeGreaterThanOrEqual(seed.jobs.length);

    // The session ends with the user's first day, the transaction's clock for both.
    const [row] = await testSql()<{ exact: boolean }[]>`
      SELECT s.expires_at = u.created_at + interval '1 day' AS exact
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${hashSessionToken(session.token)!}`;
    expect(row.exact).toBe(true);
  });

  it("is undone with everything else when the transaction rolls back", async () => {
    let userId = "";
    await expect(
      withTx(async (tx) => {
        userId = (await newSeededUser(tx, 2)).userId;
        throw new Error("the caller failed after seeding");
      }),
    ).rejects.toThrow("the caller failed after seeding");
    expect(userId).not.toBe("");
    expect(await rowsOf(userId)).toEqual({
      users: 0,
      settings: 0,
      rules: 0,
      jobs: 0,
      events: 0,
      emails: 0,
      sessions: 0,
    });
    const [{ total }] = await testSql()<{ total: number }[]>`
      SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM jobs) + (SELECT count(*) FROM emails) AS total`;
    expect(Number(total)).toBe(0);
  });

  it("seeds many users with the same data: nothing in it is unique across users", async () => {
    const a = await withTx((tx) => newSeededUser(tx, 3));
    const b = await withTx((tx) => newSeededUser(tx, 4));
    expect(await rowsOf(b.userId)).toEqual(await rowsOf(a.userId));
    expect((await rowsOf(b.userId)).jobs).toBe(seed.jobs.length);
  });
});
