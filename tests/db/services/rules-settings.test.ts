import { afterEach, beforeEach, expect, it } from "vitest";
import { ZodError } from "zod";
import { DEFAULT_RULES, RETIRED_DEFAULT_RULES } from "@/lib/domain/defaults";
import { normalize } from "@/lib/domain/normalize";
import { getDb } from "@/lib/server/db/client";
import { BadRequestError, NotFoundError } from "@/lib/server/errors";
import { ruleInputSchema } from "@/lib/server/schemas";
import { classify } from "@/lib/server/services/classify";
import { updateJob } from "@/lib/server/services/jobs";
import { addRule, deleteRule, listRules, updateDefaultRules } from "@/lib/server/services/rules";
import { getSettings, updateSettings, type SettingsPatch } from "@/lib/server/services/settings";
import { countRows, createUser, makeJob } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";
import { restoreEnv, setEnv } from "../../unit/auth/env";
import { inboxEnv } from "../../unit/inbox/connect-fakes";

// Settings.inbox without a connection. Sign-in is not configured in these tests (setEnv({})), so
// Gmail is not either (configured: false), whatever the environment says (CI runs MAIL_SOURCE=fixture).
const DEFAULT_SETTINGS = {
  inbox: {
    provider: "gmail",
    address: null,
    connected: false,
    state: "not_connected",
    syncing: false,
    backfill: null,
    lastCheckedAt: null,
    lastError: null,
    intervalMinutes: 15,
    configured: false,
    demo: false,
  },
  noResponseDays: 30,
  createFromConfirmation: true,
  reviewUncertain: true,
  languages: ["en", "de"],
};

