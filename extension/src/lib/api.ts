import type {
  ExtensionJobInput,
  ExtensionSession,
  PageSnapshot,
  ParseResult,
  UpsertResult,
} from "@/lib/types";
import { hostOf, originPattern } from "./origin";

/*
 * The tracker's extension routes (docs/plan/4-chrome-extension.md, API), called from the popup
 * and the service worker with the browser's own key. The key goes only into the Authorization
 * header of requests to the origin it was made for, and is never logged.
 *
 * Every failure becomes an ApiError of one of four kinds, which is all the screens need to know:
 * - "disconnected": the key routes' 401, which carries `WWW-Authenticate: Bearer`: the key was
 *   revoked (or its user left the allowlist). Forget it, connect again.
 * - "no-access": no answer, because the tracker's site access was withdrawn (chrome://extensions,
 *   Site access): the requests became CORS requests, which the tracker doesn't allow. The key is
 *   still good: keep it and offer Allow access (requestAccess).
 * - "retryable": the tracker could not be reached, took too long, or failed (5xx, 429), or a 401
 *   came without the Bearer challenge (not the key routes answering: an older release's proxy,
 *   say, which refuses every request without a session cookie). Keep what the user typed and
 *   offer Try again.
 * - "rejected": the tracker answered and said no (400, 403, 404, 409); its message is shown.
 */

export type ApiErrorKind = "disconnected" | "no-access" | "retryable" | "rejected";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    /** The HTTP status; null when no answer came. */
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

export const DISCONNECTED_MESSAGE = "This browser was disconnected. Connect again.";

/** The key routes' 401 names the Bearer scheme (keyNotSignedIn in src/lib/server/auth/guard.ts). */
function isBearerChallenge(res: Response) {
  const challenges = res.headers.get("WWW-Authenticate") ?? "";
  // A scheme starts the header or follows a comma; it is case-insensitive.
  return /(?:^|,)\s*bearer(?:\s|,|$)/i.test(challenges);
}

/**
 * Whether the extension may still send requests to the tracker. True when it can't tell (no
 * chrome.permissions where this runs), so a failure then reads as a network one.
 */
async function hasSiteAccess(origin: string) {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(origin)] });
  } catch {
    return true;
  }
}

interface ApiOptions {
  /** Stands in for the global fetch (tests). */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

export function createApi(
  { origin, token }: { origin: string; token: string },
  options: ApiOptions = {},
) {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const host = hostOf(origin);

  async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
    // The tracker refuses a changing request without a JSON content type, body or not.
    if (method !== "GET") headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await send(`${origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // The key is the only credential: no cookies, and no redirect that could carry the key along.
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new ApiError("retryable", `${host} took too long to answer. Try again.`, null);
      }
      // Without the site access, Chrome sends the request as a CORS request, which fails like
      // a network error: only the permission tells the two apart.
      if (!(await hasSiteAccess(origin))) {
        throw new ApiError("no-access", `Job Tracker no longer has access to ${host}. Allow access to reach it again.`, null);
      }
      throw new ApiError("retryable", `Couldn't reach ${host}. Check your connection, then try again.`, null);
    }

    const data: unknown = await res.json().catch(() => null);
    if (res.status === 401) {
      if (isBearerChallenge(res)) throw new ApiError("disconnected", DISCONNECTED_MESSAGE, 401);
      // Not the key routes refusing the key, so it may well be valid: don't forget it over this.
      throw new ApiError("retryable", `${host} didn't accept the request right now. Try again in a moment.`, 401);
    }
    if (res.status >= 500 || res.status === 429 || res.status === 408) {
      throw new ApiError("retryable", `${host} couldn't answer right now (${res.status}). Try again in a moment.`, res.status);
    }
    const message = errorMessage(data);
    if (!res.ok || data === null) {
      // A redirect (status 0 with redirect: "manual") or an HTML page: not the tracker's API answering.
      const status = res.type === "opaqueredirect" ? null : res.status;
      throw new ApiError(
        "rejected",
        message ?? `${host} didn't answer like a Job Tracker${status ? ` (${status})` : ""}. Check the address.`,
        status,
      );
    }
    return data as T;
  }

  return {
    /** Who the key adds jobs for, and the extension version the tracker serves. */
    session: () => request<ExtensionSession>("GET", "/api/extension/session"),
    /** Revokes the key this client uses (Disconnect). */
    revoke: () => request<{ ok: true }>("DELETE", "/api/extension/session"),
    /** The tracker's reading of the page: fields, what it could not find, and a duplicate. */
    read: (page: PageSnapshot) => request<ParseResult>("POST", "/api/extension/read", { page }),
    saveJob: (input: ExtensionJobInput) => request<UpsertResult>("POST", "/api/extension/jobs", input),
    /**
     * Asks Chrome for the tracker's site access again (after a "no-access" failure); true when
     * granted. Call it straight from a click: Chrome shows the prompt only for a user gesture.
     */
    requestAccess: () =>
      chrome.permissions.request({ origins: [originPattern(origin)] }).catch(() => false),
  };
}

export type Api = ReturnType<typeof createApi>;

/** The `{ error }` every tracker route answers with when it refuses a request. */
function errorMessage(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("error" in data)) return null;
  return typeof data.error === "string" && data.error.trim() ? data.error : null;
}

export function isDisconnected(error: unknown): error is ApiError {
  return error instanceof ApiError && error.kind === "disconnected";
}

export function isNoAccess(error: unknown): error is ApiError {
  return error instanceof ApiError && error.kind === "no-access";
}

/** A sentence for any failure: an ApiError's own, or a generic one for a bug. */
export function failureMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "Something went wrong in the extension. Try again.";
}
