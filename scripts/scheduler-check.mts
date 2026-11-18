// The inbox scheduler under a real `next start` (plan step 2.6, "Done when"): one scheduler per
// process, a restart mid-sync without duplicates, and a stop within 10 seconds.
//
//   npx tsx --conditions=react-server scripts/scheduler-check.mts [--dir <checkout>] [--port 3897]
//       [--out <folder for the server logs>] [--keep]
//
// Needs a production build of the code under test in <dir> (default: this checkout), made with
// no environment: `next build` there first. <dir> must also hold fixtures/mail. Takes about
// eight minutes, most of it waiting for the scheduler's 60-second ticks and a 3-minute lease.
//
// Safe by construction:
//   - Database: two throwaway schemas in the TEST database (TEST_DATABASE_URL from the
//     environment or .env.local), created, migrated and dropped here (--keep keeps them). The
//     server gets DATABASE_URL = that URL with search_path set to the schema, so the database's
//     other schemas (the tests', the development data) are never touched. Never production.
//   - Mail: MAIL_SOURCE=fixture (fixtures/mail), so nothing talks to Google. Sign-in gets
//     invented values; the one request the check makes uses a session inserted here.
//   - Strict production start (src/lib/server/env.ts checkEnv): the servers get a complete
//     configuration, as the deploy does. Production allows fixture mail only with an http
//     APP_URL on the loopback, and the servers get http://127.0.0.1:<port>. INBOX_TOKEN_KEY is a
//     random key made for this run: production needs one, and demo mode stores no token, so
//     nothing is ever encrypted with it.
//   - Port: --port (default 3897), never 3800 (the owner's development server).
//   - Prints no connection string; the server logs go to --out (default: a new temporary folder).
//   Values in <dir>/.env.local are overridden by the ones set here (INBOX_TOKEN_KEY and the
//   previous key too, so a real key there is never used; ALLOW_PARTIAL_SETUP is off, so the
//   start is as strict as the deploy's).
//
// What it does, with one invented user whose demo inbox (14 fixture messages) is due:
//   1. Server 1. The script holds the user's jobs lock (lockUserJobs), so the scheduler's first
//      tick (60 s after start) stops inside the first scan, at its first job-related message. A
//      "Check inbox" request joins that run and waits. Then SIGINT (what PM2 sends), and the
//      lock is released: the message in hand finishes, the stop flag ends the run, the request
//      gets its answer and Next.js exits. Measured: the time from the signal to the exit.
//   2. Server 2. The lock again; the next tick resumes the scan and stops at the next message.
//      SIGKILL this time (a crash, or PM2 after 10 seconds): the open transaction is rolled back
//      and the run's lease is left behind.
//   3. Server 3, no lock. Its ticks find the lease busy until it expires, then finish the scan.
//      One more sync is asked for (next_sync_at = now) and must change nothing. Then SIGTERM.
//   Then the result is compared with a reference: the same user and mail in the second schema,
//   synced in one go by the engine in this process.
//
// The three properties:
//   - One scheduler per process: each server logs "inbox: scheduler started" exactly once, and
//     at most one scheduler line per tick. (The build: `next build` output must not contain
//     "inbox: scheduler"; check that when building.)
//   - Restart mid-sync without duplicates: after 1-3 the ledger holds the 14 messages once, each
//     finished; no email row and no status change twice; jobs, emails, review list, status
//     history and ledger equal the reference's; the extra sync changes nothing.
//   - Stops within 10 seconds: servers 1 and 3 exit within 10 s of the signal (with code 130 and
//     143, Next.js's own exit), server 1 while a request waited on a sync.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  type WriteStream,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import postgres from "postgres";
import { DEFAULT_RULES } from "@/lib/domain/defaults";
import { normalize } from "@/lib/domain/normalize";
import { setDbForTests, type Sql } from "@/lib/server/db/client";
import { newSessionToken, SESSION_COOKIE_PLAIN } from "@/lib/server/auth/session";
import { ensureDemoConnection } from "@/lib/server/inbox/repo";
import { lockUserJobs } from "@/lib/server/repo/jobs";
import { insertSession } from "@/lib/server/repo/sessions";
import { runMigrations } from "../db/migrate.mjs";
import { seedUser } from "../db/seed/seed";

