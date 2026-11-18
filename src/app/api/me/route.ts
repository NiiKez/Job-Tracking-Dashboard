import { route } from "@/lib/server/auth/guard";
import type { Me } from "@/lib/types";

/** Who is signed in, for the account menu. */
export const GET = route(({ user }): Me => ({ email: user.email, name: user.name, pictureUrl: user.pictureUrl }));