describeDb("rules, settings and the rule tester", () => {
  beforeEach(() => {
    setEnv({});
    inboxEnv();
  });
  afterEach(() => restoreEnv());

  /* --------------------------------------------------------------- rules */

  it("updates the defaults: retired phrases go, missing ones come, the user's own stay", async () => {
    const user = await createUser();
    // The rules of a user from before: two retired defaults, one default that is still current,
    // and one of their own.
    await addRule(user, { status: "rejected", phrase: "Leider", language: "de" });
    await addRule(user, { status: "interview", phrase: "kennenlernen", language: "de" });
    const kept = await addRule(user, { status: "interview", phrase: "interview", language: "en" });
    const own = await addRule(user, { status: "offer", phrase: "willkommen im Team", language: "de" });
    await updateSettings(user, { languages: ["de"] });

    const result = await updateDefaultRules(user);

    expect(result).toMatchObject({ added: DEFAULT_RULES.length - 1, removed: 2 });
    expect(result.rules).toEqual(await listRules(getDb(), user));
    const key = (r: { status: string; phrase: string }) => `${r.status}:${normalize(r.phrase)}`;
    const keys = result.rules.map(key);
    expect(new Set(keys)).toEqual(new Set([...DEFAULT_RULES.map(key), key(own)]));
    for (const retired of RETIRED_DEFAULT_RULES) expect(keys).not.toContain(key(retired));
    // The rules that stay keep their rows; the defaults' languages are in the settings.
    expect(result.rules.slice(0, 2).map((r) => r.id)).toEqual([kept.id, own.id]);
    expect((await getSettings(getDb(), user)).languages).toEqual(["de", "en"]);
    // Again: nothing to do.
    expect(await updateDefaultRules(user)).toMatchObject({ added: 0, removed: 0 });
  });

  it("keeps the retired and the current defaults apart, and leaves other users alone", async () => {
    const current = new Set(DEFAULT_RULES.map((r) => `${r.status}:${normalize(r.phrase)}`));
    for (const r of RETIRED_DEFAULT_RULES) expect(current.has(`${r.status}:${normalize(r.phrase)}`), r.phrase).toBe(false);

    const user = await createUser({ rules: true });
    const other = await createUser();
    await addRule(other, { status: "rejected", phrase: "leider", language: "de" });
    // A new user has the current defaults: nothing to update.
    expect(await updateDefaultRules(user)).toMatchObject({ added: 0, removed: 0 });
    expect((await listRules(getDb(), other)).map((r) => r.phrase)).toEqual(["leider"]);
  });

  it("lists rules in the order they were added", async () => {
    const user = await createUser({ rules: true });
    const rules = await listRules(getDb(), user);
    expect(rules.map(({ status, phrase, language }) => ({ status, phrase, language }))).toEqual(DEFAULT_RULES);
    const added = await addRule(user, { status: "offer", phrase: "Zusage", language: "de" });
    expect((await listRules(getDb(), user)).at(-1)).toEqual(added);
  });

  it("returns the existing rule for the same status and phrase, ignoring case and accents", async () => {
    const user = await createUser();
    const rule = await addRule(user, { status: "rejected", phrase: "  Leider  ", language: "de" });
    expect(rule).toEqual({ id: expect.any(String), status: "rejected", phrase: "Leider", language: "de" });
    expect(await addRule(user, { status: "rejected", phrase: "leider", language: "de" })).toEqual(rule);
    expect(await addRule(user, { status: "rejected", phrase: "LÉIDER", language: "de" })).toEqual(rule);

    const other = await addRule(user, { status: "interview", phrase: "leider", language: "de" });
    expect(other.id).not.toBe(rule.id);
    expect(await countRows("keyword_rules")).toBe(2);
  });

  it("dedupes rules added at the same moment", async () => {
    const user = await createUser();
    const rules = await Promise.all(
      [1, 2, 3].map(() => addRule(user, { status: "offer", phrase: "Pleased to offer", language: "en" })),
    );
    expect(new Set(rules.map((r) => r.id)).size).toBe(1);
    expect(await countRows("keyword_rules")).toBe(1);
  });

  it("adds a new rule's language to the settings once", async () => {
    const user = await createUser();
    await addRule(user, { status: "rejected", phrase: "malheureusement", language: "fr" });
    await addRule(user, { status: "interview", phrase: "entretien", language: "fr" });
    await addRule(user, { status: "rejected", phrase: "unfortunately", language: "en" });
    expect((await getSettings(getDb(), user)).languages).toEqual(["en", "de", "fr"]);
  });

  it("does not add the language of a rule it did not create", async () => {
    const user = await createUser();
    await addRule(user, { status: "rejected", phrase: "leider", language: "de" });
    await updateSettings(user, { languages: ["en"] });
    await addRule(user, { status: "rejected", phrase: "Leider", language: "nl" });
    expect((await getSettings(getDb(), user)).languages).toEqual(["en"]);
  });

  it("refuses a phrase with nothing to match", async () => {
    const user = await createUser();
    await expect(addRule(user, { status: "offer", phrase: "́́", language: "en" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("counts the phrase and language limits in characters, as the table checks do", async () => {
    // "𝔞".length and "😀".length are 2; zod and the CHECKs both count one character.
    expect(ruleInputSchema.safeParse({ status: "applied", phrase: "𝔞", language: "en" }).success).toBe(false);
    const user = await createUser();
    const input = ruleInputSchema.parse({ status: "applied", phrase: "😀".repeat(120), language: "😀".repeat(5) });
    expect(Array.from((await addRule(user, input)).phrase)).toHaveLength(120);
  });

  it("deletes a rule, and answers NotFoundError for unknown ones", async () => {
    const user = await createUser();
    const rule = await addRule(user, { status: "offer", phrase: "offer letter", language: "en" });
    await deleteRule(user, rule.id);
    expect(await listRules(getDb(), user)).toEqual([]);
    for (const id of [rule.id, "not-a-uuid"]) {
      await expect(deleteRule(user, id)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  /* ------------------------------------------------------------ settings */

  it("reads the settings with the inbox not connected", async () => {
    const user = await createUser();
    expect(await getSettings(getDb(), user)).toEqual(DEFAULT_SETTINGS);
  });

  it("reads the defaults for a user without a settings row", async () => {
    const user = await createUser();
    await testSql()`DELETE FROM user_settings WHERE user_id = ${user}`;
    expect(await getSettings(getDb(), user)).toEqual(DEFAULT_SETTINGS);
    expect((await updateSettings(user, { noResponseDays: 45 })).noResponseDays).toBe(45);
  });

  it("updates the given settings and keeps the others", async () => {
    const user = await createUser();
    const updated = await updateSettings(user, {
      noResponseDays: 21,
      createFromConfirmation: false,
      languages: ["de"],
      inbox: { intervalMinutes: 60 },
    });
    expect(updated).toEqual({
      ...DEFAULT_SETTINGS,
      inbox: { ...DEFAULT_SETTINGS.inbox, intervalMinutes: 60 },
      noResponseDays: 21,
      createFromConfirmation: false,
      languages: ["de"],
    });
    expect(await getSettings(getDb(), user)).toEqual(updated);

    expect(await updateSettings(user, { reviewUncertain: false })).toMatchObject({
      noResponseDays: 21,
      reviewUncertain: false,
      languages: ["de"],
    });
    expect((await updateSettings(user, { languages: [] })).languages).toEqual([]);
  });

  it("ignores the inbox connect fields", async () => {
    const user = await createUser();
    const patch = {
      inbox: { provider: "imap", address: "someone@example.com", connected: true, state: "connected", demo: true },
    } as SettingsPatch;
    expect((await updateSettings(user, patch)).inbox).toEqual(DEFAULT_SETTINGS.inbox);
  });

  it("rejects values out of range and changes nothing", async () => {
    const user = await createUser();
    const bad: SettingsPatch[] = [
      { noResponseDays: 6 },
      { noResponseDays: 121 },
      { noResponseDays: 30.5 },
      { inbox: { intervalMinutes: 4 } },
      { inbox: { intervalMinutes: 1441 } },
      { noResponseDays: 40, inbox: { intervalMinutes: 0 } },
    ];
    for (const patch of bad) {
      await expect(updateSettings(user, patch)).rejects.toBeInstanceOf(ZodError);
    }
    expect(await getSettings(getDb(), user)).toEqual(DEFAULT_SETTINGS);
  });

  /* --------------------------------------------------------- rule tester */

  it("classifies with the user's jobs, rules and settings", async () => {
    const user = await createUser({ rules: true });
    const job = await makeJob(user, { company: "Parcelwerk", title: "Frontend Engineer", status: "applied" });
    const email = {
      fromName: "Parcelwerk Recruiting",
      fromAddress: "jobs@parcelwerk.example.com",
      subject: "Your application",
      body: "We would like to schedule a call with you.",
    };
    const result = await classify(getDb(), user, email);
    expect(result).toMatchObject({ related: true, status: "interview", outcome: "matched", reviewReason: null });
    expect(result.candidates.map((j) => j.id)).toEqual([job.id]);
    expect(result.candidates[0].history).toHaveLength(1);

    // A confirmation from a company with no job creates one (company and title guessed from the
    // mail), unless switched off. Without a title it goes to review instead (step 2.1).
    await updateJob(user, job.id, { status: "rejected" });
    const confirmation = {
      fromAddress: "careers@bramble.example.com",
      subject: "Thank you for applying – Data Analyst",
      body: "",
    };
    expect(await classify(getDb(), user, confirmation)).toMatchObject({
      outcome: "created",
      effect: { kind: "create", company: "Bramble", title: "Data Analyst", status: "applied" },
    });
    expect(await classify(getDb(), user, { ...confirmation, subject: "Thank you for applying" })).toMatchObject({
      outcome: "review",
      reviewReason: "unknown_job",
    });
    await updateSettings(user, { createFromConfirmation: false });
    expect(await classify(getDb(), user, confirmation)).toMatchObject({ outcome: "review", reviewReason: "unknown_job" });
  });

  it("uses only the user's own rules", async () => {
    const user = await createUser();
    // The sender's domain matches a job, so the mail is job related either way (step 2.1); the
    // user's rule is what decides the status.
    await makeJob(user, { company: "Kestrel", title: "Backend Engineer", status: "applied" });
    const email = { fromAddress: "x@kestrel.example.com", subject: "Hallo", body: "Wir freuen uns auf das Kennenlernen" };
    expect(await classify(getDb(), user, email)).toMatchObject({ outcome: "review", reviewReason: "no_keyword", status: null });
    await addRule(user, { status: "interview", phrase: "Kennenlernen", language: "de" });
    expect(await classify(getDb(), user, email)).toMatchObject({
      related: true,
      outcome: "matched",
      status: "interview",
      language: "de",
    });
  });
});
