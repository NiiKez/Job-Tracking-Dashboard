/*
 * The tracker's address, as the user types it on the Connect screen. The extension talks to one
 * origin only, so whatever is typed becomes a bare origin ("https://tracker.example.com") or is
 * refused with a sentence the screen can show. https is required, except for a tracker running on
 * this computer (localhost, 127.0.0.1), the only http hosts the manifest's
 * optional_host_permissions name.
 *
 * The origin becomes a permission pattern (originPattern), where * means any host. The URL parser
 * takes "*", "*.example.com" and "%2A.example.com" as host names, and the manifest's optional
 * permission for every https site would let Chrome grant them: "*" would ask for all of them. So
 * a host is taken only as a plain DNS name or an IP address.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * A host as the URL parser leaves it: a DNS name in lower case and punycode (which also covers an
 * IPv4 address, written out in full), or an IPv6 address in brackets.
 */
const PLAIN_HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/;

export type OriginCheck = { ok: true; origin: string } | { ok: false; error: string };

export function normalizeOrigin(raw: string): OriginCheck {
  const typed = raw.trim();
  if (!typed) return { ok: false, error: "Enter your tracker's address." };
  if (/\s/.test(typed)) return { ok: false, error: "An address has no spaces." };

  // A bare host gets a scheme: http for this computer (a dev server), https everywhere else.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed);
  const bareHost = typed.split(/[/:?#]/, 1)[0].toLowerCase().replace(/\.$/, "");
  const withScheme = hasScheme ? typed : `${LOCAL_HOSTS.has(bareHost) ? "http" : "https"}://${typed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: "That isn't a web address. Use one like https://tracker.example.com." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Use an https address, like https://tracker.example.com." };
  }
  // "tracker.example.com." names the same host, but the tracker's own pages never use that
  // spelling, so a connection to it could never finish: drop the dot.
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
  if (!PLAIN_HOST.test(url.hostname)) {
    return { ok: false, error: "That isn't a web address. Use one like https://tracker.example.com." };
  }
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) {
    return { ok: false, error: "Use https. Plain http works only for localhost and 127.0.0.1." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Leave out the user name and password; you sign in on the tracker's page." };
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return { ok: false, error: `Use the address without a path: ${url.origin}` };
  }
  return { ok: true, origin: url.origin };
}

/** The host permission Connect asks for: this one origin, every path. */
export function originPattern(origin: string) {
  return `${origin}/*`;
}

/** "tracker.example.com" or "localhost:3800": the origin as the footer shows it. */
export function hostOf(origin: string) {
  return new URL(origin).host;
}