const ENV_FILE = path.resolve(process.cwd(), ".env.local");
const TICK_MS = 60_000;
const STOP_LIMIT_MS = 10_000;
const FIXTURE_MESSAGES = 14;
/** The servers' INBOX_TOKEN_KEY: 32 random bytes for this run only (see the header). */
const TOKEN_KEY = randomBytes(32).toString("hex");

/* ---------------------------------------------------------------- options */

interface Options {
  dir: string;
  port: number;
  out: string;
  keep: boolean;
}

function options(argv: string[]): Options {
  const opts: Options = { dir: process.cwd(), port: 3897, out: "", keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--keep") opts.keep = true;
    else if (arg === "--dir") opts.dir = path.resolve(argv[++i] ?? "");
    else if (arg === "--port") opts.port = Number(argv[++i]);
    else if (arg === "--out") opts.out = path.resolve(argv[++i] ?? "");
    else throw new Usage(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535) throw new Usage("--port must be 1024 to 65535");
  if (opts.port === 3800) throw new Usage("--port 3800 is the development server's");
  return opts;
}

class Usage extends Error {}

/** The URL as read, to mask it in error messages. */
let knownUrl = "";

function testDatabaseUrl(): string {
  const url =
    process.env.TEST_DATABASE_URL ||
    (existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")).TEST_DATABASE_URL : undefined);
  if (!url) throw new Usage("TEST_DATABASE_URL is not set (environment or .env.local)");
  knownUrl = url;
  return url;
}

/** The URL with search_path as a startup parameter (postgres.js passes unknown query keys on). */
export function withSchema(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.set("search_path", schema);
  return u.toString();
}

/* ------------------------------------------------------------------ output */

const started = Date.now();
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function say(line: string) {
  console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s] ${line}`);
}

function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  say(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}

/* ----------------------------------------------------------------- servers */

interface Server {
  n: number;
  child: ChildProcess;
  lines: Array<{ at: number; line: string }>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
  log: WriteStream;
}

function startServer(n: number, opts: Options, databaseUrl: string, email: string): Server {
  const origin = `http://127.0.0.1:${opts.port}`;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "C.UTF-8",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_URL: databaseUrl,
    MAIL_SOURCE: "fixture",
    INBOX_SCHEDULER: "on",
    INBOX_TOKEN_KEY: TOKEN_KEY,
    INBOX_TOKEN_KEY_PREVIOUS: "",
    ALLOW_PARTIAL_SETUP: "off",
    APP_URL: origin,
    GOOGLE_CLIENT_ID: "scheduler-check-client",
    GOOGLE_CLIENT_SECRET: "scheduler-check-secret",
    ALLOWED_EMAILS: email,
  };
  // As PM2 runs it in production: node on Next's own bin, so the signals reach Next.js.
  const child = spawn(
    process.execPath,
    [path.join(opts.dir, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(opts.port)],
    { cwd: opts.dir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log = createWriteStream(path.join(opts.out, `server-${n}.log`));
  // A log that cannot be written must not end the check before its clean-up.
  log.on("error", () => {});
  running.add(child);
  child.on("exit", () => running.delete(child));
  const server: Server = {
    n,
    child,
    lines: [],
    log,
    exited: new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, at: Date.now() }))),
  };
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream?.on("data", (chunk: Buffer) => {
      const text = rest + chunk.toString("utf8");
      const parts = text.split("\n");
      rest = parts.pop() ?? "";
      for (const line of parts) {
        server.lines.push({ at: Date.now(), line });
        log.write(`${new Date().toISOString()} ${line}\n`);
      }
    });
  }
  say(`server ${n}: started (pid ${child.pid}), log in ${path.join(opts.out, `server-${n}.log`)}`);
  return server;
}

