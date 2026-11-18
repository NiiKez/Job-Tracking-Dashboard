import { route } from "@/lib/server/auth/guard";
import { disconnectInbox } from "@/lib/server/inbox/oauth/connect";

/**
 * "Disconnect Gmail": stops a running sync, deletes the stored token, marks the connection
 * disconnected and asks Google to revoke the token (best effort, bounded). Idempotent. Linked
 * mail, the ledger, the sync position and the connection record stay.
 *
 * Answers { ok: true, revoked }. `revoked` is false when the app deleted a token but Google did
 * not confirm its revocation (no answer in time, an error, a token it could not decrypt): the
 * app reads no more mail, but the grant may still be listed in the user's Google Account, and
 * Settings says so. True when Google confirmed, or when no token was stored (demo mode, already
 * disconnected). Settings reads the new state.
 */
export const POST = route(async ({ user }) => {
  const { revoked } = await disconnectInbox(user.id);
  return { ok: true, revoked };
});
