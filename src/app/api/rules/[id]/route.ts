import { route } from "@/lib/server/auth/guard";
import { deleteRule } from "@/lib/server/services/rules";

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await deleteRule(user.id, params.id);
  return { ok: true };
});
