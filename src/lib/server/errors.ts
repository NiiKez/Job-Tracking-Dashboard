import "server-only";

/**
 * Errors the services throw and route() turns into HTTP answers.
 * Zod validation errors are mapped as well (400); anything else is a 500.
 */

/** 404: the row does not exist, or belongs to another user (never tell them apart). */
export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/** 409: the request is valid but clashes with the current state (a link another job has, an email no longer in review). */
export class ConflictError extends Error {
  override name = "ConflictError";
}

/** 400: a request that passed the schema but still makes no sense (e.g. nothing to confirm). */
export class BadRequestError extends Error {
  override name = "BadRequestError";
}

/**
 * 401: not signed in, or the session ended. route() answers { error: "Not signed in" } and,
 * when `clearSessionCookie` is set, clears the session cookie (unknown, expired or revoked session).
 */
export class UnauthorizedError extends Error {
  override name = "UnauthorizedError";

  constructor(readonly clearSessionCookie = false) {
    super("Not signed in");
  }
}

/** 413: a request body over the size readJson() accepts. */
export class PayloadTooLargeError extends Error {
  override name = "PayloadTooLargeError";
}

interface ErrorsByName {
  NotFoundError: NotFoundError;
  ConflictError: ConflictError;
  BadRequestError: BadRequestError;
  UnauthorizedError: UnauthorizedError;
  PayloadTooLargeError: PayloadTooLargeError;
}

/**
 * True for an error of the class with this name, also when it comes from another copy of this
 * module. Next.js bundles src/instrumentation.ts (the inbox scheduler) apart from the routes, so
 * a sync the scheduler started rejects with that bundle's classes when a route joins it, and
 * `instanceof` alone would turn a 409 into a 500. Compares the `name` each class sets as a
 * literal (a class's own name can be minified).
 */
export function isErrorNamed<N extends keyof ErrorsByName>(err: unknown, name: N): err is ErrorsByName[N] {
  return err instanceof Error && err.name === name;
}
