// The popup's Save and Applied: the same upsert as POST /api/jobs, captured by "extension".
// Key route.
import { readJson, route } from "@/lib/server/auth/guard";
import { extensionJobInputSchema } from "@/lib/server/schemas";
import { saveExtensionJob } from "@/lib/server/services/extension";

export const POST = route(
  async ({ req, user }) => saveExtensionJob(user.id, await readJson(req, extensionJobInputSchema)),
  { auth: "extension" },
);
