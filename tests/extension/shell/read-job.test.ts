import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toJobPayload } from "@/components/add-job/job-form";
import { extensionJobInputSchema } from "@/lib/server/schemas";
import type { Job, PageSnapshot, ParseResult } from "@/lib/types";
import { ApiError, type Api } from "../../../extension/src/lib/api";
import type { TargetTab } from "../../../extension/src/lib/tab";
import { fromStoredJob, MAX_DESCRIPTION, MAX_FIELD, readJob } from "../../../extension/src/popup/read-job";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";

// What the popup's form starts from: the tracker's reading of the page, or, for a job it already
// has, what it stored (saving sends every field, so starting from the page would undo corrections
// made in the tracker), with the user's unsaved draft on top of either.

const PAGE_URL = "https://jobs.example.com/1";
const tab = { id: 7, url: PAGE_URL } as TargetTab;

const stored: Job = {
  id: "job-1",
  title: "Senior Frontend Engineer (corrected)",
  company: "Acme GmbH",
  location: "",
  url: null,
  description: "",
  status: "applied",
  statusSource: "manual",
  statusLocked: false,
  captureMethod: "paste",
  createdAt: "2026-11-02T10:00:00Z",
  appliedAt: "2026-11-03T10:00:00Z",
  updatedAt: "2026-11-03T10:00:00Z",
  lastActivityAt: "2026-11-03T10:00:00Z",
  history: [],
  emailCount: 0,
  nextInterview: null,
  offerDeadline: null,
};

const parsed: ParseResult = {
  title: "Sr. Frontend Engineer",
  company: "ACME",
  location: "Berlin",
  url: PAGE_URL,
  description: "Build the product with us.",
  missing: [],
  duplicateOf: null,
};

const snapshot: PageSnapshot = {
  url: PAGE_URL,
  canonicalUrl: null,
  title: "Sr. Frontend Engineer at ACME",
  meta: {},
  jsonLd: [],
  site: { reader: "generic", fields: { title: "From the site reader", description: "Reader text." } },
  selection: "",
};

let chromeApi: FakeChrome;
let read: ReturnType<typeof vi.fn<Api["read"]>>;
let api: Api;

beforeEach(() => {
  chromeApi = installFakeChrome();
  // page/read-page.js goes in first, then the call that returns the snapshot.
  chromeApi.scripting.executeScript.mockResolvedValueOnce([{ result: undefined }]).mockResolvedValueOnce([{ result: snapshot }]);
  read = vi.fn<Api["read"]>();
  api = { read } as unknown as Api;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the job input limits", () => {
  const input = (fields: Record<string, string>) => ({ title: "Engineer", company: "Acme", status: "saved", ...fields });

  it.each(["title", "company", "location"])("are the tracker's for %s", (field) => {
    expect(extensionJobInputSchema.safeParse(input({ [field]: "x".repeat(MAX_FIELD) })).success).toBe(true);
    expect(extensionJobInputSchema.safeParse(input({ [field]: "x".repeat(MAX_FIELD + 1) })).success).toBe(false);
  });

  it("are the tracker's for the description", () => {
    expect(extensionJobInputSchema.safeParse(input({ description: "x".repeat(MAX_DESCRIPTION) })).success).toBe(true);
    expect(extensionJobInputSchema.safeParse(input({ description: "x".repeat(MAX_DESCRIPTION + 1) })).success).toBe(false);
  });
});

describe("fromStoredJob", () => {
  it("keeps every field the tracker has, and takes only the empty ones from the page", () => {
    expect(
      fromStoredJob(stored, {
        title: "Sr. Frontend Engineer",
        company: "ACME",
        location: "Berlin",
        url: PAGE_URL,
        description: "Build the product with us.",
      }),
    ).toEqual({
      title: "Senior Frontend Engineer (corrected)",
      company: "Acme GmbH",
      location: "Berlin",
      url: PAGE_URL,
      description: "Build the product with us.",
    });
  });

  it("treats a stored field of spaces as empty, and leaves a field empty on both sides empty", () => {
    const job = { ...stored, location: "  ", url: "https://acme.example.com/jobs/1", description: "Stored text." };
    expect(fromStoredJob(job, { title: "", company: "", location: "", url: PAGE_URL, description: "Page text." })).toEqual({
      title: "Senior Frontend Engineer (corrected)",
      company: "Acme GmbH",
      location: "",
      url: "https://acme.example.com/jobs/1",
      description: "Stored text.",
    });
  });
});

