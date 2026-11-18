import { readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { Agent, MockAgent } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isBlockedAddress } from "@/lib/server/parse/address";
import {
  MAX_BODY_BYTES,
  createGuardedConnector,
  safeFetch,
  setDispatcherForTests,
  type Resolver,
} from "@/lib/server/parse/safe-fetch";

const HTML = { "content-type": "text/html; charset=utf-8" };
const PAGE = "<!doctype html><title>Backend Engineer</title>";

function stub(table: Record<string, string[]>): Resolver {
  return async (hostname) => {
    const found = table[hostname];
    if (!found) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return found.map((address) => ({ address }));
  };
}

describe("safeFetch over a mocked HTTP layer", () => {
  let mock: MockAgent;
  const pool = (origin: string) => mock.get(origin);

  beforeEach(() => {
    mock = new MockAgent();
    mock.disableNetConnect();
  });

  afterEach(() => mock.close());

  it("returns the page", async () => {
    pool("https://jobs.example.com").intercept({ path: "/job/1" }).reply(200, PAGE, { headers: HTML });
    expect(await safeFetch("https://jobs.example.com/job/1", { dispatcher: mock })).toEqual({
      ok: true,
      html: PAGE,
      url: "https://jobs.example.com/job/1",
    });
  });

  it("sends a generic browser User-Agent and asks for HTML", async () => {
    let headers: Record<string, string> = {};
    pool("https://jobs.example.com")
      .intercept({ path: "/" })
      .reply((req) => {
        headers = req.headers as Record<string, string>;
        return { statusCode: 200, data: PAGE, responseOptions: { headers: HTML } };
      });
    await safeFetch("https://jobs.example.com/", { dispatcher: mock });
    expect(headers["user-agent"]).toMatch(/^Mozilla\/5\.0 .*Chrome\/\d+/);
    expect(headers["user-agent"]).not.toMatch(/job|tracker|@|http/i);
    expect(headers.accept).toMatch(/^text\/html/);
  });

  describe("decoding as browsers do", () => {
    const TITLE = "Café Engineer – Köln";
    const page = (head = "") => `<!doctype html><html><head>${head}<title>${TITLE}</title></head></html>`;

    async function fetchBody(body: Buffer, contentType: string) {
      pool("https://jobs.example.com").intercept({ path: "/" }).reply(200, body, { headers: { "content-type": contentType } });
      const result = await safeFetch("https://jobs.example.com/", { dispatcher: mock });
      return result.ok ? result.html : `(failed: ${result.reason})`;
    }

    it("a UTF-8 BOM wins over the Content-Type charset", async () => {
      const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(page(), "utf8")]);
      expect(await fetchBody(body, "text/html; charset=iso-8859-1")).toBe(page());
    });

    it("a UTF-16LE page with a BOM and no label is read", async () => {
      const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(page(), "utf16le")]);
      expect(await fetchBody(body, "text/html")).toBe(page());
    });

    it('<meta charset="utf-16"> means UTF-8', async () => {
      const html = page('<meta charset="utf-16">');
      expect(await fetchBody(Buffer.from(html, "utf8"), "text/html")).toBe(html);
    });
  });

  it("accepts application/xhtml+xml", async () => {
    pool("https://jobs.example.com")
      .intercept({ path: "/" })
      .reply(200, PAGE, { headers: { "content-type": "application/xhtml+xml" } });
    expect((await safeFetch("https://jobs.example.com/", { dispatcher: mock })).ok).toBe(true);
  });

  it("decodes the charset from the header or from <meta charset>", async () => {
    const latin1 = Buffer.from("<title>Café Köln</title>", "latin1");
    pool("https://jobs.example.com")
      .intercept({ path: "/header" })
      .reply(200, latin1, { headers: { "content-type": "text/html; charset=ISO-8859-1" } });
    const sniffed = Buffer.from('<meta charset="iso-8859-1"><title>Café Köln</title>', "latin1");
    pool("https://jobs.example.com")
      .intercept({ path: "/meta" })
      .reply(200, sniffed, { headers: { "content-type": "text/html" } });

    const a = await safeFetch("https://jobs.example.com/header", { dispatcher: mock });
    const b = await safeFetch("https://jobs.example.com/meta", { dispatcher: mock });
    expect(a.ok && a.html).toContain("Café Köln");
    expect(b.ok && b.html).toContain("Café Köln");
  });

  it.each([
    ["application/json", '{"title":"x"}'],
    ["text/plain", "hello"],
    ["image/png", "\x89PNG"],
    ["application/pdf", "%PDF-1.7"],
    ["text/htmlx", PAGE],
  ])("refuses content type %s", async (type, body) => {
    pool("https://jobs.example.com")
      .intercept({ path: "/" })
      .reply(200, body, { headers: { "content-type": type } });
    expect(await safeFetch("https://jobs.example.com/", { dispatcher: mock })).toEqual({
      ok: false,
      reason: "content-type",
      host: "jobs.example.com",
    });
  });

  it("refuses a response without a content type", async () => {
    pool("https://jobs.example.com").intercept({ path: "/" }).reply(200, PAGE);
    const outcome = await safeFetch("https://jobs.example.com/", { dispatcher: mock });
    expect(outcome.ok === false && outcome.reason).toBe("content-type");
  });

  it.each([404, 410, 500, 503, 304])("refuses HTTP status %i", async (status) => {
    pool("https://jobs.example.com").intercept({ path: "/" }).reply(status, PAGE, { headers: HTML });
    const outcome = await safeFetch("https://jobs.example.com/", { dispatcher: mock });
    expect(outcome.ok === false && outcome.reason).toBe("http-status");
  });

  describe("size", () => {
    it("reads a page of exactly 2 MB", async () => {
      pool("https://jobs.example.com")
        .intercept({ path: "/" })
        .reply(200, "a".repeat(MAX_BODY_BYTES), { headers: HTML });
      const outcome = await safeFetch("https://jobs.example.com/", { dispatcher: mock });
      expect(outcome.ok && outcome.html.length).toBe(MAX_BODY_BYTES);
    });

    it("stops reading past 2 MB", async () => {
      pool("https://jobs.example.com")
        .intercept({ path: "/" })
        .reply(200, "a".repeat(MAX_BODY_BYTES + 1), { headers: HTML });
      const outcome = await safeFetch("https://jobs.example.com/", { dispatcher: mock });
      expect(outcome.ok === false && outcome.reason).toBe("too-large");
    });

    it("refuses a declared length over 2 MB before reading", async () => {
      pool("https://jobs.example.com")
        .intercept({ path: "/" })
        .reply(200, PAGE, { headers: { ...HTML, "content-length": String(MAX_BODY_BYTES + 1) } });
      const outcome = await safeFetch("https://jobs.example.com/", { dispatcher: mock });
      expect(outcome.ok === false && outcome.reason).toBe("too-large");
    });

    it("counts bytes after decompression", async () => {
      const bomb = zlib.gzipSync("a".repeat(MAX_BODY_BYTES * 4));
      expect(bomb.length).toBeLessThan(50_000);
      pool("https://jobs.example.com")
        .intercept({ path: "/" })
        .reply(200, bomb, { headers: { ...HTML, "content-encoding": "gzip" } });
      const outcome = await safeFetch("https://jobs.example.com/", { dispatcher: mock });
      expect(outcome.ok === false && outcome.reason).toBe("too-large");
    });

    it("decompresses a normal gzip page", async () => {
      pool("https://jobs.example.com")
        .intercept({ path: "/" })
        .reply(200, zlib.gzipSync(PAGE), { headers: { ...HTML, "content-encoding": "gzip" } });
      const outcome = await safeFetch("https://jobs.example.com/", { dispatcher: mock });
      expect(outcome.ok && outcome.html).toBe(PAGE);
    });
  });

  describe("time", () => {
    it("times out a slow response", async () => {
      pool("https://jobs.example.com").intercept({ path: "/" }).reply(200, PAGE, { headers: HTML }).delay(2_000);
      const started = Date.now();
      const outcome = await safeFetch("https://jobs.example.com/", { dispatcher: mock, timeoutMs: 50 });
      expect(outcome).toEqual({ ok: false, reason: "timeout", host: "jobs.example.com" });
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it("uses one deadline for the whole redirect chain", async () => {
      // Each hop alone fits in the limit; together they do not.
      pool("https://jobs.example.com")
        .intercept({ path: "/a" })
        .reply(302, "", { headers: { location: "/b" } })
        .delay(150);
      pool("https://jobs.example.com").intercept({ path: "/b" }).reply(200, PAGE, { headers: HTML }).delay(150);
      const outcome = await safeFetch("https://jobs.example.com/a", { dispatcher: mock, timeoutMs: 250 });
      expect(outcome.ok === false && outcome.reason).toBe("timeout");
    });
  });

  describe("redirects", () => {
    function redirect(origin: string, path: string, location: string, status = 302) {
      pool(origin).intercept({ path }).reply(status, "", { headers: { location } });
    }

    it("follows up to four redirects, re-resolving relative locations", async () => {
      redirect("https://jobs.example.com", "/1", "/2", 301);
      redirect("https://jobs.example.com", "/2", "https://careers.example.com/3", 302);
      redirect("https://careers.example.com", "/3", "4", 307);
      redirect("https://careers.example.com", "/4", "//apply.example.com/5", 308);
      pool("https://apply.example.com").intercept({ path: "/5" }).reply(200, PAGE, { headers: HTML });
      expect(await safeFetch("https://jobs.example.com/1", { dispatcher: mock })).toEqual({
        ok: true,
        html: PAGE,
        url: "https://apply.example.com/5",
      });
    });

    it("refuses a fifth redirect", async () => {
      for (let i = 1; i <= 5; i++) redirect("https://jobs.example.com", `/${i}`, `/${i + 1}`, 303);
      pool("https://jobs.example.com").intercept({ path: "/6" }).reply(200, PAGE, { headers: HTML });
      const outcome = await safeFetch("https://jobs.example.com/1", { dispatcher: mock });
      expect(outcome.ok === false && outcome.reason).toBe("too-many-redirects");
      // The sixth request is never made.
      expect(mock.pendingInterceptors()).toHaveLength(1);
    });

    it("refuses a redirect without a location", async () => {
      pool("https://jobs.example.com").intercept({ path: "/" }).reply(302, "");
      const outcome = await safeFetch("https://jobs.example.com/", { dispatcher: mock });
      expect(outcome.ok === false && outcome.reason).toBe("redirect");
    });

    it.each([
      ["http://10.0.0.5/admin", "blocked-address", "10.0.0.5"],
      ["http://127.0.0.1/", "blocked-address", "127.0.0.1"],
      ["http://2130706433/", "blocked-address", "127.0.0.1"],
      ["http://[::ffff:127.0.0.1]/", "blocked-address", "[::ffff:7f00:1]"],
      ["http://169.254.169.254/latest/meta-data/", "blocked-address", "169.254.169.254"],
      ["http://localhost/", "blocked-address", "localhost"],
      ["http://jobs.example.com:8080/", "port", "jobs.example.com"],
      ["https://admin:pw@jobs.example.com/", "credentials", "jobs.example.com"],
      ["ftp://jobs.example.com/file", "scheme", "jobs.example.com"],
      ["file:///etc/passwd", "scheme", ""],
    ])("re-checks every hop: refuses a redirect to %s", async (location, reason, host) => {
      redirect("https://jobs.example.com", "/", location);
      // If the check were skipped, these would answer.
      pool("http://10.0.0.5").intercept({ path: "/admin" }).reply(200, "secret", { headers: HTML });
      pool("http://127.0.0.1").intercept({ path: "/" }).reply(200, "secret", { headers: HTML });
      expect(await safeFetch("https://jobs.example.com/", { dispatcher: mock })).toEqual({
        ok: false,
        reason,
        host,
      });
      expect(mock.pendingInterceptors()).toHaveLength(2);
    });

    it("re-checks DNS on every hop: refuses a redirect to a name that resolves privately", async () => {
      // Unmatched hosts go to a real connection made by the guarded connector, whose stubbed
      // lookup answers with a private address; it is refused before any socket is opened.
      const guarded = new MockAgent({
        connect: createGuardedConnector({ resolve: stub({ "internal.example.com": ["10.0.0.7"] }) }),
      });
      guarded.disableNetConnect();
      guarded.enableNetConnect("internal.example.com");
      guarded
        .get("https://jobs.example.com")
        .intercept({ path: "/" })
        .reply(302, "", { headers: { location: "https://internal.example.com/admin" } });
      expect(await safeFetch("https://jobs.example.com/", { dispatcher: guarded })).toEqual({
        ok: false,
        reason: "blocked-address",
        host: "internal.example.com",
      });
      await guarded.close();
    });
  });

  it("refuses a bad link before any request", async () => {
    expect(await safeFetch("http://192.168.0.1/", { dispatcher: mock })).toEqual({
      ok: false,
      reason: "blocked-address",
      host: "192.168.0.1",
    });
    expect(await safeFetch("nonsense", { dispatcher: mock })).toEqual({
      ok: false,
      reason: "invalid-link",
      host: "(invalid)",
    });
  });
});

