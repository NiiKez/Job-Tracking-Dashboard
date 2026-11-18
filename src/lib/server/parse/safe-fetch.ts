import "server-only";
import dns from "node:dns";
import net, { type LookupFunction } from "node:net";
import { Agent, buildConnector, fetch, type Dispatcher, type Response } from "undici";
import { bareHost, checkLink, isBlockedAddress, type LinkCheck, type LinkRefusal } from "./address";

/**
 * Fetches a job page for the link parser. This runs on a public server with a user-supplied
 * link, so every connection is pinned to addresses that were checked against the block list,
 * redirects are followed by hand and checked again, and size and time are capped.
 */

export const FETCH_TIMEOUT_MS = 8_000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 4;

// A plain desktop browser: no app name and no contact address, so the request reveals nothing
// about who runs this server, and sites serve the same page a person would see.
const REQUEST_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml;q=0.9",
  "accept-language": "en,de;q=0.8",
};

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FetchFailure =
  | LinkRefusal
  | "dns"
  | "redirect"
  | "too-many-redirects"
  | "http-status"
  | "content-type"
  | "too-large"
  | "timeout"
  | "network"
  | "rate-limited"
  | "offline";

/** `host` is where it failed (a redirect target, perhaps), for one log line. */
export type FetchOutcome =
  | { ok: true; html: string; url: string }
  | { ok: false; reason: FetchFailure; host: string };

/** Raised inside the connection; found again in the fetch error's cause chain. */
export class BlockedAddressError extends Error {
  readonly code = "ERR_BLOCKED_ADDRESS";

  constructor() {
    super("Blocked address");
    this.name = "BlockedAddressError";
  }
}

export type Resolver = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family?: number }>>;

// The same query net.connect makes by default (ADDRCONFIG: only families this host can use).
// Never V4MAPPED: mapped answers are blocked, so they would refuse every IPv4-only site.
//
// dns.lookup runs getaddrinfo on libuv's thread pool (4 threads), and it cannot be cancelled: a
// name whose DNS server never answers holds a thread until the system resolver gives up, long
// after the fetch's deadline. The pool also runs zlib, file system and crypto work for the
// whole app, so at most MAX_LOOKUPS link lookups run at once; more fail as a DNS error (the
// parser falls back to the heuristics).
export const MAX_LOOKUPS = 2;
let lookupsInFlight = 0;

const systemResolve: Resolver = async (hostname) => {
  if (lookupsInFlight >= MAX_LOOKUPS) {
    const err: NodeJS.ErrnoException = new Error("Too many lookups in flight");
    err.code = "EAI_AGAIN";
    throw err;
  }
  lookupsInFlight++;
  try {
    return await dns.promises.lookup(hostname, { all: true, hints: dns.ADDRCONFIG });
  } finally {
    lookupsInFlight--;
  }
};

/**
 * The `lookup` given to net.connect / tls.connect. The answer checked here is the answer the
 * socket connects to, so a second DNS query cannot swap in another address. Node calls it
 * with `all: true` when it may try several addresses (autoSelectFamily, the default) and
 * without it otherwise; both shapes are answered. `isBlocked` exists for tests only.
 */
export function createGuardedLookup(
  resolve: Resolver = systemResolve,
  isBlocked: (address: string) => boolean = isBlockedAddress,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (found) => {
        // The family comes from the address itself, not from what the resolver claims.
        const addresses = found.map((a) => ({ address: a.address, family: net.isIP(a.address) }));
        // Refuse if any answer is blocked, not only the first: the socket may try them all.
        if (addresses.some((a) => isBlocked(a.address))) {
          callback(new BlockedAddressError(), "");
          return;
        }
        const family = familyOf(options.family);
        const usable = family ? addresses.filter((a) => a.family === family) : addresses;
        if (usable.length === 0) {
          callback(notFound(hostname), "");
        } else if (options.all) {
          callback(null, usable);
        } else {
          callback(null, usable[0].address, usable[0].family);
        }
      },
      (err: NodeJS.ErrnoException) => callback(err, ""),
    );
  };
}

