import { z } from "zod";
import { readJson, route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { parseInput } from "@/lib/server/services/parse";

const schema = z.object({ input: z.string().trim().min(1, "Paste a link or the job text").max(50_000) });

export const POST = route(async ({ req, user }) =>
  parseInput(getDb(), user.id, (await readJson(req, schema)).input),
);
