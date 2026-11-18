import { readJson, route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { jobInputSchema, statusSchema } from "@/lib/server/schemas";
import { listJobs, upsertJob } from "@/lib/server/services/jobs";

export const GET = route(({ req, user }) => {
  const q = req.nextUrl.searchParams.get("q") ?? undefined;
  const raw = req.nextUrl.searchParams.get("status") ?? "";
  const statuses = raw.split(",").filter(Boolean).map((s) => statusSchema.parse(s));
  return listJobs(getDb(), user.id, { q, statuses });
});

export const POST = route(async ({ req, user }) => upsertJob(user.id, await readJson(req, jobInputSchema)));