function familyOf(family: number | "IPv4" | "IPv6" | undefined) {
  if (family === 4 || family === "IPv4") return 4;
  if (family === 6 || family === "IPv6") return 6;
  return 0;
}

function notFound(hostname: string) {
  const err: NodeJS.ErrnoException = new Error(`No usable address for ${hostname}`);
  err.code = "ENOTFOUND";
  return err;
}

export interface GuardOptions {
  /** Test seam: name resolution. Default: the system resolver (dns.lookup). */
  resolve?: Resolver;
  /** Test seam: lets a test reach its own server on 127.0.0.1. Production code never sets it. */
  isBlocked?: (address: string) => boolean;
}

/**
 * undici's connector with the guarded lookup. TLS still gets the hostname (SNI and the
 * certificate check), since only the lookup changes, not the host given to tls.connect.
 */
export function createGuardedConnector(guard: GuardOptions = {}): buildConnector.connector {
  const isBlocked = guard.isBlocked ?? isBlockedAddress;
  const connect = buildConnector({
    lookup: createGuardedLookup(guard.resolve, isBlocked),
    timeout: FETCH_TIMEOUT_MS,
  });
  return (options, callback) => {
    // Node skips the lookup for an IP literal; checkLink has refused blocked ones already,
    // this repeats the check where the connection is made.
    const host = bareHost(options.hostname);
    if (net.isIP(host) && isBlocked(host)) {
      callback(new BlockedAddressError(), null);
      return;
    }
    connect(options, (err, socket) => {
      if (err) {
        callback(err, null);
        return;
      }
      // Belt and braces: the peer must be an address the lookup allowed.
      const remote = socket.remoteAddress;
      if (!remote || isBlocked(remote)) {
        socket.destroy();
        callback(new BlockedAddressError(), null);
        return;
      }
      callback(null, socket);
    });
  };
}

export function createGuardedAgent(guard: GuardOptions = {}) {
  return new Agent({
    connect: createGuardedConnector(guard),
    headersTimeout: FETCH_TIMEOUT_MS,
    bodyTimeout: FETCH_TIMEOUT_MS,
    keepAliveTimeout: 4_000,
    keepAliveMaxTimeout: 10_000,
  });
}

let sharedAgent: Agent | undefined;

// Created on first use, so importing this module (for example during `next build`) opens nothing.
function guardedAgent() {
  sharedAgent ??= createGuardedAgent();
  return sharedAgent;
}

let dispatcherForTests: Dispatcher | undefined;

/**
 * Test seam: the dispatcher safeFetch uses when none is passed, such as an undici MockAgent for
 * a database test that calls parseInput with a link. Under Vitest the guarded agent is never the
 * default: without a dispatcher set here, a fetch ends as "offline" (and the parser falls back
 * to the heuristics) instead of reaching the internet. Outside Vitest this has no effect.
 */
export function setDispatcherForTests(dispatcher: Dispatcher | undefined): void {
  dispatcherForTests = dispatcher;
}

function defaultDispatcher(): Dispatcher | undefined {
  return process.env.VITEST ? dispatcherForTests : guardedAgent();
}

export interface SafeFetchOptions {
  /** Test seam: what every request goes through. Default: the guarded agent and the real block list. */
  dispatcher?: Dispatcher;
  /** Test seam: total time for the whole redirect chain. */
  timeoutMs?: number;
  /**
   * Asked before every request: the link and each redirect target, which may be on another
   * host. False ends the fetch as "rate-limited". The parser charges the user's budget here.
   */
  take?: () => boolean;
}

/**
 * Fetches an HTML page. Never throws: any failure comes back as a reason code, and nothing
 * from the upstream response (page text, error messages) is put in it.
 */
