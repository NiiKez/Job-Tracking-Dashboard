import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "@/lib/server/db/client";
import { isErrorNamed } from "@/lib/server/errors";
import { isMailSourceError, isRetryable } from "@/lib/server/inbox/sync/errors";

// Next.js bundles src/instrumentation.ts (the inbox scheduler and its copy of the engine) apart
// from the routes. A route that joins a sync the scheduler started gets errors made by the other
// bundle's classes, so these checks must not rely on instanceof. Simulated here with plain Errors
// that carry the same name and fields. route() maps by isErrorNamed (src/lib/server/auth/guard.ts),
// and the real-server check (scripts/scheduler-check.mts) covers a joined run end to end.
const foreign = (name: string, fields: Record<string, unknown> = {}) =>
  Object.assign(new Error("from another bundle"), { name, ...fields });

describe("errors from another copy of a module", () => {
  it("isMailSourceError and isRetryable recognise them by name and fields", () => {
    const err = foreign("MailSourceError", { kind: "temporary", code: "network", retryAfterMs: null });
    expect(isMailSourceError(err)).toBe(true);
    expect(isMailSourceError(err, "temporary")).toBe(true);
    expect(isMailSourceError(err, "setup")).toBe(false);
    expect(isRetryable(err)).toBe(true);
    expect(isMailSourceError(foreign("MailSourceError"))).toBe(false); // no kind or code
    expect(isMailSourceError(foreign("TypeError", { kind: "temporary", code: "network" }))).toBe(false);
  });

  it("isUniqueViolation recognises a PostgresError from another copy of postgres", () => {
    // PostgresError's name is its minified class name in a build, so only the fields count.
    const dup = foreign("eS", { code: "23505", constraint_name: "jobs_user_id_url_norm_key" });
    expect(isUniqueViolation(dup, "jobs_user_id_url_norm_key")).toBe(true);
    expect(isUniqueViolation(dup, "users_email_key")).toBe(false);
    const fk = foreign("eS", { code: "23503", constraint_name: "jobs_user_id_url_norm_key" });
    expect(isUniqueViolation(fk, "jobs_user_id_url_norm_key")).toBe(false);
    expect(isUniqueViolation({ code: "23505", constraint_name: "users_email_key" }, "users_email_key")).toBe(false);
  });

  it("isErrorNamed matches the name only", () => {
    expect(isErrorNamed(foreign("ConflictError"), "ConflictError")).toBe(true);
    expect(isErrorNamed(foreign("ConflictError"), "NotFoundError")).toBe(false);
    expect(isErrorNamed("ConflictError", "ConflictError")).toBe(false);
  });
});
