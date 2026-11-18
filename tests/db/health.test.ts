import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";
import { createSql, setDbForTests } from "@/lib/server/db/client";
import { resetEnvForTests } from "@/lib/server/env";
import { describeDb } from "../helpers/test-db";

// connection() needs a live request scope; called directly, the handler only needs it to resolve.
// (vi.mock is hoisted above the imports.)
vi.mock("next/server", () => ({ connection: async () => {} }));

async function expectHealth(status: number) {
  const res = await GET();
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ ok: status === 200 });
}

describeDb("GET /api/health", () => {
  it("answers 200 when the database answers", async () => {
    await expectHealth(200);
  });
});

describe("GET /api/health without a working database", () => {
  afterEach(() => {
    setDbForTests(undefined);
    resetEnvForTests();
    vi.restoreAllMocks();
  });

  /** Runs the check and returns what it logged, which must never hold a connection string. */
  async function expect503(): Promise<string> {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expectHealth(503);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toMatch(/^health: database check failed: /);
    expect(line).not.toMatch(/postgres(ql)?:\/\//);
    return line;
  }

  it("answers 503 when DATABASE_URL is missing", async () => {
    // vitest.config.ts blanks DATABASE_URL; nothing is routed to a test client here.
    resetEnvForTests();
    expect(await expect503()).toContain("DATABASE_URL is not set");
  });

  it("answers 503 when the database refuses the connection", async () => {
    const sql = createSql("postgres://nobody:not-a-secret@127.0.0.1:1/none", { max: 1 });
    setDbForTests(sql);
    try {
      expect(await expect503()).not.toContain("not-a-secret");
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it("answers 503 within its timeout when the database hangs", async () => {
    // Accepts connections and never answers.
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => void sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const sql = createSql(`postgres://nobody@127.0.0.1:${port}/none`, { max: 1 });
    setDbForTests(sql);
    try {
      const started = Date.now();
      expect(await expect503()).toContain("no answer within");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await sql.end({ timeout: 0 });
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 10_000);
});
