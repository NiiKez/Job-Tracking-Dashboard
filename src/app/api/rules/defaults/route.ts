import { route } from "@/lib/server/auth/guard";
import { updateDefaultRules } from "@/lib/server/services/rules";

/** Settings → Keyword rules → Update defaults: see updateDefaultRules. */
export const POST = route(({ user }) => updateDefaultRules(user.id));
