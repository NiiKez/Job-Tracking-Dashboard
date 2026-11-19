import { readFileSync } from "node:fs";
import path from "node:path";
import { MockAgent } from "undici";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET as inboxCallback } from "@/app/api/inbox/callback/route";
import { GET as inboxConnect } from "@/app/api/inbox/connect/route";
import { GET as getMe } from "@/app/api/me/route";
import { POST as parse } from "@/app/api/parse/route";
import { workspaceExpiresAt } from "@/lib/server/demo/workspaces";
import { setDispatcherForTests } from "@/lib/server/parse/safe-fetch";
import { parseWithHeuristics } from "@/lib/server/parse/text";
import type { Me, ParseResult } from "@/lib/types";
import { describeDb, testSql } from "../helpers/test-db";
import { APP_ORIGIN, demoEnv, restoreEnv, signedInEnv } from "../unit/auth/env";
import { ctx, demoSignedIn, OWNER, request, setCookies, signedIn } from "./helpers";

// The API routes that answer differently in the public demo (docs/plan/5-public-demo.md, step 5),
// each in both modes: the real app's answer must stay as it was. Who passes the guard in each
// mode is in guard.test.ts; sign-in and sign-out in auth-routes.test.ts; the extension's routes
// in extension-routes.test.ts. The inbox's connect flow needs no branch of its own (the demo's
// MAIL_SOURCE is fixture: inbox-connect.test.ts); here it is checked once with a demo user.
// Invented values only.

// connection() needs a request scope; called directly, handlers only need it to resolve.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

// The real lookup, which one test makes miss once (a workspace deleted during the request).
vi.mock("@/lib/server/demo/workspaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/demo/workspaces")>();
  return { ...actual, workspaceExpiresAt: vi.fn(actual.workspaceExpiresAt) };
});

const POSTING = "https://careers.example.com/jobs/backend-engineer-4711";
const HTML = { "content-type": "text/html; charset=utf-8" };
/** A posting with JSON-LD: company "Quillfeather Systems GmbH", title "Senior Backend Engineer". */
const PAGE = readFileSync(path.resolve(__dirname, "../fixtures/pages/jsonld-top-level.html"), "utf8");

let mock: MockAgent;

async function ok<T>(res: Response): Promise<T> {
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return body as T;
}

const parseLink = (cookie: string) =>
  parse(request("/api/parse", { method: "POST", cookie, body: JSON.stringify({ input: POSTING }) }), ctx());

describeDb("the routes' demo branches", () => {
  beforeEach(() => {
    mock = new MockAgent();
    mock.disableNetConnect();
    setDispatcherForTests(mock);
    mock
      .get("https://careers.example.com")
      .intercept({ path: "/jobs/backend-engineer-4711" })
      .reply(200, PAGE, { headers: HTML })
      .persist();
  });
  afterEach(async () => {
    restoreEnv();
    vi.restoreAllMocks();
    setDispatcherForTests(undefined);
    await mock.close();
  });

  it("GET /api/me outside the demo: exactly { email, name, pictureUrl }, no demo key", async () => {
    signedInEnv();
    const { cookie } = await signedIn();
    vi.mocked(workspaceExpiresAt).mockClear();
    const res = await getMe(request("/api/me", { cookie }), ctx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      JSON.stringify({ email: OWNER.email, name: OWNER.name, pictureUrl: OWNER.picture }),
    );
    // No query of the demo's: the real app's request is as before.
    expect(workspaceExpiresAt).not.toHaveBeenCalled();
  });

  it("GET /api/me in the demo: the workspace's end, 24 hours after its user was made", async () => {
    demoEnv();
    const { cookie, user } = await demoSignedIn();
    const [{ created }] = await testSql()<{ created: Date }[]>`SELECT created_at AS created FROM users WHERE id = ${user.id}`;
    const me = await ok<Me>(await getMe(request("/api/me", { cookie }), ctx()));
    expect(me).toEqual({
      email: user.email,
      name: "Alex Demo",
      pictureUrl: null,
      demo: { expiresAt: new Date(created.getTime() + 24 * 60 * 60 * 1000).toISOString() },
    });
    // Moving the user's created_at moves the end: it is the workspace's, not the session's.
    await testSql()`UPDATE users SET created_at = created_at - interval '1 hour' WHERE id = ${user.id}`;
    const later = await ok<Me>(await getMe(request("/api/me", { cookie }), ctx()));
    expect(Date.parse(later.demo!.expiresAt)).toBe(created.getTime() + 23 * 60 * 60 * 1000);
  });

  it("GET /api/me in the demo: a workspace deleted since the session was checked is signed out", async () => {
    demoEnv();
    const { cookie } = await demoSignedIn();
    vi.mocked(workspaceExpiresAt).mockResolvedValueOnce(null);
    const res = await getMe(request("/api/me", { cookie }), ctx());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in" });
    expect(setCookies(res)).toEqual([expect.stringMatching(/^__Host-jt_session=; Path=\/; Max-Age=0; /)]);
  });

  it("POST /api/parse opens a link outside the demo", async () => {
    signedInEnv();
    const { cookie } = await signedIn();
    const dispatch = vi.spyOn(mock, "dispatch");
    const res = await ok<ParseResult>(await parseLink(cookie));
    expect(dispatch).toHaveBeenCalled();
    expect(res).toMatchObject({ company: "Quillfeather Systems GmbH", title: "Senior Backend Engineer" });
  });

  it("POST /api/parse in the demo never opens the link: the fields come from its own text", async () => {
    demoEnv();
    const { cookie } = await demoSignedIn();
    const dispatch = vi.spyOn(mock, "dispatch");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await ok<ParseResult>(await parseLink(cookie));
    expect(dispatch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(res).toEqual({ ...parseWithHeuristics(POSTING), duplicateOf: null });
    expect(res.url).toBe(POSTING);
  });

  it("the inbox's Connect in the demo makes the demo connection without Google; the callback refuses", async () => {
    demoEnv();
    const { cookie, user } = await demoSignedIn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await inboxConnect(request("/api/inbox/connect", { cookie, headers: { "sec-fetch-site": "same-origin" } }));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/settings?inbox=connected`);
      expect(setCookies(res)).toEqual([]);
      const [row] = await testSql()<{ status: string; demo: boolean }[]>`
        SELECT status, demo FROM inbox_connections WHERE user_id = ${user.id}`;
      expect(row).toEqual({ status: "connected", demo: true });

      const back = await inboxCallback(request("/api/inbox/callback?code=c&state=s", { cookie }));
      expect(back.headers.get("location")).toBe(`${APP_ORIGIN}/settings?inbox=error&reason=state`);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
