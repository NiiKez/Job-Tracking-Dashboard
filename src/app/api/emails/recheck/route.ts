import { route } from "@/lib/server/auth/guard";
import { recheckReview } from "@/lib/server/services/recheck";

/** The review list's "Check again": classifies the mail that waits for review once more. */
export const POST = route(({ user }) => recheckReview(user.id));