export async function safeFetch(link: string, opts: SafeFetchOptions = {}): Promise<FetchOutcome> {
  // Never undici's global dispatcher: it is process-wide state that other code, or Node's
  // NODE_USE_ENV_PROXY, can replace with a proxy. Every request names its dispatcher, and the
  // guarded agent connects directly (no proxy variable is read anywhere on this path).
  const dispatcher = opts.dispatcher ?? defaultDispatcher();
  // One signal for the whole chain: every hop and the body share the same 8 seconds.
  const signal = AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  let host = hostOf(link);
  const fail = (reason: FetchFailure): FetchOutcome => ({ ok: false, reason, host });

  let check: LinkCheck = checkLink(link);
  for (let redirects = 0; ; redirects++) {
    if (!check.ok) return fail(check.reason);
    const url = check.url;
    host = url.hostname;
    if (!dispatcher) return fail("offline");
    if (opts.take && !opts.take()) return fail("rate-limited");

    let res: Response;
    try {
      res = await fetch(url.href, {
        dispatcher,
        signal,
        redirect: "manual",
        headers: REQUEST_HEADERS,
      });
    } catch (err) {
      return fail(failureOf(err, signal));
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      await discard(res);
      if (redirects >= MAX_REDIRECTS) return fail("too-many-redirects");
      const location = res.headers.get("location");
      if (!location) return fail("redirect");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return fail("redirect");
      }
      host = next.hostname;
      check = checkLink(next);
      continue;
    }

    if (!res.ok) {
      await discard(res);
      return fail("http-status");
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!HTML_TYPES.has(contentType.split(";")[0].trim().toLowerCase())) {
      await discard(res);
      return fail("content-type");
    }
    // A declared length is the decoded size only when there is no content-encoding.
    const declared = Number(res.headers.get("content-length"));
    if (!res.headers.has("content-encoding") && declared > MAX_BODY_BYTES) {
      await discard(res);
      return fail("too-large");
    }

    let bytes: Uint8Array | null;
    try {
      bytes = await readLimited(res, MAX_BODY_BYTES);
    } catch (err) {
      return fail(failureOf(err, signal));
    }
    if (!bytes) return fail("too-large");
    return { ok: true, html: decode(bytes, contentType), url: url.href };
  }
}

function hostOf(link: string) {
  try {
    return new URL(link).hostname;
  } catch {
    return "(invalid)";
  }
}

async function discard(res: Response) {
  await res.body?.cancel().catch(() => {});
}

/** Reads the decompressed body, stopping as soon as it passes `max` bytes. */
async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    size += chunk.byteLength;
    if (size > max) {
      // Cancelling stops decompression and drops the connection: nothing past the limit is read.
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/**
 * The page's text, with the encoding chosen as browsers do (WHATWG "decode"): a byte order mark
 * wins over everything, then the Content-Type charset, then a `<meta>` charset, else UTF-8.
 */
function decode(bytes: Uint8Array, contentType: string) {
  const label = bomCharset(bytes) ?? charsetIn(contentType) ?? metaCharset(bytes) ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    // Unknown charset label.
    decoder = new TextDecoder();
  }
  // TextDecoder drops a BOM that matches its encoding.
  return decoder.decode(bytes);
}

function bomCharset(bytes: Uint8Array) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  return undefined;
}

function charsetIn(text: string) {
  return /charset\s*=\s*["']?([\w.:-]+)/i.exec(text)?.[1];
}

/**
 * `<meta charset>` or the http-equiv form, in the first 1024 bytes as browsers do. A UTF-16
 * label there means UTF-8: the bytes were readable as ASCII to find it, so they are not UTF-16.
 */
function metaCharset(bytes: Uint8Array) {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024));
  const label = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head.toString("latin1"))?.[1];
  return label && /^(utf-16|utf-16be|utf-16le|unicode|ucs-2|unicodefffe)$/i.test(label) ? "utf-8" : label;
}

function failureOf(err: unknown, signal: AbortSignal): FetchFailure {
  if (signal.aborted) return "timeout";
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current instanceof BlockedAddressError) return "blocked-address";
    const code = (current as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") return "dns";
    current = current.cause;
  }
  return "network";
}
