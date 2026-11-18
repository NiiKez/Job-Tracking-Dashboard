// The /extension/connect page makes a key for the browser it was opened from. Cookie route:
// 201 with the token, which the page hands to the extension; 409 at 20 keys; 403 in the public
// demo, which has no extension (the key routes would refuse the key there anyway).
import { EXTENSION_OFF_IN_DEMO, refuseInDemo } from "@/lib/server/auth/access";
import { readJson, route } from "@/lib/server/auth/guard";
import { extensionKeyInputSchema } from "@/lib/server/schemas";
import { createExtensionKey } from "@/lib/server/services/extension";

export const POST = route(
  async ({ req, user }) =>
    refuseInDemo(EXTENSION_OFF_IN_DEMO) ??
    createExtensionKey(user.id, (await readJson(req, extensionKeyInputSchema)).label),
  { status: 201 },
);
