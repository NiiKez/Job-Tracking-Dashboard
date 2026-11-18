import { route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { getStats } from "@/lib/server/services/stats";

export const GET = route(({ user }) => getStats(getDb(), user.id));