describe("safeFetch over real sockets to a local test server", () => {
  // The test dispatcher sends every connection to this server: names resolve through a stub,
  // the guarded connector checks them with the real block list except for 127.0.0.1 (this
  // server only), and the port is rewritten because links may only use 80 and 443.
  let server: http.Server;
  let agent: Agent;
  const requests: string[] = [];
  const cookies: Array<string | undefined> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests.push(`${req.headers.host}${req.url}`);
      if (req.url === "/start") {
        res.writeHead(302, { location: "/page" }).end();
      } else if (req.url === "/page") {
        res.writeHead(200, { ...HTML, "content-encoding": "gzip" }).end(zlib.gzipSync(PAGE));
      } else if (req.url === "/to-internal") {
        res.writeHead(302, { location: "http://internal.example.com/admin" }).end();
      } else if (req.url === "/to-literal") {
        res.writeHead(302, { location: "http://192.168.1.1/" }).end();
      } else if (req.url === "/bomb") {
        res.writeHead(200, { ...HTML, "content-encoding": "gzip" });
        res.end(zlib.gzipSync("a".repeat(MAX_BODY_BYTES * 3)));
      } else if (req.url === "/stall") {
        // Headers and a first chunk, then nothing.
        res.writeHead(200, HTML);
        res.write("<html><title>Slow");
      } else if (req.url === "/endless" || req.url === "/endless-gzip") {
        // A body that never ends: only a limit enforced while reading can stop it before the deadline.
        const gzip = req.url === "/endless-gzip";
        res.writeHead(200, gzip ? { ...HTML, "content-encoding": "gzip" } : HTML);
        const out = gzip ? zlib.createGzip() : res;
        if (gzip) out.pipe(res);
        out.on("error", () => {});
        const chunk = Buffer.alloc(64 * 1024, "a");
        let closed = false;
        res.on("close", () => {
          closed = true;
          if (gzip) out.destroy();
        });
        const pump = () => {
          while (!closed) {
            if (!out.write(chunk)) {
              out.once("drain", pump);
              return;
            }
          }
        };
        pump();
      } else if (req.url === "/set-cookie") {
        res.writeHead(302, { location: "/echo-cookie", "set-cookie": "session=abc123; Path=/" }).end();
      } else if (req.url === "/echo-cookie") {
        cookies.push(req.headers.cookie);
        res.writeHead(200, { ...HTML, "set-cookie": "other=1; Path=/" }).end(PAGE);
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as net.AddressInfo;
    const guarded = createGuardedConnector({
      resolve: stub({
        "jobs.example.com": ["127.0.0.1"],
        "internal.example.com": ["10.0.0.7"],
        "mixed.example.com": ["127.0.0.1", "192.168.0.10"],
      }),
      isBlocked: (address) => address !== "127.0.0.1" && isBlockedAddress(address),
    });
    agent = new Agent({ connect: (opts, callback) => guarded({ ...opts, port: String(port) }, callback) });
  });

  afterAll(async () => {
    await agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });

  beforeEach(() => {
    requests.length = 0;
  });

  it("follows a redirect and decompresses the page", async () => {
    expect(await safeFetch("http://jobs.example.com/start", { dispatcher: agent })).toEqual({
      ok: true,
      html: PAGE,
      url: "http://jobs.example.com/page",
    });
    expect(requests).toEqual(["jobs.example.com/start", "jobs.example.com/page"]);
  });

  it("refuses a redirect to a name that resolves to a private address", async () => {
    expect(await safeFetch("http://jobs.example.com/to-internal", { dispatcher: agent })).toEqual({
      ok: false,
      reason: "blocked-address",
      host: "internal.example.com",
    });
    expect(requests).toEqual(["jobs.example.com/to-internal"]);
  });

  it("refuses a redirect to a private IP literal", async () => {
    expect(await safeFetch("http://jobs.example.com/to-literal", { dispatcher: agent })).toEqual({
      ok: false,
      reason: "blocked-address",
      host: "192.168.1.1",
    });
  });

  it("refuses a name with one private answer among allowed ones", async () => {
    const outcome = await safeFetch("http://mixed.example.com/page", { dispatcher: agent });
    expect(outcome.ok === false && outcome.reason).toBe("blocked-address");
    expect(requests).toEqual([]);
  });

  it("stops a compressed body that inflates past 2 MB", async () => {
    const outcome = await safeFetch("http://jobs.example.com/bomb", { dispatcher: agent });
    expect(outcome.ok === false && outcome.reason).toBe("too-large");
  });

  it("times out a body that stalls after the headers", async () => {
    const outcome = await safeFetch("http://jobs.example.com/stall", { dispatcher: agent, timeoutMs: 200 });
    expect(outcome).toEqual({ ok: false, reason: "timeout", host: "jobs.example.com" });
  });

  it.each(["/endless", "/endless-gzip"])(
    "stops an endless body (%s) at 2 MB while reading, long before the deadline",
    async (at) => {
      // Buffering first and checking after would never finish: the outcome would be "timeout".
      const outcome = await safeFetch(`http://jobs.example.com${at}`, { dispatcher: agent, timeoutMs: 3_000 });
      expect(outcome).toEqual({ ok: false, reason: "too-large", host: "jobs.example.com" });
    },
  );

  it("sends no cookies, not even one the site set a redirect earlier", async () => {
    cookies.length = 0;
    const first = await safeFetch("http://jobs.example.com/set-cookie", { dispatcher: agent });
    const second = await safeFetch("http://jobs.example.com/echo-cookie", { dispatcher: agent });
    expect(first.ok && second.ok).toBe(true);
    expect(cookies).toEqual([undefined, undefined]);
  });
});

