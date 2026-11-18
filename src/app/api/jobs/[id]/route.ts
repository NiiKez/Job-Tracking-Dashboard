import { readJson, route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { jobPatchSchema } from "@/lib/server/schemas";
import { deleteJob, getJob, updateJob } from "@/lib/server/services/jobs";

export const GET = route<{ id: string }>(({ user, params }) => getJob(getDb(), user.id, params.id));

export const PATCH = route<{ id: string }>(async ({ req, user, params }) =>
  updateJob(user.id, params.id, await readJson(req, jobPatchSchema)),
);

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await deleteJob(user.id, params.id);
  return { ok: true };
});
