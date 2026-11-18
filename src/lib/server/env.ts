import "server-only";
import { z } from "zod";

/**
 * Server configuration, from environment variables only. The names are listed in README.md
 * ("Environment variables") and .env.example.
 *
 * - Read lazily, never at import time: `next build` runs without any environment.
 * - An empty or blank value counts as missing. Outside production a missing value switches its
 *   feature off; only DATABASE_URL is needed to start. Without the Google client, ALLOWED_EMAILS
 *   or APP_URL, sign-in is locked: every request is treated as signed out. Without
 *   INBOX_TOKEN_KEY, Gmail is not set up.
 * - In production (NODE_ENV=production) checkEnv() is strict, so a deploy that lost a setting
 *   rolls back instead of starting with a feature quietly off:
 *   - sign-in (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS, APP_URL) and
 *     INBOX_TOKEN_KEY must be set. ALLOW_PARTIAL_SETUP=on is the opt-out for a self-hoster who
 *     wants locked mode or no Gmail: then a missing value switches its feature off, as outside
 *     production.
 *   - MAIL_SOURCE=fixture stops the start (ALLOW_PARTIAL_SETUP does not change that): fixture
 *     mail is invented and is for development, tests and CI, never for real job data. The one
 *     exception (owner, 2026-11-17) is an APP_URL that is an http origin on this machine's
 *     loopback (127.0.0.1, localhost or [::1], any port): a production build run locally, such
 *     as scripts/scheduler-check.mts, which no browser elsewhere can reach. An https APP_URL,
 *     any other host, or none is refused.
 * - DEMO_MODE=on makes this copy the public demo (docs/plan/5-public-demo.md): visitors get
 *   throwaway workspaces with invented data; Google sign-in, Gmail and the timed inbox syncs are
 *   off. It starts with DATABASE_URL and APP_URL alone. Its rules hold in every NODE_ENV, so the
 *   real app cannot become a demo by accident:
 *   - parseEnv(): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS, INBOX_TOKEN_KEY,
 *     INBOX_TOKEN_KEY_PREVIOUS, ALLOW_PARTIAL_SETUP and DEMO_URL must not be set at all (any
 *     present value, even ALLOW_PARTIAL_SETUP=off): the real app cannot start without some of
 *     them. The database name in DATABASE_URL must end in _demo, _dev or _test. MAIL_SOURCE
 *     defaults to fixture and gmail is an error; INBOX_SCHEDULER defaults to off and on is an
 *     error (off stops the timed syncs only; the scheduler's clean-ups still run).
 *   - checkEnv(): APP_URL must be set, because cookies and the Origin check are built from it. In
 *     production it must be https (the session cookie's __Host- prefix), except an http origin
 *     on the loopback, as for fixture mail: CI and local smoke runs of a production build. The
 *     production rules for sign-in, INBOX_TOKEN_KEY and fixture mail do not apply.
 * - DEMO_URL is for the real app: the demo's origin, which its sign-in page links to. https, or
 *   http on the loopback; never APP_URL's own origin.
 * - A value that is present but malformed is an error. checkEnv() turns it into a failed start,
 *   so a bad deploy rolls back. Messages name the variable and the rule, never the value.
 *
 * API
 *   getEnv(): Env                 every value, parsed once and memoized. Throws EnvError on a
 *                                 malformed value, never on a missing one.
 *   checkEnv(log?, nodeEnv?): void
 *                                 start-up check (src/instrumentation.ts): throws EnvError on a
 *                                 malformed value, a missing DATABASE_URL, or (when `nodeEnv`,
 *                                 default process.env.NODE_ENV, is "production") the rules
 *                                 above; logs what is off.
 *   signInMode(): SignInMode      "demo" when DEMO_MODE is on, "google" when signInConfig() is
 *                                 not null, else "locked"
 *   signInConfig(): SignInConfig | null
 *                                 what Google sign-in needs, or null when it is off: sign-in is
 *                                 locked, or this is the demo (it has no Google values)
 *   appUrl(): URL | null          APP_URL as an origin URL (path "/"); build redirects with
 *                                 new URL("/login", appUrl())
 *   appOrigin(): string | null    "https://host[:port]": what a browser sends as Origin
 *   isSecureApp(): boolean        APP_URL is https: the session cookie is Secure with the
 *                                 __Host- prefix. False when APP_URL is missing.
 *   inboxTokenKeys(): InboxTokenKeys | null
 *                                 the Gmail token keys, or null when INBOX_TOKEN_KEY is missing
 *   parseEnv(source): Env         the parser alone, for tests
 *   resetEnvForTests(): void      forget the memoized values after changing process.env
 *
 * The accessors take an optional Env (default getEnv()), so tests can pass parseEnv({ ... }).
 */

