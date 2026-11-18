// The popup's form: the job fields in what the extension read from the open tab, and the job
// they would duplicate. Key route; nothing is fetched (src/lib/server/parse/snapshot.ts).
import { readJson, route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { extensionReadSchema } from "@/lib/server/schemas";
import { readPageSnapshot } from "@/lib/server/services/extension";

export const POST = route(
  async ({ req, user }) => readPageSnapshot(getDb(), user.id, (await readJson(req, extensionReadSchema)).page),
  { auth: "extension" },
);
