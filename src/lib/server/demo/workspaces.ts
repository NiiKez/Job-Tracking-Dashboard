import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { createSession } from "@/lib/server/auth/session";
import type { Db, Sql, Tx } from "@/lib/server/db/client";
import { isUuid } from "@/lib/server/db/rows";
import { ensureDemoConnection } from "@/lib/server/inbox/repo";
import { insertDefaults } from "@/lib/server/repo/users";
import { DEMO_SUB_PREFIX, WORKSPACE_LIFETIME_SECONDS } from "./marker";
import { seedUser } from "./seed";

/**
 * The public demo's workspaces (docs/plan/5-public-demo.md, "How it works" and "Limits"). A
 * workspace is a demo user (marker.ts: google_sub "demo:" + a UUID) with everything a user has:
 * the settings row, the default keyword rules, the invented jobs and emails (seed.ts), a demo
 * inbox connection and one session. It lives WORKSPACE_LIFETIME_SECONDS (24 hours) from the
 * user's created_at, and goes as a whole with its users row: every table's user_id has
 * ON DELETE CASCADE.
 *
 *   createWorkspace(db, { replaceUserId?, now? })
 *                                      a new workspace and its session, in one transaction:
 *                                      { ok: true, userId, setCookie, expiresAt }, or
 *                                      { ok: false, reason: "busy" } when the demo is full
 *   deleteWorkspace(db, userId)        "Leave the demo": true when a demo user was deleted
 *   workspaceExpiresAt(db, userId)     created_at + 24 hours for a demo user, else null (/api/me)
 *   countWorkspaces(db, now?)          the demo users not yet past their lifetime
 *   purgeExpiredWorkspaces(db, now?)   deletes the demo users past their lifetime; how many
 *   MAX_WORKSPACES                     300 live workspaces at most
 *   EVICT_AFTER_SECONDS                at the cap, workspaces older than this (1 hour) make room
 *
 * Never a user that is not a demo user. Every DELETE here is one statement whose WHERE carries
 * the marker itself (deleteDemoUsers), whatever else chose the rows, so a wrong id or a wrong
 * condition still cannot reach a real account. The marker is matched with starts_with(), not
 * LIKE, so no wildcard (`_`, `%`) can ever widen it.
 *
 * Clocks: `now` where given (tests, the scheduler), else the database's now(). In
 * createWorkspace's transaction that is the transaction's start, which is also the new user's
 * created_at and the base of its session's expires_at: the session ends exactly when the
 * workspace does.
 *
 * Nothing here reads DEMO_MODE: the callers (POST /auth/demo, sign-out, /api/me, the scheduler)
 * call it in demo mode only. Elsewhere there are no demo users to find, as sign-in refuses a
 * Google `sub` with the marker.
 *
 * Logs: one line per creation with how long it took, and one when workspaces are deleted to
 * make room, purged, or the demo is full. Counts and durations only, never an id or an address.
 */

/** Live workspaces at most (each about 0.1 MB, at most about 1.5 MB at the per-workspace caps). */
export const MAX_WORKSPACES = 300;
/** At the cap, workspaces at least this old are deleted (oldest first) to make room. */
export const EVICT_AFTER_SECONDS = 60 * 60;

/** What every demo user is called (docs/plan/5-public-demo.md, "Defaults I chose"). */
const DEMO_NAME = "Alex Demo";
/** RFC 2606: a domain that can never receive mail. */
const DEMO_EMAIL_DOMAIN = "demo.invalid";
/** The advisory lock that makes creations take turns, so the count under it stays true. */
const CREATE_LOCK = "demo:workspaces";

export interface CreateWorkspaceOptions {
  /**
   * "Start over" from inside a workspace: the visitor's current user, deleted in the same
   * transaction when it is a demo user (anything else is left alone, and creation goes on).
   */
  replaceUserId?: string | null;
  /**
   * The clock for the seed's dates and for what counts as expired or as older than an hour.
   * Default: the database's now(), the new user's created_at.
   */
  now?: Date;
}

export type CreateWorkspaceResult =
  | { ok: true; userId: string; setCookie: string; expiresAt: Date }
  | { ok: false; reason: "busy" };

/** Thrown inside the transaction to roll it back when there is no room. */
class DemoFull extends Error {
  override name = "DemoFull";
  constructor(readonly live: number) {
    super("The demo is full");
  }
}