describe("the default dispatcher", () => {
  afterEach(() => setDispatcherForTests(undefined));

  it("never reaches the network under Vitest: a fetch without a dispatcher is offline", async () => {
    expect(await safeFetch("https://jobs.example.com/")).toEqual({
      ok: false,
      reason: "offline",
      host: "jobs.example.com",
    });
    // The link is still checked first.
    expect(await safeFetch("http://127.0.0.1/")).toEqual({
      ok: false,
      reason: "blocked-address",
      host: "127.0.0.1",
    });
  });

  it("is the one a test sets", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.get("https://jobs.example.com").intercept({ path: "/" }).reply(200, PAGE, { headers: HTML });
    setDispatcherForTests(mock);
    expect(await safeFetch("https://jobs.example.com/")).toMatchObject({ ok: true, html: PAGE });
    await mock.close();
  });
});

describe("the parser's sources", () => {
  const dir = path.resolve(__dirname, "../../../src/lib/server/parse");
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), "utf8") }));

  it("never use undici's global dispatcher, a proxy agent or the global fetch", () => {
    expect(sources.map((s) => s.name)).toContain("safe-fetch.ts");
    for (const { name, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // comments may name them
      expect(code, name).not.toMatch(/GlobalDispatcher|ProxyAgent|globalThis\.fetch|_PROXY|_proxy/);
      if (/\bfetch\(/.test(code)) {
        expect(code, name).toMatch(/import \{[^}]*\bfetch\b[^}]*\} from "undici"/);
        // Every call names its dispatcher.
        for (const call of code.matchAll(/\bfetch\(([\s\S]*?)\);/g)) expect(call[1], name).toContain("dispatcher");
      }
    }
  });
});
