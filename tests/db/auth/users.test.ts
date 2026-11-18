import { expect, it } from "vitest";
import { DEFAULT_RULES, DEFAULT_USER_SETTINGS } from "@/lib/domain/defaults";
import { normalize } from "@/lib/domain/normalize";
import { getDb, withTx } from "@/lib/server/db/client";
import { ConflictError } from "@/lib/server/errors";
import { getUser, insertDefaults, upsertUserOnSignIn, type SignInProfile } from "@/lib/server/repo/users";
import { describeDb, testSql } from "../../helpers/test-db";

const OWNER: SignInProfile = {
  sub: "110000000000000000001",
  email: "owner@example.com",
  name: "Olive Owner",
  picture: "https://lh3.googleusercontent.com/a/one",
};

const signIn = (profile: SignInProfile) => withTx((tx) => upsertUserOnSignIn(tx, profile));

async function counts() {
  const [row] = await testSql()<{ users: number; settings: number; rules: number }[]>`
    SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM user_settings) AS settings,
      (SELECT count(*)::int FROM keyword_rules) AS rules`;
  return row;
}

describeDb("users repository", () => {
  it("first sign-in creates the user, the settings row and the default keyword rules", async () => {
    const { user, created } = await signIn(OWNER);
    expect(created).toBe(true);
    expect(user).toEqual({
      id: expect.any(String),
      email: "owner@example.com",
      googleSub: OWNER.sub,
      name: "Olive Owner",
      pictureUrl: OWNER.picture,
    });

    const sql = testSql();
    const [settings] = await sql`SELECT * FROM user_settings WHERE user_id = ${user.id}`;
    expect(settings).toMatchObject({
      no_response_days: DEFAULT_USER_SETTINGS.noResponseDays,
      create_from_confirmation: DEFAULT_USER_SETTINGS.createFromConfirmation,
      review_uncertain: DEFAULT_USER_SETTINGS.reviewUncertain,
      languages: [...DEFAULT_USER_SETTINGS.languages],
      inbox_interval_minutes: DEFAULT_USER_SETTINGS.inboxIntervalMinutes,
    });

    const rules = await sql<{ status: string; phrase: string; phrase_norm: string; language: string }[]>`
      SELECT status, phrase, phrase_norm, language FROM keyword_rules WHERE user_id = ${user.id} ORDER BY id`;
    expect(rules).toHaveLength(DEFAULT_RULES.length);
    expect(new Set(rules.map((r) => `${r.status}|${r.phrase}|${r.language}`))).toEqual(
      new Set(DEFAULT_RULES.map((r) => `${r.status}|${r.phrase}|${r.language}`)),
    );
    for (const r of rules) expect(r.phrase_norm).toBe(normalize(r.phrase));
  });

  it("a second sign-in updates name, picture and last login, and duplicates nothing", async () => {
    const first = await signIn(OWNER);
    const sql = testSql();
    await sql`UPDATE users SET last_login_at = now() - interval '3 days' WHERE id = ${first.user.id}`;

    const second = await signIn({ ...OWNER, name: "Olive O.", picture: null });
    expect(second.created).toBe(false);
    expect(second.user).toEqual({ ...first.user, name: "Olive O.", pictureUrl: null });
    expect(await counts()).toEqual({ users: 1, settings: 1, rules: DEFAULT_RULES.length });

    const [row] = await sql<{ recent: boolean }[]>`
      SELECT last_login_at > now() - interval '1 minute' AS recent FROM users WHERE id = ${first.user.id}`;
    expect(row.recent).toBe(true);
  });

  it("follows a changed email address of the same Google account", async () => {
    const first = await signIn(OWNER);
    const second = await signIn({ ...OWNER, email: "Olive.New@Example.com" });
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.email).toBe("olive.new@example.com");
  });

  it("refuses an email that belongs to another Google account, and changes nothing", async () => {
    await signIn(OWNER);
    const other = { ...OWNER, sub: "110000000000000000002", name: "Someone Else" };
    await expect(signIn(other)).rejects.toBeInstanceOf(ConflictError);
    await expect(signIn(other)).rejects.toThrow("This email address belongs to a different Google account");
    expect(await counts()).toEqual({ users: 1, settings: 1, rules: DEFAULT_RULES.length });
    const [row] = await testSql()<{ google_sub: string; name: string }[]>`SELECT google_sub, name FROM users`;
    expect(row).toEqual({ google_sub: OWNER.sub, name: "Olive Owner" });
  });

  it("refuses to move a returning account onto an email another account has", async () => {
    await signIn(OWNER);
    const second = await signIn({ ...OWNER, sub: "110000000000000000002", email: "second@example.com" });
    await expect(signIn({ ...OWNER, email: "second@example.com" })).rejects.toBeInstanceOf(ConflictError);
    expect(await getUser(getDb(), second.user.id)).toMatchObject({ email: "second@example.com" });
    expect(await counts()).toEqual({ users: 2, settings: 2, rules: 2 * DEFAULT_RULES.length });
  });

  it("stores the email lower-cased and trimmed", async () => {
    const { user } = await signIn({ ...OWNER, email: "  Owner@EXAMPLE.com " });
    expect(user.email).toBe("owner@example.com");
  });

  it("concurrent first sign-ins of the same account create one user, never a false conflict", async () => {
    // Open all three pool connections first, so the sign-ins below really run at the same time.
    await Promise.all([1, 2, 3].map(() => testSql()`SELECT pg_sleep(0.05)`));

    for (let round = 0; round < 50; round++) {
      const profile = { ...OWNER, sub: `race-sub-${round}`, email: `race${round}@example.com` };
      const results = await Promise.allSettled([signIn(profile), signIn(profile), signIn(profile)]);
      const errors = results.flatMap((r) => (r.status === "rejected" ? [`round ${round}: ${String(r.reason)}`] : []));
      expect(errors).toEqual([]);
      const created = results.map((r) => (r.status === "fulfilled" ? r.value.created : null));
      expect(created.sort()).toEqual([false, false, true]);
    }

    const perSub = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM users GROUP BY google_sub`;
    expect(perSub).toHaveLength(50);
    expect(perSub.every((r) => r.n === 1)).toBe(true);
    expect(await counts()).toEqual({ users: 50, settings: 50, rules: 50 * DEFAULT_RULES.length });
  });

  it("insertDefaults gives a user made without sign-in what a first sign-in gives", async () => {
    const { user: signedIn } = await signIn(OWNER);
    const made = await withTx(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO users (google_sub, email, name) VALUES ('made-1', 'made@example.com', 'Made') RETURNING id`;
      await insertDefaults(tx, row.id);
      return row.id;
    });
    const sql = testSql();
    const defaults = async (userId: string) => {
      const [settings] = await sql`
        SELECT no_response_days, create_from_confirmation, review_uncertain, languages, inbox_interval_minutes
        FROM user_settings WHERE user_id = ${userId}`;
      const rules = await sql`
        SELECT status, phrase, phrase_norm, language FROM keyword_rules WHERE user_id = ${userId}
        ORDER BY status, phrase, language`;
      return { settings, rules: [...rules] };
    };
    const expected = await defaults(signedIn.id);
    expect(expected.rules).toHaveLength(DEFAULT_RULES.length);
    expect(await defaults(made)).toEqual(expected);

    // Once per user: a second call fails, and its transaction leaves nothing behind.
    await expect(withTx((tx) => insertDefaults(tx, made))).rejects.toThrow(/user_settings_pkey/);
    expect(await counts()).toEqual({ users: 2, settings: 2, rules: 2 * DEFAULT_RULES.length });
  });

  it("getUser returns the user, or null for an unknown id", async () => {
    const { user } = await signIn(OWNER);
    expect(await getUser(getDb(), user.id)).toEqual(user);
    expect(await getUser(getDb(), "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")).toBeNull();
  });
});
