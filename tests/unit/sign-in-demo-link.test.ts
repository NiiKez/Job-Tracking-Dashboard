import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_OPTIONS_KEY,
  AUTH_OPTIONS_PATH,
  DemoLink,
  demoUrlFrom,
  fetchDemoUrl,
  SignInActions,
} from "@/components/auth/sign-in";

// src/components/auth/sign-in.tsx: "Just looking? Try the demo" under the Google button when
// /auth/options names the demo (docs/plan/5-public-demo.md, "Step 8"). A plain link, and nothing
// at all while loading, without one, or when the request fails. Invented hosts only.

const DEMO_ORIGIN = "https://demo.example.com";

/** The sign-in actions as the page first renders them, with the query cache in a given state. */
function renderActions(demoUrl?: string | null) {
  const client = new QueryClient();
  if (demoUrl !== undefined) client.setQueryData(AUTH_OPTIONS_KEY, demoUrl);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(SignInActions)));
}

describe("the demo link on the sign-in page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a plain link to the demo, in the same tab, under the Google button", () => {
    const html = renderActions(DEMO_ORIGIN);
    expect(html).toContain(`<a href="${DEMO_ORIGIN}"`);
    expect(html.indexOf("Continue with Google")).toBeLessThan(html.indexOf("Try the demo"));
    expect(html.replace(/<[^>]+>/g, "")).toContain("Just looking? Try the demo");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("target=");
  });

  it("is not there while loading or without a demo: the page looks as before", () => {
    const before = renderActions();
    expect(before).not.toContain("demo");
    expect(renderActions(null)).toBe(before);
    expect(renderToStaticMarkup(createElement(DemoLink, { href: null }))).toBe("");
  });

  it("takes only an http or https address from the answer", () => {
    expect(demoUrlFrom({ demoUrl: DEMO_ORIGIN })).toBe(DEMO_ORIGIN);
    expect(demoUrlFrom({ demoUrl: `${DEMO_ORIGIN}/` })).toBe(DEMO_ORIGIN);
    expect(demoUrlFrom({ demoUrl: "http://127.0.0.1:3901" })).toBe("http://127.0.0.1:3901");
    for (const data of [
      { demoUrl: null },
      { demoUrl: "" },
      { demoUrl: "javascript:alert(1)" },
      { demoUrl: "data:text/html,x" },
      { demoUrl: "/relative" },
      { demoUrl: 42 },
      {},
      null,
      "https://demo.example.com",
    ]) {
      expect(demoUrlFrom(data), JSON.stringify(data)).toBeNull();
    }
  });

  it("asks /auth/options without the cache and gives null for any failure", async () => {
    const calls: Array<{ url: unknown; init?: RequestInit }> = [];
    const answer = vi.fn(async () => Response.json({ demoUrl: DEMO_ORIGIN }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url, init });
        return answer();
      }),
    );
    expect(await fetchDemoUrl()).toBe(DEMO_ORIGIN);
    expect(calls).toEqual([{ url: AUTH_OPTIONS_PATH, init: { cache: "no-store" } }]);
    expect(AUTH_OPTIONS_PATH).toBe("/auth/options");

    answer.mockImplementation(async () => Response.json({ demoUrl: null }));
    expect(await fetchDemoUrl()).toBeNull();
    answer.mockImplementation(async () => Response.json({ demoUrl: DEMO_ORIGIN }, { status: 500 }));
    expect(await fetchDemoUrl()).toBeNull();
    answer.mockImplementation(async () => new Response("<!doctype html>", { status: 200 }));
    expect(await fetchDemoUrl()).toBeNull();
    answer.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchDemoUrl()).toBeNull();
  });
});
