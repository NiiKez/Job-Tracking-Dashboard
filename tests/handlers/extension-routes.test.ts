import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET as getOverview } from "@/app/api/extension/route";
import { GET as download } from "@/app/api/extension/download/route";
import { POST as saveJob } from "@/app/api/extension/jobs/route";
import { DELETE as revokeKey } from "@/app/api/extension/keys/[id]/route";
import { POST as createKey } from "@/app/api/extension/keys/route";
import { POST as readPage } from "@/app/api/extension/read/route";
import { DELETE as disconnect, GET as getSession } from "@/app/api/extension/session/route";
import { POST as createJob } from "@/app/api/jobs/route";
import { setDispatcherForTests } from "@/lib/server/parse/safe-fetch";
import type {
  ExtensionKeyCreated,
  ExtensionOverview,
  ExtensionSession,
  ParseResult,
  UpsertResult,
} from "@/lib/types";
import { describeDb, testSql } from "../helpers/test-db";
import { restoreEnv, signedInEnv } from "../unit/auth/env";
import { ctx, OWNER, request, signedIn } from "./helpers";

// Every /api/extension route on the real database, called directly: the cookie routes with a
// real session, the key routes with a key made through POST /api/extension/keys. The key guard
// itself (missing, malformed, revoked keys, Origin, JSON) is in guard.test.ts.

// connection() needs a request scope; called directly, handlers only need it to resolve.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

// The built extension is read from a dist directory of the test's own, never extension/dist
// (another build may or may not be there).
const build = vi.hoisted(() => ({ dir: "" }));
vi.mock("@/lib/server/extension/build-info", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/extension/build-info")>();
  return {
    ...actual,
    readExtensionBuild: () => actual.readExtensionBuild(build.dir),
    openExtensionZip: () => actual.openExtensionZip(build.dir),
  };
});

const ZIP = Buffer.from("PK\u0003\u0004 an invented extension zip");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** An empty dist directory: no build. `built(version)` adds one. */
function noBuild(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "extension-routes-"));
  dirs.push(dir);
  return dir;
}

function built(version: string): string {
  const dir = noBuild();
  mkdirSync(path.join(dir, "chrome"));
  writeFileSync(path.join(dir, "chrome", "manifest.json"), JSON.stringify({ manifest_version: 3, version }));
  writeFileSync(path.join(dir, "job-tracker-extension.zip"), ZIP);
  return dir;
}

/** A second account. */
const OTHER = { sub: "110000000000000000002", email: "other@example.com", name: "Otto Other", picture: null };

/** Signs OTHER in, with both accounts on the allowlist. */
async function otherSignedIn() {
  signedInEnv({ ALLOWED_EMAILS: `${OWNER.email},${OTHER.email}` });
  return signedIn(OTHER);
}

async function ok<T>(res: Response, status = 200): Promise<T> {
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return body as T;
}

async function fails(res: Response, status: number, error?: string | RegExp) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: string };
  if (error) expect(body.error).toMatch(error);
  return body;
}

