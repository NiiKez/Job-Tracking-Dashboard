import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appOrigin,
  appUrl,
  checkEnv,
  EnvError,
  getEnv,
  inboxTokenKeys,
  isSecureApp,
  parseEnv,
  resetEnvForTests,
  signInConfig,
} from "@/lib/server/env";

// Invented values only.
const DATABASE_URL = "postgresql://app:pw-1234@localhost:5432/job_tracker";
const KEY = "a".repeat(64);
const SIGN_IN = {
  APP_URL: "https://jobs.example.com",
  GOOGLE_CLIENT_ID: "1234-abc.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-not-a-real-secret",
  ALLOWED_EMAILS: "owner@example.com",
};

/** The EnvError parseEnv throws for this environment. */
function errorFor(source: Record<string, string>): EnvError {
  try {
    parseEnv(source);
  } catch (err) {
    expect(err).toBeInstanceOf(EnvError);
    return err as EnvError;
  }
  throw new Error("parseEnv accepted a malformed environment");
}

describe("parseEnv", () => {
  it("accepts DATABASE_URL alone: sign-in locked, Gmail off, defaults for the rest", () => {
    const env = parseEnv({ DATABASE_URL });
    expect(env).toEqual({
      databaseUrl: DATABASE_URL,
      appOrigin: null,
      googleClientId: null,
      googleClientSecret: null,
      allowedEmails: null,
      inboxTokenKey: null,
      inboxTokenKeyPrevious: null,
      mailSource: "gmail",
      inboxSchedulerEnabled: true,
      inboxBackfillDays: 30,
      allowPartialSetup: false,
    });
    expect(signInConfig(env)).toBeNull();
    expect(appUrl(env)).toBeNull();
    expect(appOrigin(env)).toBeNull();
    expect(isSecureApp(env)).toBe(false);
    expect(inboxTokenKeys(env)).toBeNull();
  });

  it("accepts an empty environment: nothing is required to parse", () => {
    expect(parseEnv({}).databaseUrl).toBeNull();
  });

  it("treats empty and blank values as missing", () => {
    const env = parseEnv({
      DATABASE_URL,
      APP_URL: "",
      GOOGLE_CLIENT_ID: "  ",
      ALLOWED_EMAILS: "",
      INBOX_TOKEN_KEY: "",
      MAIL_SOURCE: "",
      INBOX_SCHEDULER: " ",
      INBOX_BACKFILL_DAYS: "",
      ALLOW_PARTIAL_SETUP: " ",
    });
    expect(env).toMatchObject({
      appOrigin: null,
      googleClientId: null,
      mailSource: "gmail",
      inboxBackfillDays: 30,
      allowPartialSetup: false,
    });
  });

  it("builds the sign-in config when all four values are present", () => {
    const env = parseEnv({ DATABASE_URL, ...SIGN_IN, ALLOWED_EMAILS: " Owner@Example.com, second@example.com ,," });
    const config = signInConfig(env);
    expect(config).not.toBeNull();
    expect(config!.clientId).toBe(SIGN_IN.GOOGLE_CLIENT_ID);
    expect(config!.clientSecret).toBe(SIGN_IN.GOOGLE_CLIENT_SECRET);
    expect([...config!.allowedEmails]).toEqual(["owner@example.com", "second@example.com"]);
    expect(config!.appUrl.href).toBe("https://jobs.example.com/");
    expect(isSecureApp(env)).toBe(true);
  });

  it.each(Object.keys(SIGN_IN))("locks sign-in when %s is missing", (name) => {
    const env = parseEnv({ DATABASE_URL, ...SIGN_IN, [name]: "" });
    expect(signInConfig(env)).toBeNull();
  });

  it("reduces APP_URL to its origin", () => {
    for (const [value, origin] of [
      ["https://jobs.example.com/", "https://jobs.example.com"],
      ["http://localhost:3800", "http://localhost:3800"],
      ["HTTPS://Jobs.Example.com:443", "https://jobs.example.com"],
    ]) {
      const env = parseEnv({ APP_URL: value });
      expect(appOrigin(env)).toBe(origin);
      expect(appUrl(env)?.href).toBe(`${origin}/`);
    }
    expect(isSecureApp(parseEnv({ APP_URL: "http://localhost:3800" }))).toBe(false);
  });

  it("returns fresh URL objects, so callers cannot change the shared value", () => {
    const env = parseEnv({ DATABASE_URL, ...SIGN_IN });
    appUrl(env)!.pathname = "/changed";
    signInConfig(env)!.appUrl.pathname = "/changed";
    expect(appUrl(env)!.href).toBe("https://jobs.example.com/");
  });

  it("reads the inbox settings", () => {
    const env = parseEnv({
      INBOX_TOKEN_KEY: "AB".repeat(32),
      INBOX_TOKEN_KEY_PREVIOUS: KEY,
      MAIL_SOURCE: "fixture",
      INBOX_SCHEDULER: "off",
      INBOX_BACKFILL_DAYS: "90",
    });
    expect(env).toMatchObject({
      inboxTokenKey: "ab".repeat(32),
      mailSource: "fixture",
      inboxSchedulerEnabled: false,
      inboxBackfillDays: 90,
    });
    const keys = inboxTokenKeys(env)!;
    expect(keys.current).toEqual(Buffer.alloc(32, 0xab));
    expect(keys.previous).toEqual(Buffer.alloc(32, 0xaa));
    expect(inboxTokenKeys(parseEnv({ INBOX_TOKEN_KEY: KEY }))!.previous).toBeNull();
  });

  it("reads ALLOW_PARTIAL_SETUP: on, or off (the default)", () => {
    expect(parseEnv({ ALLOW_PARTIAL_SETUP: "on" }).allowPartialSetup).toBe(true);
    expect(parseEnv({ ALLOW_PARTIAL_SETUP: " on " }).allowPartialSetup).toBe(true);
    expect(parseEnv({ ALLOW_PARTIAL_SETUP: "off" }).allowPartialSetup).toBe(false);
    expect(parseEnv({}).allowPartialSetup).toBe(false);
  });

  const malformed: Array<[name: string, value: string]> = [
    ["DATABASE_URL", "mysql://app:pw-1234@localhost/job_tracker"],
    ["DATABASE_URL", "localhost:5432"],
    // URLs postgres.js cannot parse: it would throw with the whole URL in the error.
    ["DATABASE_URL", "postgresql://app:pw-1234/x@localhost:5432/job_tracker"],
    ["DATABASE_URL", "postgresql://app:pw-1234@localhost:99999/job_tracker"],
    ["DATABASE_URL", "postgresql://app:pw-1234%zz@localhost/job_tracker"],
    ["APP_URL", "https://jobs.example.com/app"],
    ["APP_URL", "https://jobs.example.com/?x=1"],
    ["APP_URL", "https://jobs.example.com?"],
    ["APP_URL", "https://jobs.example.com/#top"],
    ["APP_URL", "https://user:pw-1234@jobs.example.com"],
    ["APP_URL", "ftp://jobs.example.com"],
    ["APP_URL", "jobs.example.com"],
    ["GOOGLE_CLIENT_ID", "two words"],
    ["GOOGLE_CLIENT_SECRET", "secret with-space"],
    ["ALLOWED_EMAILS", "owner@example.com, not-an-address"],
    ["ALLOWED_EMAILS", " , ,"],
    ["INBOX_TOKEN_KEY", "abc123"],
    ["INBOX_TOKEN_KEY", "g".repeat(64)],
    ["INBOX_TOKEN_KEY", "a".repeat(66)],
    ["MAIL_SOURCE", "imap"],
    ["MAIL_SOURCE", "Gmail"],
    ["INBOX_SCHEDULER", "yes"],
    ["INBOX_BACKFILL_DAYS", "0"],
    ["INBOX_BACKFILL_DAYS", "366"],
    ["INBOX_BACKFILL_DAYS", "1.5"],
    ["INBOX_BACKFILL_DAYS", "thirty"],
    ["ALLOW_PARTIAL_SETUP", "yes"],
    ["ALLOW_PARTIAL_SETUP", "On"],
  ];

  it.each([
    "postgres://app:pw-1234@localhost/job_tracker?sslmode=disable",
    "postgresql://app:p%40ss%2Fword@127.0.0.1:5432/job_tracker",
    "postgresql://app:pw-1234@[::1]:5432/job_tracker",
    "postgresql://app:pw-1234@db1:5432,db2:5433/job_tracker",
    "postgresql:///job_tracker",
  ])("accepts a DATABASE_URL postgres.js can read: %s", (url) => {
    expect(parseEnv({ DATABASE_URL: url }).databaseUrl).toBe(url);
  });

  it.each(malformed)("rejects a malformed %s without quoting it", (name, value) => {
    const err = errorFor({ DATABASE_URL, INBOX_TOKEN_KEY: KEY, [name]: value });
    expect(err.variables).toEqual([name]);
    expect(err.message).toContain(`${name} must`);
    expect(err.message).not.toContain(value.trim());
    expect(err.message).not.toContain("pw-1234");
  });

  it("rejects a malformed INBOX_TOKEN_KEY_PREVIOUS, and one without a current key", () => {
    expect(errorFor({ INBOX_TOKEN_KEY: KEY, INBOX_TOKEN_KEY_PREVIOUS: "xyz" }).variables).toEqual([
      "INBOX_TOKEN_KEY_PREVIOUS",
    ]);
    const alone = errorFor({ INBOX_TOKEN_KEY_PREVIOUS: KEY });
    expect(alone.variables).toEqual(["INBOX_TOKEN_KEY_PREVIOUS"]);
    expect(alone.message).toContain("INBOX_TOKEN_KEY_PREVIOUS is set but INBOX_TOKEN_KEY is not");
    expect(alone.message).not.toContain(KEY);
  });

  it("names every malformed variable in one message", () => {
    const err = errorFor({
      DATABASE_URL: "nope",
      APP_URL: "https://jobs.example.com/path",
      INBOX_SCHEDULER: "maybe",
    });
    expect(err.variables).toEqual(["DATABASE_URL", "APP_URL", "INBOX_SCHEDULER"]);
    expect(err.message).toMatch(/^Invalid environment: DATABASE_URL must .*; APP_URL must .*; INBOX_SCHEDULER must .*\.$/);
    for (const value of ["nope", "/path", "maybe"]) expect(err.message).not.toContain(value);
  });
});