/**
 * Creates a workspace: purges the expired ones first (a statement of its own, kept whatever
 * follows), then in ONE transaction:
 *
 *   0. sets lock_timeout to 5 seconds (SET LOCAL), so no step waits longer than that for any
 *      one lock (see below);
 *   1. takes the creation lock (an advisory lock until the transaction ends), so creations in
 *      any process take turns and the count below cannot change under it;
 *   2. deletes `replaceUserId`'s workspace, if that is a demo user ("Start over");
 *   3. counts the live workspaces. At MAX_WORKSPACES, deletes enough of those created at least
 *      EVICT_AFTER_SECONDS ago, oldest first, to make room for one; if that is not enough,
 *      rolls everything back (the replaced workspace stays too) and answers "busy";
 *   4. inserts the user (google_sub "demo:" + a UUID, alex.<random hex>@demo.invalid, "Alex
 *      Demo", no picture), its settings and default rules (insertDefaults), the seed
 *      (seedUser, dated from `now`), the demo inbox connection (ensureDemoConnection) and a
 *      session of WORKSPACE_LIFETIME_SECONDS (createSession), which never gets extended.
 *
 * Either all of it is there or none of it. `db` is the pool (a transaction of its own), or a
 * transaction (a savepoint in it; the creation lock then lasts until the caller's transaction
 * ends, and so does the lock_timeout, for the caller's later statements too, unless the
 * savepoint is rolled back).
 *
 * A request of a replaced or evicted workspace that is writing at that moment makes the DELETE
 * wait for it. In a rare order of locks PostgreSQL finds a deadlock instead and fails one of the
 * two; a retry works. The DELETE waits while holding the creation lock and, in POST /auth/demo,
 * the entry gate, so a transaction stuck on that workspace's rows would hold up every entry:
 * after 5 seconds the creation fails instead (55P03, thrown like any database error; the route
 * answers /login/demo?error=failed) and everything rolls back. A creation waiting for another
 * process's creation lock gives up after 5 seconds as well.
 */
