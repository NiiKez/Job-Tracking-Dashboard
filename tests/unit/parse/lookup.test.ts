import dns from "node:dns";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isBlockedAddress } from "@/lib/server/parse/address";
import {
  BlockedAddressError,
  createGuardedAgent,
  createGuardedConnector,
  createGuardedLookup,
  MAX_LOOKUPS,
  safeFetch,
  type Resolver,
} from "@/lib/server/parse/safe-fetch";

// Nothing here reaches the network: names come from stub resolvers, and the only sockets
// opened go to a server of this test on 127.0.0.1, which only the `isBlocked` test seam allows.

function stub(table: Record<string, string[]>): Resolver {
  return async (hostname) => {
    const found = table[hostname];
    if (!found) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return found.map((address) => ({ address, family: net.isIP(address) }));
  };
}

type LookupResult = { err: NodeJS.ErrnoException | null; address: unknown; family?: number };

function runLookup(
  lookup: ReturnType<typeof createGuardedLookup>,
  hostname: string,
  options: Parameters<typeof lookup>[1],
) {
  return new Promise<LookupResult>((resolve) =>
    lookup(hostname, options, (err, address, family) => resolve({ err, address, family })),
  );
}

const allowTestServer = (address: string) => address !== "127.0.0.1" && isBlockedAddress(address);