describe("getEnv and checkEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  /** Replaces the environment variables env.ts reads with exactly these. */
  function stubEnv(values: Record<string, string>) {
    for (const name of [
      "DATABASE_URL",
      "APP_URL",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "ALLOWED_EMAILS",
      "INBOX_TOKEN_KEY",
      "INBOX_TOKEN_KEY_PREVIOUS",
      "MAIL_SOURCE",
      "INBOX_SCHEDULER",
      "INBOX_BACKFILL_DAYS",
      "ALLOW_PARTIAL_SETUP",
    ]) {
      vi.stubEnv(name, values[name] ?? "");
    }
    resetEnvForTests();
  }

  /** The EnvError checkEnv throws for this environment under `nodeEnv`. */
  function startError(values: Record<string, string>, nodeEnv = "production"): EnvError {
    stubEnv(values);
    try {
      checkEnv(() => {}, nodeEnv);
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      return err as EnvError;
    }
    throw new Error("checkEnv accepted the environment");
  }

  /** Everything production needs, with no MAIL_SOURCE: the CI smoke run of `next start`. */
  const COMPLETE = { DATABASE_URL, ...SIGN_IN, INBOX_TOKEN_KEY: KEY };
  const OPT_OUT = /ALLOW_PARTIAL_SETUP=on starts without them/;
  const FIXTURE_REFUSED =
    "Invalid environment: MAIL_SOURCE must not be fixture in production unless APP_URL is an http origin on 127.0.0.1, localhost or [::1]; fixture mail is for development, tests and CI.";

  it("memoizes process.env until reset", () => {
    stubEnv({ DATABASE_URL, INBOX_BACKFILL_DAYS: "10" });
    expect(getEnv().inboxBackfillDays).toBe(10);
    vi.stubEnv("INBOX_BACKFILL_DAYS", "20");
    expect(getEnv().inboxBackfillDays).toBe(10);
    resetEnvForTests();
    expect(getEnv().inboxBackfillDays).toBe(20);
  });

  it("starts with DATABASE_URL alone and logs what is off", () => {
    stubEnv({ DATABASE_URL });
    const lines: string[] = [];
    checkEnv((line) => lines.push(line));
    expect(lines).toEqual([
      "env: sign-in is locked, every request is signed out (missing: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS, APP_URL)",
      "env: Gmail is not set up (missing: INBOX_TOKEN_KEY)",
    ]);
  });

  it("logs nothing when everything is configured", () => {
    stubEnv({ DATABASE_URL, ...SIGN_IN, INBOX_TOKEN_KEY: KEY });
    const log = vi.fn();
    checkEnv(log);
    expect(log).not.toHaveBeenCalled();
  });

  it("names only the missing sign-in values", () => {
    stubEnv({ DATABASE_URL, ...SIGN_IN, ALLOWED_EMAILS: "", INBOX_TOKEN_KEY: KEY, MAIL_SOURCE: "fixture" });
    const lines: string[] = [];
    checkEnv((line) => lines.push(line));
    expect(lines).toEqual([
      "env: sign-in is locked, every request is signed out (missing: ALLOWED_EMAILS)",
      "env: MAIL_SOURCE is fixture, the inbox reads fixture mail instead of Gmail",
    ]);
  });

  it("stops the start without DATABASE_URL", () => {
    stubEnv({ ...SIGN_IN });
    expect(() => checkEnv(() => {})).toThrow(/DATABASE_URL is missing/);
  });

  it("stops the start on a malformed value, without quoting it", () => {
    stubEnv({ DATABASE_URL, APP_URL: "https://jobs.example.com/login?secret=pw-1234" });
    expect(() => checkEnv(() => {})).toThrow(EnvError);
    try {
      checkEnv(() => {});
    } catch (err) {
      expect((err as Error).message).not.toContain("pw-1234");
      expect((err as Error).message).not.toContain("/login");
    }
  });

  describe("in production", () => {
    it("starts with the complete configuration and no MAIL_SOURCE, and logs nothing", () => {
      for (const values of [COMPLETE, { ...COMPLETE, MAIL_SOURCE: "gmail" }, { ...COMPLETE, ALLOW_PARTIAL_SETUP: "off" }]) {
        stubEnv(values);
        const log = vi.fn();
        checkEnv(log, "production");
        expect(log).not.toHaveBeenCalled();
      }
    });

    it.each([...Object.keys(SIGN_IN), "INBOX_TOKEN_KEY"])("stops the start without %s, naming the opt-out", (name) => {
      const err = startError({ ...COMPLETE, [name]: "" });
      expect(err.variables).toEqual([name]);
      expect(err.message).toContain(`${name} is missing.`);
      expect(err.message).toMatch(OPT_OUT);
    });

    it("names every missing variable in one message, in the order the log uses", () => {
      expect(startError({ DATABASE_URL }).variables).toEqual([
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "ALLOWED_EMAILS",
        "APP_URL",
        "INBOX_TOKEN_KEY",
      ]);
      const err = startError({ ...SIGN_IN, ALLOWED_EMAILS: "", MAIL_SOURCE: "fixture" });
      expect(err.variables).toEqual(["DATABASE_URL", "ALLOWED_EMAILS", "INBOX_TOKEN_KEY", "MAIL_SOURCE"]);
      expect(err.message).toMatch(
        /^Invalid environment: DATABASE_URL is missing; .*; ALLOWED_EMAILS is missing; INBOX_TOKEN_KEY is missing; MAIL_SOURCE must not be fixture in production unless .*\. Production needs sign-in and Gmail set up; ALLOW_PARTIAL_SETUP=on/,
      );
    });

    it("stops the start with MAIL_SOURCE=fixture and a public or missing APP_URL, also with ALLOW_PARTIAL_SETUP=on", () => {
      const cases: Array<Record<string, string>> = [
        { ...COMPLETE, MAIL_SOURCE: "fixture" },
        { ...COMPLETE, MAIL_SOURCE: "fixture", ALLOW_PARTIAL_SETUP: "on" },
        { DATABASE_URL, MAIL_SOURCE: "fixture", ALLOW_PARTIAL_SETUP: "on" },
      ];
      for (const values of cases) {
        const err = startError(values);
        expect(err.variables).toEqual(["MAIL_SOURCE"]);
        expect(err.message).toBe(FIXTURE_REFUSED);
      }
    });

    // A production build run on this machine only (scripts/scheduler-check.mts), owner 2026-11-17.
    it.each([
      "http://127.0.0.1:3897",
      "http://localhost",
      "http://localhost:3800",
      "HTTP://LocalHost:3800",
      "http://[::1]:8080",
      "http://[0:0:0:0:0:0:0:1]",
    ])("allows MAIL_SOURCE=fixture with a loopback APP_URL: %s", (url) => {
      stubEnv({ ...COMPLETE, APP_URL: url, MAIL_SOURCE: "fixture" });
      const lines: string[] = [];
      checkEnv((line) => lines.push(line), "production");
      expect(lines).toEqual(["env: MAIL_SOURCE is fixture, the inbox reads fixture mail instead of Gmail"]);
    });

    it.each([
      ["https://localhost"],
      ["https://127.0.0.1:3897"],
      ["https://[::1]"],
      ["http://127.0.0.1.example.com"],
      ["http://localhost.example.com"],
      ["http://localhost."],
      ["http://127.0.0.2"],
      ["http://10.0.0.1:3800"],
      ["http://jobs.example.com"],
      [""],
    ])("refuses MAIL_SOURCE=fixture with APP_URL %j", (url) => {
      for (const optOut of ["", "on"]) {
        const err = startError({ ...COMPLETE, APP_URL: url, MAIL_SOURCE: "fixture", ALLOW_PARTIAL_SETUP: optOut });
        expect(err.variables).toEqual(url || optOut ? ["MAIL_SOURCE"] : ["APP_URL", "MAIL_SOURCE"]);
        // The fixed rule only: the loopback hosts it names, never the APP_URL given.
        if (url || optOut) expect(err.message).toBe(FIXTURE_REFUSED);
      }
    });

    it("starts the scheduler check's servers: loopback APP_URL, fixture mail, a throwaway key", () => {
      stubEnv({ ...COMPLETE, APP_URL: "http://127.0.0.1:3897", MAIL_SOURCE: "fixture", INBOX_SCHEDULER: "on" });
      expect(() => checkEnv(() => {}, "production")).not.toThrow();
    });

    it("starts without sign-in or Gmail with ALLOW_PARTIAL_SETUP=on, and logs what is off", () => {
      stubEnv({ DATABASE_URL, ALLOW_PARTIAL_SETUP: "on" });
      const lines: string[] = [];
      checkEnv((line) => lines.push(line), "production");
      expect(lines).toEqual([
        "env: sign-in is locked, every request is signed out (missing: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS, APP_URL)",
        "env: Gmail is not set up (missing: INBOX_TOKEN_KEY)",
      ]);

      stubEnv({ ...COMPLETE, INBOX_TOKEN_KEY: "", ALLOW_PARTIAL_SETUP: "on" });
      lines.length = 0;
      checkEnv((line) => lines.push(line), "production");
      expect(lines).toEqual(["env: Gmail is not set up (missing: INBOX_TOKEN_KEY)"]);
    });

    it("still needs DATABASE_URL with ALLOW_PARTIAL_SETUP=on", () => {
      const err = startError({ ...SIGN_IN, INBOX_TOKEN_KEY: KEY, ALLOW_PARTIAL_SETUP: "on" });
      expect(err.variables).toEqual(["DATABASE_URL"]);
      expect(err.message).not.toMatch(OPT_OUT);
    });

    it("treats ALLOW_PARTIAL_SETUP=off as unset", () => {
      expect(startError({ DATABASE_URL, ...SIGN_IN, ALLOW_PARTIAL_SETUP: "off" }).variables).toEqual(["INBOX_TOKEN_KEY"]);
    });

    it("stops the start on a malformed ALLOW_PARTIAL_SETUP, in every NODE_ENV, without quoting it", () => {
      for (const nodeEnv of ["production", "development", "test"]) {
        const err = startError({ ...COMPLETE, ALLOW_PARTIAL_SETUP: "zz-yes-zz" }, nodeEnv);
        expect(err.variables).toEqual(["ALLOW_PARTIAL_SETUP"]);
        expect(err.message).toBe('Invalid environment: ALLOW_PARTIAL_SETUP must be "on" or "off".');
      }
    });

    it("never quotes a value", () => {
      const values = { ...COMPLETE, APP_URL: "", MAIL_SOURCE: "fixture", INBOX_TOKEN_KEY_PREVIOUS: "b".repeat(64) };
      const message = startError(values).message;
      for (const [name, value] of Object.entries(values)) {
        if (value && name !== "MAIL_SOURCE") expect(message).not.toContain(value);
      }
      for (const part of ["pw-1234", ":5432", "GOCSPX", "apps.googleusercontent", "@example.com", "aaaa"]) {
        expect(message).not.toContain(part);
      }
    });

    it("reads NODE_ENV from process.env by default", () => {
      stubEnv({ DATABASE_URL, MAIL_SOURCE: "fixture" });
      vi.stubEnv("NODE_ENV", "production");
      expect(() => checkEnv(() => {})).toThrow(/MAIL_SOURCE must not be fixture in production/);
      vi.stubEnv("NODE_ENV", "test");
      expect(() => checkEnv(() => {})).not.toThrow();
    });
  });

  // CI runs the tests with MAIL_SOURCE=fixture and NODE_ENV=test; `next dev` runs development.
  it.each(["development", "test"])("stays lenient with NODE_ENV %s, whatever ALLOW_PARTIAL_SETUP says", (nodeEnv) => {
    for (const optOut of ["", "off", "on"]) {
      stubEnv({ DATABASE_URL, MAIL_SOURCE: "fixture", ALLOW_PARTIAL_SETUP: optOut });
      const lines: string[] = [];
      checkEnv((line) => lines.push(line), nodeEnv);
      expect(lines).toEqual([
        "env: sign-in is locked, every request is signed out (missing: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS, APP_URL)",
        "env: Gmail is not set up (missing: INBOX_TOKEN_KEY)",
        "env: MAIL_SOURCE is fixture, the inbox reads fixture mail instead of Gmail",
      ]);
    }
    // Only DATABASE_URL stops the start there, alone in the message, as before.
    stubEnv({ MAIL_SOURCE: "fixture" });
    expect(() => checkEnv(() => {}, nodeEnv)).toThrow(
      /^Invalid environment: DATABASE_URL is missing; the app cannot start without it\.$/,
    );
  });
});