export async function createWorkspace(db: Db, opts: CreateWorkspaceOptions = {}): Promise<CreateWorkspaceResult> {
  const started = performance.now();
  await purgeExpiredWorkspaces(db, opts.now);
  try {
    const created = await inTransaction(db, async (tx) => {
      await tx`SET LOCAL lock_timeout = '5s'`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${CREATE_LOCK}, 0))`;
      if (opts.replaceUserId) await deleteWorkspace(tx, opts.replaceUserId);
      let live = await countWorkspaces(tx, opts.now);
      let evicted = 0;
      if (live >= MAX_WORKSPACES) {
        evicted = await evictOldest(tx, live - MAX_WORKSPACES + 1, opts.now);
        live -= evicted;
        if (live >= MAX_WORKSPACES) throw new DemoFull(live);
      }
      return { ...(await insertWorkspace(tx, opts.now)), evicted, live: live + 1 };
    });
    const { evicted, live, ...workspace } = created;
    if (evicted > 0) {
      console.info(`demo: deleted ${plural(evicted, "workspace")} older than an hour to make room`);
    }
    console.info(`demo: workspace created in ${Math.round(performance.now() - started)} ms (${live} live)`);
    return { ok: true, ...workspace };
  } catch (err) {
    if (!(err instanceof DemoFull)) throw err;
    console.info(`demo: full, no workspace created (${err.live} live, none older than an hour)`);
    return { ok: false, reason: "busy" };
  }
}

/** Step 4 of createWorkspace, in its transaction. */
async function insertWorkspace(
  tx: Tx,
  now: Date | undefined,
): Promise<{ userId: string; setCookie: string; expiresAt: Date }> {
  const googleSub = DEMO_SUB_PREFIX + randomUUID();
  // 64 random bits: unique among a few hundred users (users_email_key would refuse a repeat).
  const email = `alex.${randomBytes(8).toString("hex")}@${DEMO_EMAIL_DOMAIN}`;
  const [user] = await tx<{ id: string; created_at: Date }[]>`
    INSERT INTO users (google_sub, email, name, picture_url)
    VALUES (${googleSub}, ${email}, ${DEMO_NAME}, NULL)
    RETURNING id, created_at`;
  await insertDefaults(tx, user.id);
  await seedUser(tx, user.id, (now ?? user.created_at).getTime());
  await ensureDemoConnection(tx, user.id);
  const session = await createSession(tx, user.id, { fixedLifetimeSeconds: WORKSPACE_LIFETIME_SECONDS });
  return { userId: user.id, setCookie: session.setCookie, expiresAt: session.expiresAt };
}

/**
 * Deletes the workspace of a demo user ("Leave the demo", and "Start over" inside
 * createWorkspace): the users row, and every row of theirs with it. True when it was deleted;
 * false for a user that is not a demo user (never deleted), an unknown or malformed id.
 */
export async function deleteWorkspace(db: Db, userId: string): Promise<boolean> {
  if (!isUuid(userId)) return false;
  return (await deleteDemoUsers(db, db`id = ${userId}`)) > 0;
}

/**
 * When the demo user's workspace ends: created_at + WORKSPACE_LIFETIME_SECONDS, which is also
 * when its session expires. Null for a user that is not a demo user, or none with this id.
 */
export async function workspaceExpiresAt(db: Db, userId: string): Promise<Date | null> {
  if (!isUuid(userId)) return null;
  const [row] = await db<{ expires_at: Date }[]>`
    SELECT created_at + make_interval(secs => ${WORKSPACE_LIFETIME_SECONDS}) AS expires_at
    FROM users
    WHERE id = ${userId} AND starts_with(google_sub, ${DEMO_SUB_PREFIX})`;
  return row?.expires_at ?? null;
}

/** The live workspaces: demo users not yet WORKSPACE_LIFETIME_SECONDS old at `now`. */
export async function countWorkspaces(db: Db, now?: Date): Promise<number> {
  const [row] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM users
    WHERE starts_with(google_sub, ${DEMO_SUB_PREFIX})
      AND created_at > ${clock(db, now)} - make_interval(secs => ${WORKSPACE_LIFETIME_SECONDS})`;
  return row.n;
}

/**
 * Deletes every demo user at least WORKSPACE_LIFETIME_SECONDS old at `now` (their sessions have
 * expired with them). Returns how many; logs a line when there were any. The scheduler runs it
 * in demo mode, and createWorkspace before every creation in case the scheduler is not running.
 */
export async function purgeExpiredWorkspaces(db: Db, now?: Date): Promise<number> {
  const purged = await deleteDemoUsers(
    db,
    db`created_at <= ${clock(db, now)} - make_interval(secs => ${WORKSPACE_LIFETIME_SECONDS})`,
  );
  if (purged > 0) console.info(`demo: purged ${plural(purged, "expired workspace")}`);
  return purged;
}

/** Deletes up to `count` demo users at least EVICT_AFTER_SECONDS old, oldest first; how many. */
async function evictOldest(tx: Tx, count: number, now: Date | undefined): Promise<number> {
  return deleteDemoUsers(
    tx,
    tx`id IN (
      SELECT id FROM users
      WHERE starts_with(google_sub, ${DEMO_SUB_PREFIX})
        AND created_at <= ${clock(tx, now)} - make_interval(secs => ${EVICT_AFTER_SECONDS})
      ORDER BY created_at, id
      LIMIT ${count}
    )`,
  );
}

/**
 * The only way this module deletes users: the rows `where` chooses, and of those only demo users,
 * in one statement. Returns how many were deleted.
 */
async function deleteDemoUsers(db: Db, where: postgres.Fragment): Promise<number> {
  const rows = await db`
    DELETE FROM users
    WHERE starts_with(google_sub, ${DEMO_SUB_PREFIX}) AND (${where})
    RETURNING id`;
  return rows.length;
}

/** `now`, or the database's now() (in a transaction: its start). */
function clock(db: Db, now: Date | undefined): postgres.Fragment {
  return db`coalesce(${now ?? null}::timestamptz, now())`;
}

/**
 * Runs fn in a transaction of its own on the pool, or in a savepoint of the caller's transaction
 * (a transaction has savepoint() but no begin()).
 */
function inTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const pool = db as Partial<Sql>;
  if (typeof pool.begin === "function") return pool.begin(fn) as Promise<T>;
  const tx = db as Partial<Tx>;
  if (typeof tx.savepoint === "function") return tx.savepoint(fn) as Promise<T>;
  throw new TypeError("createWorkspace needs the pool or a transaction");
}

/** "1 workspace", "3 workspaces". */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
