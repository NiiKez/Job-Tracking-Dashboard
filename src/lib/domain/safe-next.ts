/**
 * Where to go after sign-in: `next` from the URL, kept only when it is a path
 * on this site. Shared by the login page and the /auth routes, so both apply
 * the same rule. Pure: uses only the WHATWG URL parser, which browsers and
 * Node both have.
 *
 * Kept: a site path (isSitePath: starts with exactly one "/", no "\" anywhere,
 * no control characters), at most MAX_NEXT_LENGTH characters (it travels in a
 * cookie during sign-in), and not /login or /auth (or anything below them),
 * which would loop. That last rule is checked on the string as given and again
 * after dot segments are resolved ("/x/../auth/google", "/./login",
 * "/%2e%2e/login"), and the resolved path must still start with exactly one "/".
 * Anything else (another origin, "//host", "/\host", "javascript:…") → null.
 */
export const MAX_NEXT_LENGTH = 512;

const LOOPS = /^\/(login|auth)(?=$|[/?#])/;

export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_NEXT_LENGTH) return null;
  if (!isSitePath(raw) || LOOPS.test(raw)) return null;
  let resolved: string;
  try {
    resolved = new URL(raw, "http://n").pathname;
  } catch {
    return null;
  }
  if (resolved.startsWith("//") || LOOPS.test(resolved)) return null;
  return raw;
}

/**
 * True for a path on this site as written: starts with exactly one "/", has no "\" and no
 * control characters (C0 including tab and newline, DEL, C1). URL parsers read "\" as "/" and
 * drop tab and newline, so "/\host" and "/\t/host" would resolve as "//host", another origin.
 * Shared with redirectTo() and googleClient(), which also resolve paths against APP_URL.
 */
export function isSitePath(path: string): boolean {
  if (path[0] !== "/" || path[1] === "/") return false;
  if (path.includes("\\")) return false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}
