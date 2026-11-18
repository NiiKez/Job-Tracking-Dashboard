import { z } from "zod";
import { readJson, route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { getEnv } from "@/lib/server/env";
import { parseInput } from "@/lib/server/services/parse";

const schema = z.object({ input: z.string().trim().min(1, "Paste a link or the job text").max(50_000) });

/**
 * The add-job dialog's "read this": the job fields in a pasted link or text. The public demo
 * never opens a link (its visitors are anonymous; this is the only place the server fetches an
 * address a visitor gives): title and company come from the link's own text.
 */
export const POST = route(async ({ req, user }) =>
  parseInput(getDb(), user.id, (await readJson(req, schema)).input, { fetchLink: !getEnv().demoMode }),
);