/** Servers still running: killed if this script dies before its own clean-up. */
const running = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of running) child.kill("SIGKILL");
});

const grep = (server: Server, text: string) => server.lines.filter((l) => l.line.includes(text));

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitReady(server: Server, opts: Options) {
  await waitFor(`server ${server.n} to answer /api/health`, 60_000, async () => {
    if (server.child.exitCode !== null) throw new Error(`server ${server.n} exited early (see its log)`);
    try {
      return (await fetch(`http://127.0.0.1:${opts.port}/api/health`)).status === 200;
    } catch {
      return false;
    }
  });
}

/** Sends `signal` and measures the time to the exit. */
async function stopServer(server: Server, signal: NodeJS.Signals): Promise<{ ms: number; code: number | null }> {
  const sent = Date.now();
  server.child.kill(signal);
  const exit = await Promise.race([
    server.exited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000)),
  ]);
  if (!exit) {
    server.child.kill("SIGKILL");
    await server.exited;
    return { ms: Infinity, code: null };
  }
  server.log.end();
  return { ms: exit.at - sent, code: exit.code };
}

/* ---------------------------------------------------------------- database */

export function client(url: string, schema: string, max = 3): Sql {
  return postgres(url, {
    max,
    prepare: false,
    onnotice: () => {},
    connection: { application_name: "scheduler-check", search_path: schema },
  });
}

/** A user as the first sign-in makes one, with the default rules, the demo data and the demo inbox. */
export async function demoUser(sql: Sql, now: number): Promise<{ id: string; email: string }> {
  const email = "check.owner@example.com";
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (google_sub, email, name) VALUES ('scheduler-check-sub', ${email}, 'Check Owner') RETURNING id`;
  await sql`INSERT INTO user_settings (user_id) VALUES (${user.id})`;
  for (const rule of DEFAULT_RULES) {
    await sql`
      INSERT INTO keyword_rules (user_id, status, phrase, phrase_norm, language)
      VALUES (${user.id}, ${rule.status}, ${rule.phrase}, ${normalize(rule.phrase)}, ${rule.language})`;
  }
  await sql.begin((tx) => seedUser(tx, user.id, now));
  await ensureDemoConnection(sql, user.id);
  return { id: user.id, email };
}

/** Holds the user's jobs lock in an open transaction until release(). */
export async function holdJobsLock(sql: Sql, userId: string): Promise<{ pid: number; release: () => Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: (pid: number) => void;
  const holding = new Promise<number>((resolve) => (held = resolve));
  const done = sql.begin(async (tx) => {
    const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await lockUserJobs(tx, userId);
    held(pid);
    await released;
  });
  const pid = await Promise.race([holding, done.then(() => -1)]);
  return {
    pid,
    release: async () => {
      release();
      await done;
    },
  };
}

/** A server backend waits for the lock `lockerPid` holds: the sync is stuck mid-scan. */
export async function someoneWaitsFor(sql: Sql, lockerPid: number): Promise<boolean> {
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM pg_locks w JOIN pg_locks h
      ON h.pid = ${lockerPid} AND h.granted AND h.locktype = 'advisory'
     AND w.locktype = 'advisory' AND NOT w.granted
     AND w.database = h.database AND w.classid = h.classid AND w.objid = h.objid AND w.objsubid = h.objsubid`;
  return n > 0;
}

export async function connectionRow(sql: Sql, userId: string) {
  const [row] = await sql<
    Array<{
      backfill_state: string;
      history_id: string | null;
      lease_owner: string | null;
      lease_until: Date | null;
      last_error_code: string | null;
      consecutive_failures: number;
      next_sync_at: Date | null;
      due: boolean;
    }>
  >`
    SELECT backfill_state, history_id, lease_owner, lease_until, last_error_code, consecutive_failures, next_sync_at,
           next_sync_at <= now() AS due
    FROM inbox_connections WHERE user_id = ${userId}`;
  return row;
}

