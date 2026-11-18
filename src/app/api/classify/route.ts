import { readJson, route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { classifyInputSchema } from "@/lib/server/schemas";
import { classify } from "@/lib/server/services/classify";

export const POST = route(async ({ req, user }) =>
  classify(getDb(), user.id, await readJson(req, classifyInputSchema)),
);