export interface Env {
  databaseUrl: string | null;
  /** APP_URL reduced to its origin, e.g. "https://example.com" (no trailing slash). */
  appOrigin: string | null;
  googleClientId: string | null;
  googleClientSecret: string | null;
  /** Lower-cased addresses; null when ALLOWED_EMAILS is missing. */
  allowedEmails: ReadonlySet<string> | null;
  /** 64 lower-case hex characters. */
  inboxTokenKey: string | null;
  inboxTokenKeyPrevious: string | null;
  mailSource: "gmail" | "fixture";
  inboxSchedulerEnabled: boolean;
  inboxBackfillDays: number;
  /** ALLOW_PARTIAL_SETUP=on: production may start without sign-in or Gmail (checkEnv). */
  allowPartialSetup: boolean;
  /**
   * DEMO_MODE=on: this copy is the public demo. Then every Google value is null, mailSource is
   * "fixture" and inboxSchedulerEnabled is false (parseEnv refuses anything else).
   */
  demoMode: boolean;
  /**
   * DEMO_URL reduced to its origin, e.g. "https://demo.example.com" (no trailing slash): the demo
   * the real app's sign-in page links to. Always null in demo mode.
   */
  demoUrl: string | null;
}

/** Who may sign in, and how: see signInMode(). */
export type SignInMode = "google" | "demo" | "locked";

export interface SignInConfig {
  clientId: string;
  clientSecret: string;
  allowedEmails: ReadonlySet<string>;
  appUrl: URL;
}

export interface InboxTokenKeys {
  /** 32 bytes: encrypts new tokens and decrypts. */
  current: Buffer;
  /** 32 bytes while a rotation is under way: decrypts only. */
  previous: Buffer | null;
}

/**
 * A malformed environment. The message names variables and rules, never values; `note` follows
 * the list when the problems share a reason.
 */
export class EnvError extends Error {
  readonly variables: string[];

  constructor(problems: Array<[name: string, problem: string]>, note?: string) {
    const list = problems.map(([name, problem]) => `${name} ${problem}`).join("; ");
    super(`Invalid environment: ${list}.${note ? ` ${note}` : ""}`);
    this.name = "EnvError";
    this.variables = problems.map(([name]) => name);
  }
}

// The rule each variable breaks, in a fixed wording: zod's own messages could quote the value.
const PROBLEMS = {
  DATABASE_URL: "must be a PostgreSQL connection URL starting with postgres:// or postgresql://",
  APP_URL:
    "must be an http or https origin such as https://example.com, without a path, query, fragment or credentials",
  GOOGLE_CLIENT_ID: "must be a single value without spaces",
  GOOGLE_CLIENT_SECRET: "must be a single value without spaces",
  ALLOWED_EMAILS: "must be a comma-separated list of email addresses",
  INBOX_TOKEN_KEY: "must be 64 hexadecimal characters (32 random bytes)",
  INBOX_TOKEN_KEY_PREVIOUS: "must be 64 hexadecimal characters (32 random bytes)",
  MAIL_SOURCE: 'must be "gmail" or "fixture"',
  INBOX_SCHEDULER: 'must be "on" or "off"',
  INBOX_BACKFILL_DAYS: "must be a whole number of days from 1 to 365",
  ALLOW_PARTIAL_SETUP: 'must be "on" or "off"',
  DEMO_MODE: 'must be "on" or "off"',
  DEMO_URL:
    "must be an https origin such as https://example.com, without a path, query, fragment or credentials (http only on 127.0.0.1, localhost or [::1])",
} as const;

