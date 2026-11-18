// The e2e test API. Spec files import { test, expect } from here, not from @playwright/test.
//
//   test("…", async ({ page }) => …)            signed out: no session cookie
//   test("…", async ({ page, account }) => …)   signed in: asking for `account` makes this
//                                               worker's account afresh (no jobs, no mail, the
//                                               default settings and keyword rules) and puts its
//                                               session cookie into the browser context
//   test("…", async ({ page, api }) => …)       signed in too, plus `api`: the app's JSON API as
//                                               that account, for arranging data quickly
//
// Each worker has an account of its own (testInfo.parallelIndex), and every test that asks for
// one starts from an empty account, so tests never see each other's data and run in parallel.
import { test as base, expect, type APIRequestContext, type APIResponse, type Locator, type Page } from "@playwright/test";
import type { Job, JobInput } from "@/lib/types";
import { closeDb, resetAccount, type Account } from "./db";
import { accountEmail, BASE_URL, MAX_ACCOUNTS, SESSION_COOKIE } from "./settings";

export interface Api {
  /** The raw request context: signed in, with the app's Origin on every request. */
  request: APIRequestContext;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
  /** POST /api/jobs with a pasted job (Saved, unless `status` says otherwise). */
  createJob(input?: Partial<JobInput>): Promise<Job>;
}

async function parse<T>(res: APIResponse, what: string): Promise<T> {
  if (!res.ok()) throw new Error(`${what} answered ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}

export const test = base.extend<{ account: Account; api: Api }, { workerDb: void }>({
  workerDb: [
    async ({}, provide) => {
      await provide();
      await closeDb();
    },
    { scope: "worker", auto: true },
  ],

  account: async ({ context }, provide, testInfo) => {
    if (testInfo.parallelIndex >= MAX_ACCOUNTS) {
      throw new Error(`More than ${MAX_ACCOUNTS} workers: raise MAX_ACCOUNTS in tests/e2e/support/settings.ts`);
    }
    const account = await resetAccount(accountEmail(testInfo.parallelIndex));
    await context.addCookies([
      { name: SESSION_COOKIE, value: account.token, url: BASE_URL, httpOnly: true, sameSite: "Lax" },
    ]);
    await provide(account);
  },

  api: async ({ playwright, account }, provide) => {
    const request = await playwright.request.newContext({
      baseURL: BASE_URL,
      // Changing requests must come from the app's own origin and say application/json, even
      // without a body (src/lib/server/auth/guard.ts).
      extraHTTPHeaders: {
        Origin: BASE_URL,
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=${account.token}`,
      },
    });
    const api: Api = {
      request,
      get: async (path) => parse(await request.get(path), `GET ${path}`),
      post: async (path, body) => parse(await request.post(path, { data: body ?? {} }), `POST ${path}`),
      patch: async (path, body) => parse(await request.patch(path, { data: body }), `PATCH ${path}`),
      delete: async (path) => parse(await request.delete(path), `DELETE ${path}`),
      createJob: async (input = {}) => {
        const body: JobInput = {
          title: "Frontend Engineer",
          company: "Parcelwerk",
          location: "",
          url: null,
          description: "",
          status: "saved",
          captureMethod: "paste",
          ...input,
        };
        const { job } = await parse<{ job: Job }>(await request.post("/api/jobs", { data: body }), "POST /api/jobs");
        return job;
      },
    };
    await provide(api);
    await request.dispose();
  },
});

/** Sonner's toasts (bottom right). Texts like "Saved" also appear on pages, so look in here. */
export function toasts(page: Page): Locator {
  return page.getByRole("region", { name: /^Notifications/ });
}

export { expect };
export type { Account };
