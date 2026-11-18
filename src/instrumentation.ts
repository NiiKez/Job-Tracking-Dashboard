/**
 * Runs once when the server starts, before it answers requests.
 *
 * It checks the environment (checkEnv() in src/lib/server/env.ts). A malformed value (or a missing
 * DATABASE_URL) stops the process, so the deploy's health check fails and the release rolls back.
 * In production so does MAIL_SOURCE=fixture (unless APP_URL is an http loopback origin), and so
 * does a missing sign-in value or INBOX_TOKEN_KEY unless ALLOW_PARTIAL_SETUP=on. Outside
 * production, or with that opt-out, a missing value only switches its feature off, and
 * checkEnv() logs which.
 *
 * Then it starts the inbox scheduler (src/lib/server/inbox/sync/scheduler.ts): a 60-second timer,
 * started without waiting for any work, since the server takes no requests before register()
 * returns, and only once per process. Its no-response sweep and 90-day ledger clean-up run in
 * every configuration; its timed Gmail syncs only with INBOX_SCHEDULER on and Gmail set up (or
 * MAIL_SOURCE=fixture). It also stops the inbox syncs on SIGTERM and SIGINT, beside Next.js's own
 * shutdown.
 */
export async function register() {
  // Inside this branch only: the Edge build drops it, so it never bundles server code.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // `next build` must work without any environment. Next.js 16.4 skips register() during the
    // build, but its documentation does not promise that.
    if (process.env.NEXT_PHASE === "phase-production-build") return;

    const { checkEnv } = await import("@/lib/server/env");
    try {
      checkEnv();
    } catch (err) {
      // A throw alone is not enough: `next start` logs a failed register() and keeps listening,
      // answering every request with an error. The message names variables, never values.
      console.error(err instanceof Error ? err.message : "Invalid environment");
      process.exit(1);
    }

    try {
      const { startInboxScheduler } = await import("@/lib/server/inbox/sync/scheduler");
      startInboxScheduler();
    } catch (err) {
      // The app works without it: the inbox is then checked only on request, and the sweep and
      // the ledger clean-up wait for the next start.
      console.error(`inbox: scheduler not started (${err instanceof Error ? err.name : "unknown"})`);
    }
  }
}
