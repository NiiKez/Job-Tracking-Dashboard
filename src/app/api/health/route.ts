import { connection } from "next/server";
import { getDb } from "@/lib/server/db/client";

// Well below the deploy's health-check timeout, so a hanging database answers 503 instead of
// leaving the check to time out.
const DB_TIMEOUT_MS = 3_000;

/**
 * Health check for the deploy: 200 when the database answers, 503 otherwise. No login, no
 * redirect, and no error details in the response.
 */
export async function GET() {
  // Answer every request live, never from a build-time prerender.
  await connection();
  const ok = await databaseAnswers();
  return Response.json({ ok }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}

async function databaseAnswers(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${DB_TIMEOUT_MS} ms`)), DB_TIMEOUT_MS);
    });
    await Promise.race([getDb()`SELECT 1`, timeout]);
    return true;
  } catch (err) {
    // A code ("ECONNREFUSED", "28P01") or our own message; never the connection string.
    const reason = (err as { code?: unknown })?.code ?? (err instanceof Error ? err.message : "unknown error");
    console.error(`health: database check failed: ${String(reason).slice(0, 200)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
