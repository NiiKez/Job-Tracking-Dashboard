import { readJson, route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { ruleInputSchema } from "@/lib/server/schemas";
import { addRule, listRules } from "@/lib/server/services/rules";

export const GET = route(({ user }) => listRules(getDb(), user.id));

export const POST = route(async ({ req, user }) => addRule(user.id, await readJson(req, ruleInputSchema)), {
  status: 201,
});