describe("guarded lookup", () => {
  const resolve = stub({
    "public.example.com": ["93.184.215.14", "2606:4700::1111"],
    "mixed.example.com": ["93.184.215.14", "10.0.0.7"],
    "mixed6.example.com": ["2606:4700::1111", "fd00::7"],
    "mapped.example.com": ["93.184.215.14", "::ffff:127.0.0.1"],
    "nat64.example.com": ["64:ff9b::a00:1"],
    "garbage.example.com": ["not-an-address"],
    "empty.example.com": [],
  });
  const lookup = createGuardedLookup(resolve);

  it.each(["mixed.example.com", "mixed6.example.com", "mapped.example.com", "nat64.example.com"])(
    "refuses %s when any answer is blocked, in both call shapes",
    async (hostname) => {
      for (const options of [{ all: true }, {}]) {
        const result = await runLookup(lookup, hostname, options);
        expect(result.err).toBeInstanceOf(BlockedAddressError);
      }
    },
  );

  it("refuses an answer that is not an IP address", async () => {
    const result = await runLookup(lookup, "garbage.example.com", { all: true });
    expect(result.err).toBeInstanceOf(BlockedAddressError);
  });

  it("returns every address for all: true (autoSelectFamily)", async () => {
    const result = await runLookup(lookup, "public.example.com", { all: true });
    expect(result.err).toBeNull();
    expect(result.address).toEqual([
      { address: "93.184.215.14", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]);
  });

  it("returns the first address and its family for the single shape", async () => {
    const result = await runLookup(lookup, "public.example.com", {});
    expect(result).toEqual({ err: null, address: "93.184.215.14", family: 4 });
  });

  it("honours a requested family", async () => {
    expect(await runLookup(lookup, "public.example.com", { family: 6 })).toEqual({
      err: null,
      address: "2606:4700::1111",
      family: 6,
    });
    const v4 = await runLookup(lookup, "public.example.com", { family: "IPv4", all: true });
    expect(v4.address).toEqual([{ address: "93.184.215.14", family: 4 }]);
  });

  it("reports no answer and resolver errors as DNS errors", async () => {
    expect((await runLookup(lookup, "empty.example.com", { all: true })).err?.code).toBe("ENOTFOUND");
    expect((await runLookup(lookup, "unknown.example.com", {})).err?.code).toBe("ENOTFOUND");
  });
});

describe("the system resolver", () => {
  it(`runs at most ${MAX_LOOKUPS} lookups at once; more fail as a DNS error`, async () => {
    // getaddrinfo cannot be cancelled and holds one of libuv's four pool threads until the
    // system resolver gives up, so lookups that hang must not take the whole pool.
    const pending: Array<() => void> = [];
    const spy = vi.spyOn(dns.promises, "lookup").mockImplementation(
      () =>
        new Promise((done) => {
          pending.push(() => done([{ address: "93.184.215.14", family: 4 }] as never));
        }),
    );
    try {
      const lookup = createGuardedLookup();
      const hanging = Array.from({ length: MAX_LOOKUPS }, (_, i) =>
        runLookup(lookup, `slow${i}.example.com`, { all: true }),
      );
      const over = await runLookup(lookup, "one-more.example.com", { all: true });
      expect(over.err?.code).toBe("EAI_AGAIN");
      expect(spy).toHaveBeenCalledTimes(MAX_LOOKUPS);

      // Once the hanging lookups finish, the slots are free again.
      for (const finish of pending.splice(0)) finish();
      for (const result of await Promise.all(hanging)) expect(result.err).toBeNull();
      const again = runLookup(lookup, "later.example.com", { all: true });
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      pending[0]();
      expect((await again).err).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("guarded lookup inside net.connect", () => {
  let server: net.Server;
  let port: number;
  const accepted = vi.fn();

  beforeAll(async () => {
    server = net.createServer((socket) => {
      accepted();
      socket.on("error", () => {});
      socket.end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  function connect(lookup: net.LookupFunction, autoSelectFamily: boolean) {
    return new Promise<string | Error>((resolve) => {
      const socket = net.connect({ host: "jobs.example.com", port, lookup, autoSelectFamily });
      socket.on("connect", () => {
        resolve(socket.remoteAddress ?? "");
        socket.destroy();
      });
      socket.on("error", resolve);
    });
  }

  const resolve = stub({ "jobs.example.com": ["127.0.0.1"] });

  it.each([true, false])("connects to the checked address (autoSelectFamily %s)", async (auto) => {
    const lookup = createGuardedLookup(resolve, allowTestServer);
    expect(await connect(lookup, auto)).toBe("127.0.0.1");
  });

  it.each([true, false])(
    "never opens the socket with the real block list (autoSelectFamily %s)",
    async (auto) => {
      accepted.mockClear();
      const result = await connect(createGuardedLookup(resolve), auto);
      expect(result).toBeInstanceOf(BlockedAddressError);
      expect(accepted).not.toHaveBeenCalled();
    },
  );
});

describe("guarded connector", () => {
  it.each(["127.0.0.1", "10.0.0.1", "::1", "::ffff:7f00:1"])(
    "refuses the IP literal %s without a lookup",
    async (hostname) => {
      const resolve = vi.fn(stub({}));
      const connect = createGuardedConnector({ resolve });
      const err = await new Promise((done) =>
        connect({ hostname, protocol: "http:", port: "80" }, (...args) => done(args[0])),
      );
      expect(err).toBeInstanceOf(BlockedAddressError);
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("sends the hostname as TLS SNI while connecting to the pinned address", async () => {
    let clientHello = "";
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", (chunk) => {
        clientHello = chunk.toString("latin1");
        socket.destroy();
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as net.AddressInfo;
    const connect = createGuardedConnector({
      resolve: stub({ "jobs.example.com": ["127.0.0.1"] }),
      isBlocked: allowTestServer,
    });
    await new Promise((done) =>
      connect(
        { hostname: "jobs.example.com", host: "jobs.example.com", protocol: "https:", port: String(port) },
        (...args) => done(args[0]),
      ),
    );
    await new Promise<void>((done) => server.close(() => done()));
    // The ClientHello carries the server name in clear text.
    expect(clientHello).toContain("jobs.example.com");
  });
});

describe("guarded agent", () => {
  it.each([
    ["internal.example.com", ["10.0.0.7"]],
    ["loopback.example.com", ["127.0.0.1"]],
    ["metadata.example.com", ["169.254.169.254"]],
    ["mapped.example.com", ["::ffff:127.0.0.1"]],
    ["ula.example.com", ["fd00::1"]],
  ])("refuses %s (resolves to %j) through undici", async (hostname, addresses) => {
    const resolve = vi.fn(stub({ [hostname]: addresses }));
    const agent = createGuardedAgent({ resolve });
    const outcome = await safeFetch(`https://${hostname}/jobs/1`, { dispatcher: agent });
    expect(outcome).toEqual({ ok: false, reason: "blocked-address", host: hostname });
    // The lookup that refused is the one undici's connection called.
    expect(resolve).toHaveBeenCalledWith(hostname);
    await agent.close();
  });

  it("reports an unknown name as a DNS failure", async () => {
    const agent = createGuardedAgent({ resolve: stub({}) });
    const outcome = await safeFetch("https://nowhere.example.com/", { dispatcher: agent });
    expect(outcome).toEqual({ ok: false, reason: "dns", host: "nowhere.example.com" });
    await agent.close();
  });

  it("cuts a DNS lookup that never answers at the deadline", async () => {
    const agent = createGuardedAgent({ resolve: () => new Promise(() => {}) });
    const started = Date.now();
    const outcome = await safeFetch("https://slow-dns.example.com/", { dispatcher: agent, timeoutMs: 100 });
    expect(outcome).toEqual({ ok: false, reason: "timeout", host: "slow-dns.example.com" });
    expect(Date.now() - started).toBeLessThan(2_000);
    await agent.destroy();
  });

  describe("with proxy variables set", () => {
    let proxy: net.Server;
    const proxied = vi.fn();
    const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
    const saved = new Map<string, string | undefined>();

    beforeAll(async () => {
      proxy = net.createServer((socket) => {
        proxied();
        socket.destroy();
      });
      await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
      const url = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
      for (const name of names) {
        saved.set(name, process.env[name]);
        process.env[name] = url;
      }
      saved.set("NO_PROXY", process.env.NO_PROXY);
      delete process.env.NO_PROXY;
    });

    afterAll(async () => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await new Promise<void>((done) => proxy.close(() => done()));
    });

    it("still resolves and checks the name itself, and never talks to the proxy", async () => {
      // Through a proxy, the proxy would resolve the name and this check would never run.
      const resolve = vi.fn(stub({ "internal.example.com": ["10.0.0.7"] }));
      const agent = createGuardedAgent({ resolve });
      for (const link of ["http://internal.example.com/", "https://internal.example.com/"]) {
        expect(await safeFetch(link, { dispatcher: agent })).toEqual({
          ok: false,
          reason: "blocked-address",
          host: "internal.example.com",
        });
      }
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(proxied).not.toHaveBeenCalled();
      await agent.close();
    });
  });
});
