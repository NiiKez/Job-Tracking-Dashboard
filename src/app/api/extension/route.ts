// Settings, Chrome extension: the version this server hands out and the connected browsers.
// Cookie route. docs/plan/4-chrome-extension.md, "API". The public demo has no extension: 403.
import { EXTENSION_OFF_IN_DEMO, refuseInDemo } from "@/lib/server/auth/access";
import { route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { getExtensionOverview } from "@/lib/server/services/extension";

export const GET = route(({ user }) => refuseInDemo(EXTENSION_OFF_IN_DEMO) ?? getExtensionOverview(getDb(), user.id));
