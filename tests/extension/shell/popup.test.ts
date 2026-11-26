// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, PageSnapshot, ParseResult, UpsertResult } from "@/lib/types";
import { ApiError, type Api } from "../../../extension/src/lib/api";
import type { TargetTab } from "../../../extension/src/lib/tab";
import { DoneScreen } from "../../../extension/src/popup/done-screen";
import { JobEditor } from "../../../extension/src/popup/job-editor";
import { emptyRead, type ReadOutcome } from "../../../extension/src/popup/read-job";
import { AnnounceContext } from "../../../extension/src/popup/ui";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";

// The popup's screens rendered in happy-dom: what the form keeps when the page is read again,
// the way back when the tracker's site access was withdrawn, and where focus and announcements go.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = "https://tracker.example.com";
const PAGE = "https://careers.example.com/jobs/1";
const tab = { id: 7, url: PAGE } as TargetTab;

const snapshot: PageSnapshot = {
  url: PAGE,
  canonicalUrl: null,
  title: "",
  meta: {},
  jsonLd: [],
  site: null,
  selection: "",
};

const parsed: ParseResult = {
  title: "Engineer",
  company: "From the tracker",
  location: "Berlin",
  url: PAGE,
  description: "",
  missing: [],
  duplicateOf: null,
};

const job = { id: "job-1", title: "Engineer", company: "Acme" } as Job;

const unreachable = () => new ApiError("retryable", "Couldn't reach tracker.example.com.", null);
const noAccess = () =>
  new ApiError("no-access", "Job Tracker no longer has access to tracker.example.com. Allow access to reach it again.", null);

let chromeApi: FakeChrome;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  chromeApi = installFakeChrome();
  // Both executeScript calls of readTab: the file, then the function that returns the snapshot.
  chromeApi.scripting.executeScript.mockResolvedValue([{ result: snapshot }]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  return {
    session: vi.fn(),
    revoke: vi.fn(),
    read: vi.fn(),
    saveJob: vi.fn(),
    requestAccess: vi.fn(async () => true),
    ...overrides,
  } as unknown as Api & { [K in keyof Api]: ReturnType<typeof vi.fn> };
}

function render(element: ReactElement) {
  act(() => root.render(element));
}

function editor(api: Api, read: ReadOutcome, more: { onSaved?: () => void } = {}) {
  return createElement(JobEditor, { api, tab, read, onSaved: more.onSaved ?? vi.fn(), onDisconnected: vi.fn() });
}

/** Types into a field as a user does: React sees the input event. */
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const field = (label: string) =>
  [...host.querySelectorAll("label")].find((l) => l.textContent?.startsWith(label))!.control as HTMLInputElement;
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(name));
const alerts = () => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent);