type Name = keyof typeof PROBLEMS;
const NAMES = Object.keys(PROBLEMS) as Name[];

/**
 * The real app's values, which a demo must not have: DEMO_MODE=on beside any of them (any
 * present value) is an error. The real app cannot start without the Google values and
 * INBOX_TOKEN_KEY (or ALLOW_PARTIAL_SETUP), so it cannot start as a demo either.
 */
const NOT_IN_DEMO = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ALLOWED_EMAILS",
  "INBOX_TOKEN_KEY",
  "INBOX_TOKEN_KEY_PREVIOUS",
  "ALLOW_PARTIAL_SETUP",
  "DEMO_URL",
] as const satisfies readonly Name[];

// The demo's rules between variables, in fixed wordings too.
const DEMO_PROBLEMS = {
  notInDemo: "must not be set when DEMO_MODE is on",
  database: "must name a database whose name ends in _demo, _dev or _test when DEMO_MODE is on",
  mailSource: "must not be gmail when DEMO_MODE is on; the demo reads fixture mail",
  scheduler: "must not be on when DEMO_MODE is on; timed syncs would file the demo mail before the visitor asks",
} as const;

/** Follows the list when a demo rule was broken: how the real app could have hit it. */
const DEMO_NOTE =
  "DEMO_MODE=on runs the public demo, without Google sign-in or Gmail; the real app must not set it.";

/** Blank counts as missing; anything else is trimmed. */
const present = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(present, schema.optional());

const token = z.string().regex(/^\S+$/);
const hexKey = z
  .string()
  .regex(/^[0-9a-f]{64}$/i)
  .transform((s) => s.toLowerCase());

