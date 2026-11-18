// The extension's own connection. Key routes (route(…, { auth: "extension" })):
// GET says whose tracker the key adds jobs to and the latest version; DELETE is Disconnect in
// the popup and deletes the key the request was made with.
import { route } from "@/lib/server/auth/guard";
import { disconnectExtension, getExtensionSession } from "@/lib/server/services/extension";

export const GET = route(({ user }) => getExtensionSession(user), { auth: "extension" });

export const DELETE = route(
  async ({ user, extensionKeyId }) => {
    // Always set on a key route.
    if (extensionKeyId) await disconnectExtension(user.id, extensionKeyId);
    return { ok: true };
  },
  { auth: "extension" },
);