/** What syncing left behind, without ids and times. */
export async function snapshot(sql: Sql, userId: string) {
  const [emails, jobs, ledger, events] = await Promise.all([
    sql`
      SELECT gmail_message_id, outcome, detected_status, change_from, change_to, review_reason
      FROM emails WHERE user_id = ${userId} ORDER BY gmail_message_id NULLS FIRST, subject, outcome`,
    sql`SELECT company, title, status FROM jobs WHERE user_id = ${userId} ORDER BY company, title, status`,
    sql`SELECT gmail_message_id, result FROM inbox_seen_messages WHERE user_id = ${userId} ORDER BY gmail_message_id`,
    sql`
      SELECT j.company, j.title, e.from_status, e.to_status, e.source
      FROM job_status_events e JOIN jobs j ON j.id = e.job_id
      WHERE e.user_id = ${userId} ORDER BY 1, 2, 3 NULLS FIRST, 4, 5`,
  ]);
  return JSON.stringify({ emails, jobs, ledger, events });
}

export async function duplicates(sql: Sql, userId: string): Promise<string[]> {
  const found: string[] = [];
  const [emails] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT gmail_message_id FROM emails WHERE user_id = ${userId} AND gmail_message_id IS NOT NULL
      GROUP BY 1 HAVING count(*) > 1) d`;
  if (emails.n) found.push(`${emails.n} Gmail messages stored twice`);
  const [events] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT email_id FROM job_status_events WHERE user_id = ${userId} AND email_id IS NOT NULL
      GROUP BY 1 HAVING count(*) > 1) d`;
  if (events.n) found.push(`${events.n} emails changed a status twice`);
  const [jobs] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT company, title FROM jobs WHERE user_id = ${userId} GROUP BY 1, 2 HAVING count(*) > 1) d`;
  if (jobs.n) found.push(`${jobs.n} jobs twice`);
  return found;
}

/** The built code contains the scheduler (a stale build would test the wrong thing). */
function buildHasScheduler(dir: string): boolean {
  const root = path.join(dir, ".next/server");
  if (!existsSync(path.join(dir, ".next/BUILD_ID")) || !existsSync(root)) return false;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    for (const name of readdirSync(current)) {
      const file = path.join(current, name);
      const stat = statSync(file);
      if (stat.isDirectory()) stack.push(file);
      else if (name.endsWith(".js") && stat.size < 20_000_000 && readFileSync(file, "utf8").includes("inbox: scheduler started")) {
        return true;
      }
    }
  }
  return false;
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<number> {
  const opts = options(process.argv.slice(2));
  if (!buildHasScheduler(opts.dir)) {
    throw new Usage(`no production build with the scheduler in ${opts.dir}/.next: run \`next build\` there first`);
  }
  if (!existsSync(path.join(opts.dir, "fixtures/mail"))) throw new Usage(`${opts.dir} has no fixtures/mail`);
  const inUse = await fetch(`http://127.0.0.1:${opts.port}/`).then(
    () => true,
    () => false,
  );
  if (inUse) throw new Usage(`port ${opts.port} is in use`);
  if (opts.out) mkdirSync(opts.out, { recursive: true });
  else opts.out = mkdtempSync(path.join(os.tmpdir(), "scheduler-check-"));

  const base = testDatabaseUrl();
  const suffix = `${process.pid}_${randomBytes(3).toString("hex")}`;
  const schema = `sched_check_${suffix}`;
  const refSchema = `sched_ref_${suffix}`;
  const admin = postgres(base, { max: 1, onnotice: () => {}, connection: { application_name: "scheduler-check" } });
  const sql = client(base, schema);
  const ref = client(base, refSchema);
  const servers: Server[] = [];
  const now = Date.now();
  let lock: { pid: number; release: () => Promise<void> } | null = null;

  try {
    for (const s of [schema, refSchema]) await admin.unsafe(`CREATE SCHEMA "${s}"`);
    await runMigrations(sql, { log: () => {} });
    await runMigrations(ref, { log: () => {} });
    const user = await demoUser(sql, now);
    say(`schemas ${schema} and ${refSchema} ready; the demo inbox is due`);
    const url = withSchema(base, schema);

    // 1. A run stuck mid-scan, a request waiting on it, SIGINT.
    lock = await holdJobsLock(sql, user.id);
    const s1 = startServer(1, opts, url, user.email);
    servers.push(s1);
    await waitReady(s1, opts);
    say("server 1: ready; waiting for the first tick to reach the held lock (up to 90 s)");
    const lockPid = lock.pid;
    await waitFor("the scheduler's sync to wait for the jobs lock", 90_000, () => someoneWaitsFor(sql, lockPid));
    say(`server 1: the scan is stuck at a message: ${JSON.stringify(await connectionRow(sql, user.id))}`);

    const { token, tokenHash } = newSessionToken();
    await insertSession(sql, user.id, tokenHash, 3600);
    const origin = `http://127.0.0.1:${opts.port}`;
    const request = fetch(`${origin}/api/inbox/check`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", cookie: `${SESSION_COOKIE_PLAIN}=${token}` },
      body: "{}",
    }).then(
      async (res) => ({ status: res.status, body: (await res.text()).slice(0, 300), at: Date.now() }),
      (err: unknown) => ({ status: 0, body: err instanceof Error ? err.message : "request failed", at: Date.now() }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const signalAt = Date.now();
    const stopping = stopServer(s1, "SIGINT");
    await lock.release();
    lock = null;
    const stop1 = await stopping;
    const answer = await request;
    // Next.js's server.close() also waits for the client to drop its idle keep-alive connection
    // (fetch keeps it about 3 s here), so the exit can come a little after the answer.
    check(
      "stop within 10 s (SIGINT, a request waiting on a sync)",
      stop1.ms < STOP_LIMIT_MS && stop1.code === 130,
      `exit after ${stop1.ms} ms with code ${stop1.code}; the waiting request was answered ${answer.at - signalAt} ms after the signal`,
    );
    // The run was started by the scheduler (instrumentation's bundle) and joined by the route (its
    // own bundle): the route must still recognise the run's "stopped" error and answer 502.
    check(
      "the waiting request gets the fixed \"stopped\" answer",
      answer.status === 502,
      `${answer.status} ${answer.body}`,
    );
    const after1 = await connectionRow(sql, user.id);
    check(
      "a stopped run records no failure and stays due",
      after1.last_error_code === null && after1.consecutive_failures === 0 && after1.due && after1.backfill_state === "running",
      JSON.stringify(after1),
    );
    check("server 1 logged the stop", grep(s1, "inbox: scheduler stopped (SIGINT)").length === 1, grep(s1, "inbox: scheduler stopped").map((l) => l.line).join(" | ") || "no line");

    // 2. Resumed and stuck again; a crash this time.
    lock = await holdJobsLock(sql, user.id);
    const s2 = startServer(2, opts, url, user.email);
    servers.push(s2);
    await waitReady(s2, opts);
    const lockPid2 = lock.pid;
    await waitFor("server 2's sync to wait for the jobs lock", 90_000, () => someoneWaitsFor(sql, lockPid2));
    s2.child.kill("SIGKILL");
    await s2.exited;
    s2.log.end();
    await lock.release();
    lock = null;
    const after2 = await connectionRow(sql, user.id);
    say(`server 2: killed mid-scan; left behind: ${JSON.stringify(after2)}`);

    // 3. A clean start: busy until the dead lease expires, then the rest of the scan.
    const s3 = startServer(3, opts, url, user.email);
    servers.push(s3);
    await waitReady(s3, opts);
    say("server 3: ready; waiting for the scan to finish once the old lease expires (up to 6 minutes)");
    await waitFor("the first scan to finish", 6 * 60_000, async () => {
      const row = await connectionRow(sql, user.id);
      return row.backfill_state === "done" && row.lease_owner === null;
    });
    // The tick's own line comes after its sweeps.
    await waitFor("the tick that finished the scan to log", 30_000, () => grep(s3, "inbox: scheduler: synced").length > 0);
    const resumed = await snapshot(sql, user.id);
    say("server 3: scan finished; asking for one more sync");
    await sql`UPDATE inbox_connections SET next_sync_at = now() WHERE user_id = ${user.id}`;
    const syncedBefore = grep(s3, "inbox: scheduler: synced").length;
    await waitFor("the extra sync", 2 * TICK_MS + 10_000, () => grep(s3, "inbox: scheduler: synced").length > syncedBefore);
    const again = await snapshot(sql, user.id);
    const stop3 = await stopServer(s3, "SIGTERM");
    check("stop within 10 s (SIGTERM, idle)", stop3.ms < STOP_LIMIT_MS && stop3.code === 143, `exit after ${stop3.ms} ms with code ${stop3.code}`);

    // The reference: the same user and mail, synced in one go in this process.
    process.env.MAIL_SOURCE = "fixture";
    setDbForTests(ref);
    const refUser = await demoUser(ref, now);
    const { runInboxCheck } = await import("@/lib/server/inbox/sync/engine");
    await runInboxCheck(refUser.id);
    const reference = await snapshot(ref, refUser.id);

    const ledger = await sql<{ result: string }[]>`SELECT result FROM inbox_seen_messages WHERE user_id = ${user.id}`;
    const dupes = await duplicates(sql, user.id);
    check(
      "restart mid-sync without duplicates",
      ledger.length === FIXTURE_MESSAGES && ledger.every((r) => r.result !== "retry") && dupes.length === 0 && resumed === reference,
      `${ledger.length} ledger rows, ${dupes.length ? dupes.join(", ") : "nothing twice"}, ` +
        `${resumed === reference ? "same result as one uninterrupted sync" : "DIFFERENT from one uninterrupted sync"}`,
    );
    check("a further sync changes nothing", again === resumed, again === resumed ? "unchanged" : "changed");
    check(
      "the dead process's lease made the new one wait, not double",
      grep(s3, "busy 1 (lease held elsewhere)").length > 0 || after2.lease_owner === null,
      `${grep(s3, "busy 1").length} busy ticks on server 3; lease left by server 2: ${after2.lease_owner ? "yes" : "no"}`,
    );

    // One scheduler per process.
    for (const s of servers) {
      const startedLines = grep(s, "inbox: scheduler started").length;
      const ticks = grep(s, "inbox: scheduler: ");
      const alive = (s.lines.at(-1)?.at ?? Date.now()) - (s.lines[0]?.at ?? Date.now());
      // At most one tick line per minute of life (the first tick comes 60 s after the start).
      const ok = startedLines === 1 && ticks.length <= Math.floor(alive / TICK_MS) + 1;
      check(`one scheduler in server ${s.n}`, ok, `${startedLines} start line(s), ${ticks.length} tick line(s) in ${Math.round(alive / 1000)} s`);
    }
  } finally {
    if (lock) await lock.release().catch(() => {});
    for (const s of servers) if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill("SIGKILL");
    setDbForTests(undefined);
    await sql.end({ timeout: 5 });
    await ref.end({ timeout: 5 });
    if (!opts.keep) for (const s of [schema, refSchema]) await admin.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
    else say(`kept schemas ${schema} and ${refSchema}`);
    await admin.end({ timeout: 5 });
  }

  const failed = results.filter((r) => !r.ok);
  say(failed.length ? `${failed.length} of ${results.length} checks FAILED` : `all ${results.length} checks passed`);
  say(`server logs: ${opts.out}`);
  return failed.length ? 1 : 0;
}

// Run when started as a script; the helpers above can be imported without running it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      // The message only, with the connection string masked in case a driver message echoes it.
      let message = err instanceof Error ? err.message : String(err);
      if (knownUrl) message = message.split(knownUrl).join("<TEST_DATABASE_URL>");
      console.error(err instanceof Usage ? `scheduler-check: ${message}` : `scheduler-check: failed: ${message}`);
      process.exit(err instanceof Usage ? 2 : 1);
    },
  );
}
