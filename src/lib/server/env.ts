import "server-only";
import { z } from "zod";

/**
 * Server configuration, from environment variables only. The names are listed in
 * docs/plan/README.md ("Environment variables") and .env.example.
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
 *   signInConfig(): SignInConfig | null
 *                                 what sign-in needs, or null when sign-in is locked
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
}

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
} as const;

type Name = keyof typeof PROBLEMS;
const NAMES = Object.keys(PROBLEMS) as Name[];

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

/**
 * A URL postgres.js 3 can parse. Its parser (parseUrl in postgres/src/index.js, mirrored here)
 * runs when the client is created; a URL it cannot read would throw there instead, with an error
 * that carries the whole connection string (Node's TypeError keeps its `input`).
 */
function isPostgresUrl(value: string): boolean {
  if (!/^postgres(ql)?:\/\/\S+$/.test(value)) return false;
  try {
    const authority = value.slice(value.indexOf("://") + 3).split(/[?/]/)[0];
    const host = decodeURIComponent(authority.slice(authority.indexOf("@") + 1));
    const url = new URL(value.replace(host, host.split(",")[0]));
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return true;
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
});

/** Parses an environment (process.env or a test object). Throws EnvError on malformed values. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  const broken = new Set<Name>();
  for (const issue of result.error?.issues ?? []) broken.add(issue.path[0] as Name);
  const problems: Array<[Name, string]> = NAMES.filter((name) => broken.has(name)).map((name) => [
    name,
    PROBLEMS[name],
  ]);
  // A previous key is only used beside a current one; alone it would leave Gmail off unnoticed.
  if (!broken.has("INBOX_TOKEN_KEY_PREVIOUS") && present(source.INBOX_TOKEN_KEY_PREVIOUS) && !present(source.INBOX_TOKEN_KEY)) {
    problems.push(["INBOX_TOKEN_KEY_PREVIOUS", "is set but INBOX_TOKEN_KEY is not"]);
  }
  if (!result.success || problems.length > 0) throw new EnvError(problems);

  const v = result.data;
  return Object.freeze({
    databaseUrl: v.DATABASE_URL ?? null,
    appOrigin: v.APP_URL ?? null,
    googleClientId: v.GOOGLE_CLIENT_ID ?? null,
    googleClientSecret: v.GOOGLE_CLIENT_SECRET ?? null,
    allowedEmails: v.ALLOWED_EMAILS ? new Set(v.ALLOWED_EMAILS) : null,
    inboxTokenKey: v.INBOX_TOKEN_KEY ?? null,
    inboxTokenKeyPrevious: v.INBOX_TOKEN_KEY_PREVIOUS ?? null,
    mailSource: v.MAIL_SOURCE ?? "gmail",
    inboxSchedulerEnabled: (v.INBOX_SCHEDULER ?? "on") === "on",
    inboxBackfillDays: v.INBOX_BACKFILL_DAYS ?? 30,
    allowPartialSetup: v.ALLOW_PARTIAL_SETUP === "on",
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

/** Hosts of an APP_URL that only this machine reaches (URL.hostname spelling). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** APP_URL is an http origin on the loopback: fixture mail may run a production build there. */
function isLoopbackApp(env: Env): boolean {
  if (!env.appOrigin) return false;
  const url = new URL(env.appOrigin);
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** Follows the missing variables in production's error: what the opt-out does. */
const PARTIAL_SETUP_NOTE =
  "Production needs sign-in and Gmail set up; ALLOW_PARTIAL_SETUP=on starts without them, with those features off.";

/**
 * Start-up check, called from src/instrumentation.ts. Throws EnvError, which stops the start, on
 * a malformed value or a missing DATABASE_URL; with `nodeEnv` "production" also on
 * MAIL_SOURCE=fixture (unless APP_URL is an http loopback origin), and on a missing sign-in
 * value or INBOX_TOKEN_KEY unless ALLOW_PARTIAL_SETUP is on. Every problem is named in one
 * message. Otherwise logs one line per feature that is off.
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
  // Strict only where the deploy's health check can catch it; development keeps locked mode.
  const strict = production && !env.allowPartialSetup && missing.length > 0;

  const problems: Array<[string, string]> = [];
  if (!env.databaseUrl) problems.push(["DATABASE_URL", "is missing; the app cannot start without it"]);
  if (strict) for (const name of missing) problems.push([name, "is missing"]);
  // Fixture mail is invented, and real job data must never receive it. ALLOW_PARTIAL_SETUP does
  // not cover it; only a loopback APP_URL does, which no one outside this machine can use.
  if (production && env.mailSource === "fixture" && !isLoopbackApp(env)) {
    problems.push([
      "MAIL_SOURCE",
      "must not be fixture in production unless APP_URL is an http origin on 127.0.0.1, localhost or [::1]; fixture mail is for development, tests and CI",
    ]);
  }
  if (problems.length > 0) throw new EnvError(problems, strict ? PARTIAL_SETUP_NOTE : undefined);

  if (locked.length > 0) log(`env: sign-in is locked, every request is signed out (missing: ${locked.join(", ")})`);
  if (!env.inboxTokenKey) log("env: Gmail is not set up (missing: INBOX_TOKEN_KEY)");
  if (env.mailSource === "fixture") log("env: MAIL_SOURCE is fixture, the inbox reads fixture mail instead of Gmail");
  if (!env.inboxSchedulerEnabled) log("env: INBOX_SCHEDULER is off, the inbox is checked only on request");
}

/** What sign-in needs, or null when it is locked. */
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
