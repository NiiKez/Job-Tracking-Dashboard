import { z } from "zod";
import { route } from "@/lib/server/auth/guard";
import { getDb } from "@/lib/server/db/client";
import { listEmails } from "@/lib/server/services/emails";

const outcome = z.enum(["matched", "created", "ignored", "review", "resolved", "dismissed"]);

export const GET = route(({ req, user }) => {
  const raw = req.nextUrl.searchParams.get("outcome") ?? "";
  const jobId = req.nextUrl.searchParams.get("jobId") ?? undefined;
  const outcomes = raw.split(",").filter(Boolean).map((o) => outcome.parse(o));
  return listEmails(getDb(), user.id, { outcomes, jobId });
});
