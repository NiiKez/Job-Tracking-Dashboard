import "server-only";
import net from "node:net";
import os from "node:os";

/**
 * Where the link fetcher may connect. Every address is checked here: IP literals in a link
 * before connecting, and every DNS answer inside the connection's lookup (see safe-fetch.ts).
 */

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // old 6to4 relays
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255
];

const BLOCKED_V6: Array<[string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::", 96], // old IPv4-compatible form
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments, includes Teredo (2001::/32)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["3fff::", 20], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // old site-local
  ["ff00::", 8], // multicast
];

function blockList(entries: Array<[string, number]>, family: "ipv4" | "ipv6") {
  const list = new net.BlockList();
  for (const [prefix, length] of entries) list.addSubnet(prefix, length, family);
  return list;
}

const blockedV4 = blockList(BLOCKED_V4, "ipv4");
const blockedV6 = blockList(BLOCKED_V6, "ipv6");

// Kept apart from blockedV6 on purpose: Node matches IPv6 rules inside ::ffff:0:0/96 against
// plain IPv4 addresses too, so in a shared list this rule would block every IPv4 address.
// The whole mapped range is refused: no public site needs a mapped address in DNS, and
// connecting to one reaches the embedded IPv4 address.
const mappedV6 = blockList([["::ffff:0:0", 96]], "ipv6");

// Only global unicast is public. This also catches anything the list above misses.
const globalV6 = blockList([["2000::", 3]], "ipv6");

/*
 * This host's own addresses. They are public, so the lists above miss them, but traffic to them
 * never leaves the machine (it is routed over lo): it passes both firewalls and reaches anything
 * listening on all interfaces, such as a web server on :80 and the sites behind it. Read from the
 * interfaces, cached briefly so an address change is picked up. If the interfaces cannot be read,
 * every address counts as this host's (the fetcher then refuses everything and the parser falls
 * back to the heuristics).
 */
const OWN_ADDRESSES_TTL_MS = 30_000;
let ownCache: { at: number; list: net.BlockList | null } | undefined;
let interfacesForTests: (() => ReturnType<typeof os.networkInterfaces>) | undefined;

/** Test seam: what the host's interfaces are. `undefined` goes back to the real ones. */
export function setNetworkInterfacesForTests(fn: (() => ReturnType<typeof os.networkInterfaces>) | undefined) {
  interfacesForTests = fn;
  ownCache = undefined;
}

function ownAddresses(): net.BlockList | null {
  const now = Date.now();
  if (ownCache && now - ownCache.at < OWN_ADDRESSES_TTL_MS) return ownCache.list;
  let list: net.BlockList | null = new net.BlockList();
  try {
    for (const entries of Object.values((interfacesForTests ?? os.networkInterfaces)())) {
      for (const entry of entries ?? []) {
        // A zone index is not part of the address (link-local addresses are blocked anyway).
        const address = entry.address.split("%")[0];
        const family = net.isIP(address);
        if (family) list.addAddress(address, family === 6 ? "ipv6" : "ipv4");
      }
    }
  } catch {
    list = null;
  }
  ownCache = { at: now, list };
  return list;
}

function isOwnAddress(address: string, family: "ipv4" | "ipv6"): boolean {
  const own = ownAddresses();
  return own === null || own.check(address, family);
}

/** True when the fetcher must not connect to this address. Anything not an IP is blocked. */
export function isBlockedAddress(address: string): boolean {
  // A zone ID ("fe80::1%eth0") only appears on link-local addresses.
  if (address.includes("%")) return true;
  // BlockList.check returns false for strings that are not addresses, and for an address
  // checked under the wrong family, so the family must come from the address itself.
  const family = net.isIP(address);
  if (family === 4) return blockedV4.check(address, "ipv4") || isOwnAddress(address, "ipv4");
  if (family === 6) {
    return (
      mappedV6.check(address, "ipv6") ||
      blockedV6.check(address, "ipv6") ||
      !globalV6.check(address, "ipv6") ||
      isOwnAddress(address, "ipv6")
    );
  }
  return true;
}

export type LinkRefusal = "invalid-link" | "scheme" | "credentials" | "port" | "blocked-address";

export type LinkCheck = { ok: true; url: URL } | { ok: false; reason: LinkRefusal };

/** A host given as `[v6]` in a URL is checked without its brackets. */
export function bareHost(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * The rules for the link and every redirect target: http(s) only, no credentials,
 * port 80 or 443, and a host given as an IP address must not be blocked. The WHATWG URL
 * parser has already turned forms like `http://2130706433/`, `http://0x7f.1/`, `%31%32%37.0.0.1`
 * or full-width digits into dotted IPv4, so they are caught here as IP literals. Anything that
 * stays a name is checked again on every address it resolves to (see safe-fetch.ts).
 */
export function checkLink(link: string | URL): LinkCheck {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return { ok: false, reason: "invalid-link" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  // An empty port is the scheme's default (the parser drops :80 on http and :443 on https).
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    return { ok: false, reason: "port" };
  }
  // Every trailing dot: the URL parser keeps "127.0.0.1.." and "localhost.." as names.
  const host = bareHost(url.hostname).replace(/\.+$/, "");
  if (!host) return { ok: false, reason: "invalid-link" };
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) return { ok: false, reason: "blocked-address" };
  } else if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) {
    // "localhost" is always loopback, and a name without a dot is never a public job page.
    // The DNS check would refuse most of these anyway; this saves the lookup.
    return { ok: false, reason: "blocked-address" };
  }
  return { ok: true, url };
}
