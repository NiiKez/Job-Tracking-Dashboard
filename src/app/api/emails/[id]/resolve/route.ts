import { readJson, route } from "@/lib/server/auth/guard";
import { reviewActionSchema } from "@/lib/server/schemas";
import { resolveReview } from "@/lib/server/services/review";

export const POST = route<{ id: string }>(async ({ req, user, params }) =>
  resolveReview(user.id, params.id, await readJson(req, reviewActionSchema)),
);