function isOrigin(value: string): boolean {
  // Checked on the raw text: the URL parser drops an empty "?" or "#".
  if (/[?#]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.hostname !== "" &&
    url.pathname === "/" &&
    url.username === "" &&
    url.password === ""
  );
}

/** Hosts of an origin that only this machine reaches (URL.hostname spelling). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** An http origin on this machine's loopback, any port: no browser elsewhere can reach it. */
function isLoopbackHttp(origin: string): boolean {
  const url = new URL(origin);
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** DEMO_URL: an origin as APP_URL, https or else http on the loopback. */
function isDemoOrigin(value: string): boolean {
  return isOrigin(value) && (new URL(value).protocol === "https:" || isLoopbackHttp(value));
}

/**
 * The URL as postgres.js 3 reads it, or null when it cannot. Its parser (parseUrl in
 * postgres/src/index.js, mirrored here) runs when the client is created; a URL it cannot read
 * would throw there instead, with an error that carries the whole connection string (Node's
 * TypeError keeps its `input`).
 */
function readPostgresUrl(value: string): URL | null {
  if (!/^postgres(ql)?:\/\/\S+$/.test(value)) return null;
  try {
    const authority = value.slice(value.indexOf("://") + 3).split(/[?/]/)[0];
    const host = decodeURIComponent(authority.slice(authority.indexOf("@") + 1));
    const url = new URL(value.replace(host, host.split(",")[0]));
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url;
  } catch {
    return null;
  }
}

const isPostgresUrl = (value: string) => readPostgresUrl(value) !== null;

/**
 * Every database name in a DATABASE_URL ends in _demo, _dev or _test: the path (URL-decoded) and
 * any `database` query parameter, which postgres.js sends after the path's name, so it would win
 * (parseOptions and StartupMessage in postgres/src). No name at all is refused too: postgres.js
 * would fall back to PGDATABASE or the user name.
 */
function isDemoDatabase(value: string): boolean {
  const url = readPostgresUrl(value);
  if (!url) return false;
  try {
    const names = [decodeURIComponent(url.pathname.slice(1)), ...url.searchParams.getAll("database")];
    return names.every((name) => /_(demo|dev|test)$/.test(name));
  } catch {
    return false;
  }
}

const schema = z.object({
  DATABASE_URL: optional(z.string().refine(isPostgresUrl)),
  APP_URL: optional(
    z
      .string()
      .refine(isOrigin)
      .transform((s) => new URL(s).origin),
  ),
  GOOGLE_CLIENT_ID: optional(token),
  GOOGLE_CLIENT_SECRET: optional(token),
  ALLOWED_EMAILS: optional(
    z
      .string()
      .transform((s) =>
        s
          .split(",")
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      )
      .pipe(z.array(z.email()).min(1)),
  ),
  INBOX_TOKEN_KEY: optional(hexKey),
  INBOX_TOKEN_KEY_PREVIOUS: optional(hexKey),
  MAIL_SOURCE: optional(z.enum(["gmail", "fixture"])),
  INBOX_SCHEDULER: optional(z.enum(["on", "off"])),
  INBOX_BACKFILL_DAYS: optional(
    z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(365)),
  ),
  ALLOW_PARTIAL_SETUP: optional(z.enum(["on", "off"])),
  DEMO_MODE: optional(z.enum(["on", "off"])),
  DEMO_URL: optional(
    z
      .string()
      .refine(isDemoOrigin)
      .transform((s) => new URL(s).origin),
  ),
});

/**
 * Parses an environment (process.env or a test object). Throws EnvError on malformed values and
 * on the demo's rules (see the top of this file). One problem per variable, listed in a fixed
 * order: in demo mode a real-app value is named as "must not be set" even when it is also
 * malformed, since it has to go either way.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  const found = new Map<Name, string>();
  const demo = present(source.DEMO_MODE) === "on";
  let demoRule = false;
  if (demo) {
    for (const name of NOT_IN_DEMO) {
      if (present(source[name]) === undefined) continue;
      found.set(name, DEMO_PROBLEMS.notInDemo);
      demoRule = true;
    }
  }
  for (const issue of result.error?.issues ?? []) {
    const name = issue.path[0] as Name;
    if (!found.has(name)) found.set(name, PROBLEMS[name]);
  }
  /** The trimmed value of a variable that is present and has no problem yet. */
  const valid = (name: Name) => (found.has(name) ? undefined : present(source[name]));

  // A previous key is only used beside a current one; alone it would leave Gmail off unnoticed.
  if (valid("INBOX_TOKEN_KEY_PREVIOUS") && !present(source.INBOX_TOKEN_KEY)) {
    found.set("INBOX_TOKEN_KEY_PREVIOUS", "is set but INBOX_TOKEN_KEY is not");
  }
  // A link from the app to itself; both are valid origins here.
  const demoUrl = valid("DEMO_URL");
  const app = valid("APP_URL");
  if (demoUrl && app && new URL(demoUrl).origin === new URL(app).origin) {
    found.set("DEMO_URL", "must not be the same origin as APP_URL");
  }
  if (demo) {
    const databaseUrl = valid("DATABASE_URL");
    const broken: Array<[Name, string]> = [];
    if (databaseUrl && !isDemoDatabase(databaseUrl)) broken.push(["DATABASE_URL", DEMO_PROBLEMS.database]);
    if (valid("MAIL_SOURCE") === "gmail") broken.push(["MAIL_SOURCE", DEMO_PROBLEMS.mailSource]);
    if (valid("INBOX_SCHEDULER") === "on") broken.push(["INBOX_SCHEDULER", DEMO_PROBLEMS.scheduler]);
    for (const [name, problem] of broken) found.set(name, problem);
    demoRule ||= broken.length > 0;
  }

  if (!result.success || found.size > 0) {
    const problems = NAMES.filter((name) => found.has(name)).map((name): [Name, string] => [name, found.get(name)!]);
    throw new EnvError(problems, demoRule ? DEMO_NOTE : undefined);
  }

  const v = result.data;
  return Object.freeze({
    databaseUrl: v.DATABASE_URL ?? null,
    appOrigin: v.APP_URL ?? null,
    googleClientId: v.GOOGLE_CLIENT_ID ?? null,
    googleClientSecret: v.GOOGLE_CLIENT_SECRET ?? null,
    allowedEmails: v.ALLOWED_EMAILS ? new Set(v.ALLOWED_EMAILS) : null,
    inboxTokenKey: v.INBOX_TOKEN_KEY ?? null,
    inboxTokenKeyPrevious: v.INBOX_TOKEN_KEY_PREVIOUS ?? null,
    mailSource: v.MAIL_SOURCE ?? (demo ? "fixture" : "gmail"),
    inboxSchedulerEnabled: (v.INBOX_SCHEDULER ?? (demo ? "off" : "on")) === "on",
    inboxBackfillDays: v.INBOX_BACKFILL_DAYS ?? 30,
    allowPartialSetup: v.ALLOW_PARTIAL_SETUP === "on",
    demoMode: demo,
    demoUrl: v.DEMO_URL ?? null,
  });
}

