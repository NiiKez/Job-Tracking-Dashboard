// Settings, Chrome extension: the version this server hands out and the connected browsers.
// Cookie route. docs/plan/4-chrome-extension.md, "API".
import { route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { getExtensionOverview } from "@/lib/server/services/extension";

export const GET = route(({ user }) => getExtensionOverview(getDb(), user.id));
