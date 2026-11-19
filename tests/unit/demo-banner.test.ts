// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { DemoBanner, deletionTime } from "@/components/app-shell/demo-banner";
import { qk } from "@/lib/api/hooks";
import type { Me } from "@/lib/types";

// src/components/app-shell/demo-banner.tsx: when the public demo's workspace is deleted, as the
// banner says it inside a sentence. The banner shows the browser's local time, so the dates here
// are built in local time too (new Date(y, m, d, h, min)) and the test holds in any time zone.
// Then the banner itself in happy-dom: its clock, and the reload of a page the browser brings
// back from its history (src/hooks/use-demo.ts, useReloadFromHistoryInDemo).

const NOW = new Date(2026, 10, 18, 22, 15);
const iso = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();

describe("the demo banner's deletion time", () => {
  it("says today or tomorrow, with the time", () => {
    expect(deletionTime(iso(2026, 10, 18, 23, 59), NOW)).toBe("today at 23:59");
    expect(deletionTime(iso(2026, 10, 19, 22, 15), NOW)).toBe("tomorrow at 22:15");
    expect(deletionTime(iso(2026, 10, 19, 0, 5), NOW)).toBe("tomorrow at 00:05");
  });

  it("names the day and date further out, with the year only when it isn't this year", () => {
    expect(deletionTime(iso(2026, 10, 20, 9, 0), NOW)).toBe("Fri 20 Nov at 09:00");
    expect(deletionTime(iso(2027, 0, 2, 9, 0), new Date(2026, 11, 31, 12, 0))).toBe("Sat 2 Jan 2027 at 09:00");
  });

  it("says today for a time that has just passed (a slow clock): the next request signs out", () => {
    expect(deletionTime(iso(2026, 10, 18, 22, 0), NOW)).toBe("today at 22:00");
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEMO_ME: Me = {
  email: "visitor@demo.invalid",
  name: "Alex Demo",
  pictureUrl: null,
  demo: { expiresAt: iso(2026, 10, 19, 9, 5) },
};
const REAL_ME: Me = { email: "owner@example.com", name: "Owner", pictureUrl: null };

describe("the demo banner", () => {
  let host: HTMLElement;
  let root: Root;
  let reload: Mock<() => void>;

  beforeEach(() => {
    // Two minutes before midnight. Only the clock's interval and Date are fake.
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 23, 58), toFake: ["setInterval", "clearInterval", "Date"] });
    reload = vi.fn<() => void>();
    vi.spyOn(window.location, "reload").mockImplementation(reload);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The banner, with /api/me already answered (as the account menu's query leaves it). */
  function render(me: Me) {
    // gcTime Infinity: no garbage-collection timer of the query's own.
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
    client.setQueryData(qk.me, me);
    act(() => root.render(createElement(QueryClientProvider, { client }, createElement(DemoBanner))));
  }

  /** A pageshow event as the browser fires it; persisted when the page comes from the bfcache. */
  function pageshow(persisted: boolean) {
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));
    });
  }

  it("says when the workspace is deleted at the latest, and that it can be sooner", () => {
    render(DEMO_ME);
    expect(host.querySelector("aside")?.textContent).toBe(
      "Demo with invented data, private to this browser and deleted no later than tomorrow at 09:05 (sooner if the demo gets very busy). Don't enter real personal data.",
    );
  });

  it("works the time out again every minute: after midnight, tomorrow is today", () => {
    render(DEMO_ME);
    const time = () => host.querySelector("time")?.textContent;
    expect(time()).toBe("tomorrow at 09:05");
    act(() => vi.advanceTimersByTime(60_000));
    expect(time()).toBe("tomorrow at 09:05");
    act(() => vi.advanceTimersByTime(60_000));
    expect(time()).toBe("today at 09:05");
  });

  it("stops its clock when it goes away", () => {
    render(DEMO_ME);
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("in the demo, loads a page the browser brings back from its history again", () => {
    render(DEMO_ME);
    pageshow(false);
    expect(reload).not.toHaveBeenCalled();
    pageshow(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("is nothing in the real app: no banner, no clock, no reload", () => {
    render(REAL_ME);
    expect(host.innerHTML).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    pageshow(true);
    expect(reload).not.toHaveBeenCalled();
  });
});