/** Lets promises (fake storage, fake requests) settle and React render what they set. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
const nextFrame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));

describe("Try again on a failed read", () => {
  it("keeps what the user typed while the page was read again, and fills only untouched fields", async () => {
    let answer!: (result: ParseResult) => void;
    const api = fakeApi({ read: vi.fn(() => new Promise<ParseResult>((resolve) => (answer = resolve))) });
    render(editor(api, emptyRead(tab, { kind: "failed", error: unreachable() })));

    await act(async () => button("Try again")!.click());
    await settle();
    expect(api.read).toHaveBeenCalledTimes(1);
    // The form stays usable while the tracker answers ("You can still fill in the job").
    act(() => type(field("Company"), "Typed GmbH"));

    await act(async () => answer(parsed));
    await settle();
    expect(field("Company").value).toBe("Typed GmbH");
    expect(field("Title").value).toBe("Engineer");
    expect(field("Location").value).toBe("Berlin");
    expect(alerts()).toEqual([]);
    // The draft keeps the typed company as an edit over the new reading.
    expect(chromeApi.storage.session.dump()["draft:7"]).toEqual({ url: PAGE, edits: { company: "Typed GmbH" } });
  });

  it("still keeps a field edited before Try again", async () => {
    const api = fakeApi({ read: vi.fn(async () => parsed) });
    render(editor(api, emptyRead(tab, { kind: "failed", error: unreachable() })));
    act(() => type(field("Location"), "Remote"));
    await act(async () => button("Try again")!.click());
    await settle();
    expect(field("Location").value).toBe("Remote");
    expect(field("Company").value).toBe("From the tracker");
  });
});

describe("withdrawn site access", () => {
  it("a read that failed for it offers Allow access, which asks Chrome and reads again", async () => {
    const api = fakeApi({ read: vi.fn(async () => parsed) });
    render(editor(api, emptyRead(tab, { kind: "failed", error: noAccess() })));
    expect(alerts()).toEqual([
      expect.stringContaining("Job Tracker no longer has access to tracker.example.com."),
    ]);
    expect(button("Try again")).toBeUndefined();

    await act(async () => button("Allow access")!.click());
    await settle();
    expect(api.requestAccess).toHaveBeenCalledTimes(1);
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(field("Company").value).toBe("From the tracker");
    expect(alerts()).toEqual([]);
  });

  it("access not granted: nothing is read, and the notice stays", async () => {
    const api = fakeApi({ read: vi.fn(async () => parsed), requestAccess: vi.fn(async () => false) });
    render(editor(api, emptyRead(tab, { kind: "failed", error: noAccess() })));
    await act(async () => button("Allow access")!.click());
    await settle();
    expect(api.read).not.toHaveBeenCalled();
    expect(button("Allow access")).toBeDefined();
  });

  it("a save that failed for it offers Allow access, which saves the edits once granted", async () => {
    const result = { job, duplicate: false } as unknown as UpsertResult;
    const saveJob = vi.fn().mockRejectedValueOnce(noAccess()).mockResolvedValueOnce(result);
    const onSaved = vi.fn();
    const api = fakeApi({ saveJob });
    render(editor(api, emptyRead(tab, { kind: "unreadable" }), { onSaved }));
    act(() => type(field("Title"), "Engineer"));
    act(() => type(field("Company"), "Acme"));

    await act(async () => button("Applied")!.click());
    await settle();
    expect(alerts()).toEqual([expect.stringContaining("Your edits are kept.")]);
    expect(onSaved).not.toHaveBeenCalled();

    await act(async () => button("Allow access")!.click());
    await settle();
    expect(saveJob).toHaveBeenCalledTimes(2);
    expect(saveJob.mock.calls[1][0]).toMatchObject({ title: "Engineer", company: "Acme", status: "applied" });
    expect(onSaved).toHaveBeenCalledWith(result, "applied");
  });

  it("the account check that failed for it shows Allow access in the footer, and checks again once granted", async () => {
    const session = { email: "ada@example.com", name: "Ada", latestVersion: "1.0.0" };
    const fetch = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(Response.json(session));
    vi.stubGlobal("fetch", fetch);
    Object.assign(chromeApi.runtime, { getManifest: () => ({ version: "1.0.0" }) });
    const request = vi.fn(async ({ origins }: { origins: string[] }) => {
      for (const origin of origins) chromeApi.permissions.granted.add(origin);
      return true;
    });
    Object.assign(chromeApi.permissions, { request });
    // connected.tsx reads the manifest when it loads.
    const { Connected } = await import("../../../extension/src/popup/connected");

    const connection = { origin: ORIGIN, token: `jtx_${"t".repeat(43)}`, email: "ada@example.com", name: "Ada" };
    // No tab: the form opens without a read, so only the account check meets the lost access.
    render(createElement(Connected, { connection, tab: null, onDisconnected: vi.fn() }));
    await settle();
    const footer = () => host.querySelector("footer")!;
    expect(footer().textContent).toContain("Job Tracker no longer has access to tracker.example.com.");

    await act(async () => button("Allow access")!.click());
    await settle();
    expect(request).toHaveBeenCalledWith({ origins: [`${ORIGIN}/*`] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(footer().textContent).not.toContain("no longer has access");
    // The key is kept.
    expect(chromeApi.storage.local.remove).not.toHaveBeenCalled();
  });
});

describe("priority", () => {
  const filled = (): ReadOutcome => ({
    ...emptyRead(tab, { kind: "unreadable" }),
    values: { title: "Engineer", company: "Acme", location: "", url: PAGE, description: "" },
  });
  const radio = (label: string) =>
    [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (input) => input.closest("label")?.textContent === label,
    )!;
  const checked = () => host.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.closest("label")?.textContent;
  const saved = (api: Api & { saveJob: ReturnType<typeof vi.fn> }) => api.saveJob.mock.calls[0][0] as Record<string, unknown>;
  const savingApi = () => fakeApi({ saveJob: vi.fn(async () => ({ job, duplicate: false })) });

  it("is a radio group labelled Priority, on Medium for a new job", () => {
    render(editor(fakeApi(), filled()));
    const group = host.querySelector('[role="radiogroup"]')!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe("Priority");
    expect([...group.querySelectorAll("label")].map((l) => l.textContent)).toEqual(["High", "Medium", "Low"]);
    expect(checked()).toBe("Medium");
  });

  it("sends no priority when none was picked: the tracker gives a new job Medium, and keeps a known job's", async () => {
    const api = savingApi();
    render(editor(api, filled()));
    await act(async () => button("Save")!.click());
    await settle();
    expect(saved(api)).toMatchObject({ title: "Engineer", status: "saved" });
    expect(saved(api)).not.toHaveProperty("priority");
  });

  it("sends the priority picked, and keeps it in the draft until saved", async () => {
    const api = savingApi();
    render(editor(api, filled()));
    act(() => radio("High").click());
    await settle();
    expect(checked()).toBe("High");
    expect(chromeApi.storage.session.dump()["draft:7"]).toMatchObject({ url: PAGE, priority: "high" });

    await act(async () => button("Applied")!.click());
    await settle();
    expect(saved(api)).toMatchObject({ status: "applied", priority: "high" });
    expect(chromeApi.storage.session.dump()["draft:7"]).toBeUndefined();
  });

  it("shows a known job's stored priority, and leaves it alone unless another is picked", async () => {
    const duplicate = { ...job, status: "applied", priority: "low", history: [], appliedAt: null, createdAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z" } as Job;
    const read = { ...filled(), duplicateOf: duplicate };
    const api = savingApi();
    render(editor(api, read));
    expect(checked()).toBe("Low");
    await act(async () => button("Save")!.click());
    await settle();
    expect(saved(api)).not.toHaveProperty("priority");

    const again = savingApi();
    act(() => root.unmount());
    root = createRoot(host);
    render(editor(again, read));
    act(() => radio("Medium").click());
    await act(async () => button("Save")!.click());
    await settle();
    expect(saved(again)).toMatchObject({ priority: "medium" });
  });

  it("starts on the priority picked in an earlier opening, and sends it", async () => {
    const api = savingApi();
    render(editor(api, { ...filled(), chosenPriority: "high" }));
    expect(checked()).toBe("High");
    await act(async () => button("Save")!.click());
    await settle();
    expect(saved(api)).toMatchObject({ priority: "high" });
  });

  it("on a known job, a priority picked in an earlier opening wins over the stored one", async () => {
    const duplicate = { ...job, status: "saved", priority: "low", history: [], appliedAt: null, createdAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z" } as Job;
    const api = savingApi();
    render(editor(api, { ...filled(), duplicateOf: duplicate, chosenPriority: "high" }));
    expect(checked()).toBe("High");
    await act(async () => button("Save")!.click());
    await settle();
    expect(saved(api)).toMatchObject({ priority: "high" });
  });
});

describe("focus and announcements", () => {
  it("Hide description gives the focus to the button that shows it again", async () => {
    render(editor(fakeApi(), emptyRead(tab, { kind: "unreadable" })));
    await act(async () => button("Add a description")!.click());
    await nextFrame();
    expect(document.activeElement?.tagName).toBe("TEXTAREA");

    // A click gives the button the focus in Chrome; happy-dom's click() doesn't.
    const hide = button("Hide description")!;
    hide.focus();
    await act(async () => hide.click());
    await nextFrame();
    expect(document.activeElement).toBe(button("Add a description"));
  });

  it.each([
    [false, "saved", "Saved"],
    [false, "applied", "Marked as applied"],
    [true, "applied", "Updated"],
  ] as const)("the Done screen says its title aloud (duplicate %s, %s): %s", (duplicate, status, title) => {
    const announce = vi.fn();
    const result = { job, duplicate } as unknown as UpsertResult;
    render(createElement(AnnounceContext, { value: announce }, createElement(DoneScreen, { result, status, origin: ORIGIN })));
    expect(announce).toHaveBeenCalledWith(title);
    expect(document.activeElement?.textContent).toContain("Open in tracker");
  });
});
