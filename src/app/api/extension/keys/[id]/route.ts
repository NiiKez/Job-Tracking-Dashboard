// Revoke in Settings (or the connect page undoing a key it made). Cookie route; 404 when the key
// is not this user's.
import { route } from "@/lib/server/auth/guard";
import { revokeExtensionKey } from "@/lib/server/services/extension";

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await revokeExtensionKey(user.id, params.id);
  return { ok: true };
});
