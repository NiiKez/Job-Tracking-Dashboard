import { route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { workspaceExpiresAt } from "@/lib/server/demo/workspaces";
import { getEnv } from "@/lib/server/env";
import { UnauthorizedError } from "@/lib/server/errors";
import type { Me } from "@/lib/types";

/**
 * Who is signed in, for the account menu. In the public demo also when the visitor's workspace is
 * deleted (`demo.expiresAt`); everywhere else that key is absent, so the real app's answer stays
 * { email, name, pictureUrl }.
 */
export const GET = route(async ({ user }): Promise<Me> => {
  const me: Me = { email: user.email, name: user.name, pictureUrl: user.pictureUrl };
  if (!getEnv().demoMode) return me;
  const expiresAt = await workspaceExpiresAt(getDb(), user.id);
  // Deleted since the session was checked (left in another tab, or purged): signed out.
  if (!expiresAt) throw new UnauthorizedError(true);
  return { ...me, demo: { expiresAt: expiresAt.toISOString() } };
});