describeDb("the extension's API on the database", () => {
  let cookie: string;

  beforeEach(async () => {
    signedInEnv();
    build.dir = noBuild();
    cookie = (await signedIn()).cookie;
  });
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  /* ---------------------------------------------------- cookie routes */

  const send = (method: string, p: string, body?: unknown, as = cookie) =>
    request(p, { method, cookie: as, body: body === undefined ? undefined : JSON.stringify(body) });

  const connect = async (label = "Chrome on Linux", as = cookie) =>
    ok<ExtensionKeyCreated>(await createKey(send("POST", "/api/extension/keys", { label }, as), ctx()), 201);

  /** A request from the extension with its key: no Origin and no cookie. */
  const withKey = (token: string, method = "GET", p = "/api/extension/session", body?: unknown) =>
    request(p, {
      method,
      origin: null,
      headers: { authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("POST /api/extension/keys: 201 with the token once, the label trimmed", async () => {
    const created = await connect("  Chrome on Linux ");
    expect(created).toEqual({
      key: { id: expect.any(String), label: "Chrome on Linux", createdAt: expect.any(String), lastUsedAt: null },
      token: expect.stringMatching(/^jtx_[A-Za-z0-9_-]{43}$/),
    });
  });

  it("POST /api/extension/keys: 400 for a blank or long label, 409 at 20 keys", async () => {
    for (const body of [{}, { label: "" }, { label: "   " }, { label: "x".repeat(81) }, { label: 7 }]) {
      await fails(await createKey(send("POST", "/api/extension/keys", body), ctx()), 400);
    }
    await connect("x".repeat(80));
    for (let i = 1; i < 20; i++) await connect(`Browser ${i}`);
    await fails(await createKey(send("POST", "/api/extension/keys", { label: "One more" }), ctx()), 409, /20 browsers/);
  });

  it("GET /api/extension: no version without a build, the keys newest first", async () => {
    expect(await ok<ExtensionOverview>(await getOverview(request("/api/extension", { cookie }), ctx()))).toEqual({
      version: null,
      keys: [],
    });
    const first = await connect("Chrome on Linux");
    const second = await connect("Chrome on macOS");
    // Another account's keys stay out.
    const other = await otherSignedIn();
    await connect("Edge on Windows", other.cookie);

    build.dir = built("1.2.0");
    const overview = await ok<ExtensionOverview>(await getOverview(request("/api/extension", { cookie }), ctx()));
    expect(overview.version).toBe("1.2.0");
    expect(overview.keys).toEqual([second.key, first.key]);
  });

  it("DELETE /api/extension/keys/:id revokes the key; another's, unknown or malformed ids are 404", async () => {
    const mine = await connect();
    const other = await otherSignedIn();
    const theirs = await connect("Chrome on Linux", other.cookie);

    for (const id of [theirs.key.id, "0190f5a2-0000-7000-8000-000000000000", "not-a-uuid"]) {
      await fails(await revokeKey(send("DELETE", `/api/extension/keys/${id}`), ctx({ id })), 404, "Key not found");
    }
    expect(await ok(await revokeKey(send("DELETE", `/api/extension/keys/${mine.key.id}`), ctx({ id: mine.key.id })))).toEqual({
      ok: true,
    });
    // The extension is disconnected at its next request.
    expect((await getSession(withKey(mine.token), ctx())).status).toBe(401);
    expect((await getSession(withKey(theirs.token), ctx())).status).toBe(200);
  });

  it("GET /api/extension/download: 404 without a build, else the zip as an attachment", async () => {
    await fails(await download(request("/api/extension/download", { cookie }), ctx()), 404, "The extension isn't built on this server");

    build.dir = built("1.3.1");
    const res = await download(request("/api/extension/download", { cookie }), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="job-tracker-extension-1.3.1.zip"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(ZIP);
  });

  // Next.js answers HEAD with GET's handler and drops the body unread: nothing may stay open.
  it.skipIf(!existsSync("/proc/self/fd"))("HEAD /api/extension/download leaves no file open", async () => {
    build.dir = built("1.3.1");
    const zipPath = path.join(build.dir, "job-tracker-extension.zip");
    for (let i = 0; i < 3; i++) {
      const res = await download(request("/api/extension/download", { method: "HEAD", cookie }), ctx());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/zip");
    }
    const open = readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`) === zipPath;
      } catch {
        return false; // closed meanwhile, e.g. the directory handle readdirSync used
      }
    });
    expect(open).toEqual([]);
  });

  it("the cookie routes refuse the extension's key", async () => {
    const { token, key } = await connect();
    build.dir = built("1.3.1");
    const keyOnly = (method: string, p: string, body?: unknown) =>
      request(p, { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    await fails(await getOverview(keyOnly("GET", "/api/extension"), ctx()), 401);
    await fails(await download(keyOnly("GET", "/api/extension/download"), ctx()), 401);
    await fails(await createKey(keyOnly("POST", "/api/extension/keys", { label: "Sneaky" }), ctx()), 401);
    await fails(await revokeKey(keyOnly("DELETE", `/api/extension/keys/${key.id}`), ctx({ id: key.id })), 401);
    const [{ n }] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM extension_keys`;
    expect(n).toBe(1);
  });

  /* ------------------------------------------------------- key routes */

  it("GET /api/extension/session: whose tracker it is, and the latest version", async () => {
    const { token } = await connect();
    expect(await ok<ExtensionSession>(await getSession(withKey(token), ctx()))).toEqual({
      email: OWNER.email,
      name: OWNER.name,
      latestVersion: null,
    });
    build.dir = built("2.0.0");
    expect((await ok<ExtensionSession>(await getSession(withKey(token), ctx()))).latestVersion).toBe("2.0.0");

    // Settings shows when it was last used.
    const overview = await ok<ExtensionOverview>(await getOverview(request("/api/extension", { cookie }), ctx()));
    expect(overview.keys[0].lastUsedAt).not.toBeNull();
  });

  it("DELETE /api/extension/session deletes the key the request used, and only that one", async () => {
    const used = await connect("Chrome on Linux");
    const kept = await connect("Chrome on macOS");
    expect(await ok(await disconnect(withKey(used.token, "DELETE"), ctx()))).toEqual({ ok: true });
    expect((await getSession(withKey(used.token), ctx())).status).toBe(401);
    expect((await getSession(withKey(kept.token), ctx())).status).toBe(200);
    const overview = await ok<ExtensionOverview>(await getOverview(request("/api/extension", { cookie }), ctx()));
    expect(overview.keys.map((k) => k.id)).toEqual([kept.key.id]);
  });

  it("POST /api/extension/read: the fields from the snapshot and the duplicate, without fetching anything", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setDispatcherForTests(mock);
    const dispatch = vi.spyOn(mock, "dispatch");
    try {
      const { token } = await connect();
      const page = {
        url: "https://careers.example.com/jobs/4711?utm_source=invented",
        canonicalUrl: "https://careers.example.com/jobs/4711",
        title: "Backend Engineer | Quillfeather Careers",
        meta: { "og:site_name": "Quillfeather Careers" },
        jsonLd: [],
        site: { reader: "generic", fields: { description: "We build route planning for bike couriers." } },
        selection: "",
      };
      const fresh = await ok<ParseResult>(await readPage(withKey(token, "POST", "/api/extension/read", { page }), ctx()));
      expect(fresh).toEqual({
        title: "Backend Engineer",
        company: "Quillfeather",
        location: "",
        url: "https://careers.example.com/jobs/4711",
        description: "We build route planning for bike couriers.",
        missing: ["location"],
        duplicateOf: null,
      });

      // Saved once (from the dashboard, with the link it had there): the next read finds it.
      const saved = await ok<UpsertResult>(
        await createJob(
          send("POST", "/api/jobs", { title: "Backend Engineer", company: "Quillfeather", url: "https://careers.example.com/jobs/4711/", status: "applied" }),
          ctx(),
        ),
      );
      const again = await ok<ParseResult>(await readPage(withKey(token, "POST", "/api/extension/read", { page }), ctx()));
      expect(again.duplicateOf).toMatchObject({ id: saved.job.id, status: "applied" });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      setDispatcherForTests(undefined);
      await mock.close();
    }
  });

  it("POST /api/extension/read: 400 for a snapshot over the limits or without an http(s) address", async () => {
    const { token } = await connect();
    const read = (body: unknown) => readPage(withKey(token, "POST", "/api/extension/read", body), ctx());
    await fails(await read({}), 400);
    await fails(await read({ page: { url: "chrome://extensions" } }), 400);
    await fails(await read({ page: { url: "https://example.com/jobs/1", title: "t".repeat(1_001) } }), 400);
    await fails(await read({ page: { url: "https://example.com/jobs/1", jsonLd: Array(21).fill("{}") } }), 400);
    // Only the address is needed.
    expect((await read({ page: { url: "https://example.com/jobs/1" } })).status).toBe(200);
  });

  it("POST /api/extension/jobs: the add-job upsert, always captured by the extension", async () => {
    const { token } = await connect();
    const input = {
      title: "Platform Engineer",
      company: "Kettle & Co",
      location: "Berlin",
      url: "https://kettle.example.com/jobs/7",
      description: "Run the platform.",
      status: "saved",
      // Ignored: the extension cannot claim another capture method.
      captureMethod: "paste",
    };
    const created = await ok<UpsertResult>(await saveJob(withKey(token, "POST", "/api/extension/jobs", input), ctx()));
    expect(created).toMatchObject({
      duplicate: false,
      job: { title: "Platform Engineer", status: "saved", captureMethod: "extension", statusSource: "extension" },
    });
    expect(created.job.history.map((e) => [e.to, e.source])).toEqual([["saved", "extension"]]);

    const applied = await ok<UpsertResult>(
      await saveJob(withKey(token, "POST", "/api/extension/jobs", { ...input, status: "applied" }), ctx()),
    );
    expect(applied).toMatchObject({ duplicate: true, job: { id: created.job.id, status: "applied" } });

    for (const body of [{}, { ...input, title: "" }, { ...input, url: "javascript:alert(1)" }, { ...input, status: "offer" }]) {
      await fails(await saveJob(withKey(token, "POST", "/api/extension/jobs", body), ctx()), 400);
    }
  });
});