describe("readJob", () => {
  it("starts from the tracker's reading of the page", async () => {
    read.mockResolvedValue({ ...parsed, missing: ["location"] });
    const outcome = await readJob(api, tab);
    expect(read).toHaveBeenCalledWith(snapshot);
    expect(outcome).toEqual({
      initial: { title: "Sr. Frontend Engineer", company: "ACME", location: "Berlin", url: PAGE_URL, description: "Build the product with us." },
      values: { title: "Sr. Frontend Engineer", company: "ACME", location: "Berlin", url: PAGE_URL, description: "Build the product with us." },
      missing: ["location"],
      duplicateOf: null,
      notice: null,
    });
  });

  it("starts a duplicate from what the tracker stored, and the draft still wins over both", async () => {
    read.mockResolvedValue({ ...parsed, duplicateOf: stored });
    await chromeApi.storage.session.set({ "draft:7": { url: PAGE_URL, edits: { company: "Acme Group" } } });
    const outcome = await readJob(api, tab);
    expect(outcome.duplicateOf).toBe(stored);
    expect(outcome.initial).toEqual({
      title: "Senior Frontend Engineer (corrected)",
      company: "Acme GmbH",
      location: "Berlin",
      url: PAGE_URL,
      description: "Build the product with us.",
    });
    expect(outcome.values).toEqual({ ...outcome.initial, company: "Acme Group" });
  });

  it("ignores a draft made on another page in the same tab", async () => {
    read.mockResolvedValue(parsed);
    await chromeApi.storage.session.set({ "draft:7": { url: "https://jobs.example.com/2", edits: { title: "Other" } } });
    expect((await readJob(api, tab)).values.title).toBe("Sr. Frontend Engineer");
  });

  it("falls back to the site reader and keeps the error when the tracker can't be asked", async () => {
    const error = new ApiError("retryable", "Couldn't reach tracker.example.com.", null);
    read.mockRejectedValue(error);
    expect(await readJob(api, tab)).toMatchObject({
      initial: { title: "From the site reader", company: "", location: "", url: PAGE_URL, description: "Reader text." },
      duplicateOf: null,
      notice: { kind: "failed", error },
    });
  });

  it("cuts the site reader's fields to the job input limits and drops NUL, so the fallback can be saved", async () => {
    // A site reader keeps up to 100,000 characters of description; the tracker saves 50,000. And
    // the tracker refuses any text with a NUL in it.
    const long: PageSnapshot = {
      ...snapshot,
      site: {
        reader: "generic",
        fields: {
          title: `Engineer\u0000 ${"x".repeat(300)}`,
          company: "Acme\u0000 GmbH",
          location: ` ${"Berlin ".repeat(40)}`,
          // An emoji across the cut at 50,000.
          description: `${"x".repeat(49_999)}😀${" word".repeat(9_000)}`,
        },
      },
    };
    chromeApi.scripting.executeScript.mockReset().mockResolvedValueOnce([{ result: undefined }]).mockResolvedValueOnce([{ result: long }]);
    read.mockRejectedValue(new ApiError("retryable", "tracker.example.com took too long to answer. Try again.", null));

    const { initial, values } = await readJob(api, tab);
    for (const value of Object.values(initial)) expect(value).not.toContain("\u0000");
    expect(initial.title).toHaveLength(200);
    expect(initial.title.startsWith("Engineer x")).toBe(true);
    expect(initial.company).toBe("Acme GmbH");
    expect(initial.location.length).toBeLessThanOrEqual(200);
    expect(initial.location.startsWith("Berlin")).toBe(true);
    // Never half of a surrogate pair at the cut.
    expect(initial.description).toBe("x".repeat(49_999));
    expect(extensionJobInputSchema.safeParse({ ...toJobPayload(values), status: "saved" }).success).toBe(true);
  });

  it("throws only a 401, for the popup to forget the connection", async () => {
    read.mockRejectedValue(new ApiError("disconnected", "This browser was disconnected. Connect again.", 401));
    await expect(readJob(api, tab)).rejects.toMatchObject({ kind: "disconnected" });
  });

  it("gives an empty form with the link when the page can't be read", async () => {
    chromeApi.scripting.executeScript.mockReset().mockRejectedValue(new Error("Cannot access contents of the page."));
    expect(await readJob(api, tab)).toMatchObject({
      initial: { title: "", company: "", location: "", url: PAGE_URL, description: "" },
      notice: { kind: "unreadable" },
    });
    expect(await readJob(api, { id: 8, url: "chrome://extensions/" } as TargetTab)).toMatchObject({
      initial: { url: "" },
      notice: { kind: "unreadable" },
    });
    expect(read).not.toHaveBeenCalled();
  });
});