let memo: Env | undefined;

/** Every value, parsed on first use. Throws EnvError on a malformed value (not memoized). */
export function getEnv(): Env {
  memo ??= parseEnv(process.env);
  return memo;
}

/** Forget the memoized values, after a test changed process.env (vi.stubEnv). */
export function resetEnvForTests(): void {
  memo = undefined;
}

/** Variables sign-in needs that are missing; empty when sign-in is configured. */
function missingForSignIn(env: Env): string[] {
  const missing: string[] = [];
  if (!env.googleClientId) missing.push("GOOGLE_CLIENT_ID");
  if (!env.googleClientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (!env.allowedEmails) missing.push("ALLOWED_EMAILS");
  if (!env.appOrigin) missing.push("APP_URL");
  return missing;
}

/**
 * APP_URL is an http origin on the loopback: a production build that only this machine reaches.
 * It may use fixture mail, and a demo there may run without https.
 */
function isLoopbackApp(env: Env): boolean {
  return env.appOrigin !== null && isLoopbackHttp(env.appOrigin);
}

/** Follows the missing variables in production's error: what the opt-out does. */
const PARTIAL_SETUP_NOTE =
  "Production needs sign-in and Gmail set up; ALLOW_PARTIAL_SETUP=on starts without them, with those features off.";

/** The one line checkEnv() logs in demo mode, instead of one per feature that is off. */
const DEMO_LINE =
  "env: DEMO_MODE is on: Google sign-in, Gmail and the timed inbox syncs are off; visitors get throwaway workspaces";

/**
 * Start-up check, called from src/instrumentation.ts. Throws EnvError, which stops the start, on
 * a malformed value or a missing DATABASE_URL; with `nodeEnv` "production" also on
 * MAIL_SOURCE=fixture (unless APP_URL is an http loopback origin), and on a missing sign-in
 * value or INBOX_TOKEN_KEY unless ALLOW_PARTIAL_SETUP is on. Every problem is named in one
 * message. Otherwise logs one line per feature that is off.
 *
 * In demo mode (DEMO_MODE=on) it throws on a missing APP_URL in every NODE_ENV, and in
 * production on an APP_URL that is not https unless it is an http loopback origin; the
 * production rules for sign-in, INBOX_TOKEN_KEY and fixture mail do not apply. It logs DEMO_LINE
 * only.
 *
 * `nodeEnv` is a parameter so tests can check production. In a production build Next.js inlines
 * process.env.NODE_ENV as "production" (build/define-env.js), so `next start` is always strict,
 * whatever NODE_ENV the server's environment sets.
 */
export function checkEnv(
  log: (line: string) => void = (line) => console.warn(line),
  nodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  const env = getEnv();
  const production = nodeEnv === "production";
  const locked = missingForSignIn(env);
  const missing = env.inboxTokenKey ? locked : [...locked, "INBOX_TOKEN_KEY"];
  // Strict only where the deploy's health check can catch it; development keeps locked mode. A
  // demo has none of these values by design (parseEnv refuses them).
  const strict = production && !env.demoMode && !env.allowPartialSetup && missing.length > 0;

  const problems: Array<[string, string]> = [];
  if (!env.databaseUrl) problems.push(["DATABASE_URL", "is missing; the app cannot start without it"]);
  if (strict) for (const name of missing) problems.push([name, "is missing"]);
  // The demo's session cookie, its redirects and the Origin check are built from APP_URL: without
  // it every visitor would be turned away, in development too.
  if (env.demoMode && !env.appOrigin) {
    problems.push(["APP_URL", "is missing; DEMO_MODE=on needs it in every environment"]);
  } else if (env.demoMode && production && !isSecureApp(env) && !isLoopbackApp(env)) {
    problems.push([
      "APP_URL",
      "must be https when DEMO_MODE is on in production, unless it is an http origin on 127.0.0.1, localhost or [::1]",
    ]);
  }
  // Fixture mail is invented, and real job data must never receive it. ALLOW_PARTIAL_SETUP does
  // not cover it; only a loopback APP_URL does, which no one outside this machine can use. The
  // demo is the other exception: invented mail is all it has, in workspaces of invented data.
  if (production && env.mailSource === "fixture" && !isLoopbackApp(env) && !env.demoMode) {
    problems.push([
      "MAIL_SOURCE",
      "must not be fixture in production unless APP_URL is an http origin on 127.0.0.1, localhost or [::1]; fixture mail is for development, tests and CI",
    ]);
  }
  if (problems.length > 0) throw new EnvError(problems, strict ? PARTIAL_SETUP_NOTE : undefined);

  if (env.demoMode) {
    log(DEMO_LINE);
    return;
  }
  if (locked.length > 0) log(`env: sign-in is locked, every request is signed out (missing: ${locked.join(", ")})`);
  if (!env.inboxTokenKey) log("env: Gmail is not set up (missing: INBOX_TOKEN_KEY)");
  if (env.mailSource === "fixture") log("env: MAIL_SOURCE is fixture, the inbox reads fixture mail instead of Gmail");
  if (!env.inboxSchedulerEnabled) log("env: INBOX_SCHEDULER is off, the inbox is checked only on request");
}

/**
 * Who may sign in: "demo" when DEMO_MODE is on (visitors enter throwaway workspaces), "google"
 * when signInConfig() is not null (the allowlisted Google accounts), else "locked" (nobody).
 */
export function signInMode(env: Env = getEnv()): SignInMode {
  if (env.demoMode) return "demo";
  return signInConfig(env) ? "google" : "locked";
}

/**
 * What Google sign-in needs, or null when it is off: sign-in is locked, or this is the demo
 * (parseEnv refuses the Google values there, so this stays null without checking demoMode).
 */
export function signInConfig(env: Env = getEnv()): SignInConfig | null {
  if (!env.googleClientId || !env.googleClientSecret || !env.allowedEmails || !env.appOrigin) return null;
  return {
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    allowedEmails: env.allowedEmails,
    appUrl: new URL(env.appOrigin),
  };
}

/** APP_URL as a fresh URL (path "/"), or null when it is missing. */
export function appUrl(env: Env = getEnv()): URL | null {
  return env.appOrigin ? new URL(env.appOrigin) : null;
}

/** APP_URL's origin ("https://host[:port]"), or null when it is missing. */
export function appOrigin(env: Env = getEnv()): string | null {
  return env.appOrigin;
}

/** True when APP_URL is https: cookies get Secure and the __Host- prefix. */
export function isSecureApp(env: Env = getEnv()): boolean {
  return env.appOrigin?.startsWith("https:") ?? false;
}

/** The keys for the Gmail refresh token, or null when INBOX_TOKEN_KEY is missing. */
export function inboxTokenKeys(env: Env = getEnv()): InboxTokenKeys | null {
  if (!env.inboxTokenKey) return null;
  return {
    current: Buffer.from(env.inboxTokenKey, "hex"),
    previous: env.inboxTokenKeyPrevious ? Buffer.from(env.inboxTokenKeyPrevious, "hex") : null,
  };
}
