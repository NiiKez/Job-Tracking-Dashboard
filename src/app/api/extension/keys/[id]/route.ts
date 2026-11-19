// Revoke in Settings (or the connect page undoing a key it made). Cookie route; 404 when the key
// is not this user's; 403 in the public demo, which has no extension.
import { EXTENSION_OFF_IN_DEMO, refuseInDemo } from "@/lib/server/auth/access";
import { route } from "@/lib/server/auth/guard";
import { revokeExtensionKey } from "@/lib/server/services/extension";

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const refused = refuseInDemo(EXTENSION_OFF_IN_DEMO);
  if (refused) return refused;
  await revokeExtensionKey(user.id, params.id);
  return { ok: true };
});
