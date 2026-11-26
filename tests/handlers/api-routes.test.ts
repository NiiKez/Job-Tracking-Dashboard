import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST as classify } from "@/app/api/classify/route";
import { POST as resolveEmail } from "@/app/api/emails/[id]/resolve/route";
import { GET as listEmails } from "@/app/api/emails/route";
import { POST as checkInbox } from "@/app/api/inbox/check/route";
import { DELETE as deleteJob, GET as getJob, PATCH as patchJob } from "@/app/api/jobs/[id]/route";
import { GET as listJobs, POST as createJob } from "@/app/api/jobs/route";
import { GET as getMe } from "@/app/api/me/route";
import { POST as parse } from "@/app/api/parse/route";
import { DELETE as deleteRule } from "@/app/api/rules/[id]/route";
import { GET as listRules, POST as addRule } from "@/app/api/rules/route";
import { GET as getSettings, PATCH as patchSettings } from "@/app/api/settings/route";
import { GET as getStats } from "@/app/api/stats/route";
import { withTx } from "@/lib/server/db/client";
import { CLASSIFY_LIMITS, MAX_SETTINGS_LANGUAGES } from "@/lib/server/schemas";
import type {
  ClassifyResult,
  Email,
  Job,
  JobWithEmails,
  KeywordRule,
  ParseResult,
  Settings,
  Stats,
  UpsertResult,
} from "@/lib/types";
import { buildSeed } from "../../db/seed/fixtures";
import { seedUser } from "../../db/seed/seed";
import { makeEmail, makeJob } from "../helpers/factories";
import { describeDb } from "../helpers/test-db";
import { restoreEnv, signedInEnv } from "../unit/auth/env";
import { inboxEnv } from "../unit/inbox/connect-fakes";
import { ctx, OWNER, request, signedIn } from "./helpers";

// Every API route on the real database, called directly with a real session: the answers the
// screens get (shapes from src/lib/types.ts), and the service errors as 400, 404 and 409.
// Sign-in, 401 and 403 are in guard.test.ts.

// connection() needs a request scope; called directly, handlers only need it to resolve.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

const SEED = buildSeed(Date.now());

/** A second account, not on the allowlist: only its data is used. */
const OTHER = { sub: "110000000000000000002", email: "other@example.com", name: "Otto Other", picture: null };

const get = (path: string, cookie: string) => request(path, { cookie });
const send = (method: string, path: string, cookie: string, body?: unknown) =>
  request(path, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body) });

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

describeDb("the API on the database", () => {
  let cookie: string;
  let userId: string;

  beforeEach(async () => {
    signedInEnv();
    const session = await signedIn();
    cookie = session.cookie;
    userId = session.user.id;
  });
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  const seed = () => withTx((tx) => seedUser(tx, userId));

  /* ------------------------------------------------------------- 200s */

  it("GET /api/me", async () => {
    expect(await ok(await getMe(get("/api/me", cookie), ctx()))).toEqual({
      email: OWNER.email,
      name: OWNER.name,
      pictureUrl: OWNER.picture,
    });
  });

  it("GET /api/jobs: the seeded jobs, newest activity first, with search and status filters", async () => {
    await seed();
    const jobs = await ok<Job[]>(await listJobs(get("/api/jobs", cookie), ctx()));
    expect(jobs).toHaveLength(SEED.jobs.length);
    const activity = jobs.map((j) => j.lastActivityAt);
    expect(activity).toEqual([...activity].sort().reverse());
    expect(jobs[0]).toMatchObject({ id: expect.any(String), history: expect.any(Array), emailCount: expect.any(Number) });

    const found = await ok<Job[]>(await listJobs(get("/api/jobs?q=northw%C3%ADnd", cookie), ctx()));
    expect(found.map((j) => j.company)).toEqual(["Northwind Labs"]);

    const closed = await ok<Job[]>(await listJobs(get("/api/jobs?status=rejected,no_response", cookie), ctx()));
    expect(closed.length).toBe(SEED.jobs.filter((j) => j.status === "rejected" || j.status === "no_response").length);
    expect(new Set(closed.map((j) => j.status))).toEqual(new Set(["rejected", "no_response"]));
  });

  it("POST /api/jobs adds a job, and a second time finds the duplicate", async () => {
    const input = { title: "Platform Engineer", company: "Kettle & Co", url: "https://kettle.example.com/jobs/7", status: "saved" };
    const created = await ok<UpsertResult>(await createJob(send("POST", "/api/jobs", cookie, input), ctx()));
    expect(created).toMatchObject({ duplicate: false, job: { title: "Platform Engineer", status: "saved", captureMethod: "paste" } });
    const again = await ok<UpsertResult>(
      await createJob(send("POST", "/api/jobs", cookie, { ...input, url: "https://www.kettle.example.com/jobs/7/", status: "applied" }), ctx()),
    );
    expect(again).toMatchObject({ duplicate: true, job: { id: created.job.id, status: "applied" } });
  });

  it("GET, PATCH and DELETE /api/jobs/:id", async () => {
    const job = await makeJob(userId, { title: "Data Engineer", company: "Lumen Health" });
    const emailId = await makeEmail(userId, { outcome: "matched", jobId: job.id, subject: "Thanks for applying" });

    const detail = await ok<JobWithEmails>(await getJob(get(`/api/jobs/${job.id}`, cookie), ctx({ id: job.id })));
    expect(detail).toMatchObject({ id: job.id, title: "Data Engineer", emailCount: 1 });
    expect(detail.emails.map((e) => e.id)).toEqual([emailId]);

    const patched = await ok<Job>(
      await patchJob(
        send("PATCH", `/api/jobs/${job.id}`, cookie, { status: "interview", nextInterview: { at: "2026-12-01T14:00:00.000Z", round: "Onsite" } }),
        ctx({ id: job.id }),
      ),
    );
    expect(patched).toMatchObject({
      status: "interview",
      statusSource: "manual",
      statusLocked: true,
      nextInterview: { at: "2026-12-01T14:00:00.000Z", round: "Onsite" },
    });
    expect(patched.history.map((e) => e.to)).toEqual(["saved", "interview"]);

    expect(await ok(await deleteJob(send("DELETE", `/api/jobs/${job.id}`, cookie), ctx({ id: job.id })))).toEqual({ ok: true });
    await fails(await getJob(get(`/api/jobs/${job.id}`, cookie), ctx({ id: job.id })), 404, "Job not found");
  });

  it("POST and PATCH /api/jobs take a priority: medium by default, 400 for an unknown one", async () => {
    const input = { title: "Site Reliability Engineer", company: "Kettle & Co", status: "saved" };
    const plain = await ok<UpsertResult>(await createJob(send("POST", "/api/jobs", cookie, input), ctx()));
    expect(plain.job.priority).toBe("medium");
    const high = await ok<UpsertResult>(
      await createJob(send("POST", "/api/jobs", cookie, { ...input, title: "Data Engineer", priority: "high" }), ctx()),
    );
    expect(high).toMatchObject({ duplicate: false, job: { title: "Data Engineer", priority: "high" } });

    const id = high.job.id;
    const low = await ok<Job>(await patchJob(send("PATCH", `/api/jobs/${id}`, cookie, { priority: "low" }), ctx({ id })));
    expect(low).toMatchObject({ id, priority: "low", status: "saved", statusLocked: false });
    expect((await ok<JobWithEmails>(await getJob(get(`/api/jobs/${id}`, cookie), ctx({ id })))).priority).toBe("low");

    for (const priority of ["urgent", "High", "", null, 1]) {
      await fails(await patchJob(send("PATCH", `/api/jobs/${id}`, cookie, { priority }), ctx({ id })), 400, "Invalid request");
      await fails(await createJob(send("POST", "/api/jobs", cookie, { ...input, priority }), ctx()), 400, "Invalid request");
    }
    expect((await ok<JobWithEmails>(await getJob(get(`/api/jobs/${id}`, cookie), ctx({ id })))).priority).toBe("low");
  });

  it("GET /api/stats counts the seeded jobs and the emails waiting for review", async () => {
    await seed();
    const stats = await ok<Stats>(await getStats(get("/api/stats", cookie), ctx()));
    expect(stats.total).toBe(SEED.jobs.length);
    expect(stats.reviewCount).toBe(SEED.emails.filter((e) => e.outcome === "review").length);
    expect(stats.byStatus.interview).toBe(SEED.jobs.filter((j) => j.status === "interview").length);
  });

  it("POST /api/parse reads pasted text and points at the job it would duplicate", async () => {
    const job = await makeJob(userId, { title: "Frontend Engineer", company: "Parcelwerk" });
    const res = await ok<ParseResult>(
      await parse(
        send("POST", "/api/parse", cookie, {
          input: "Frontend Engineer\nCompany: Parcelwerk\nLocation: Berlin\n\nWe build parcel lockers.",
        }),
        ctx(),
      ),
    );
    expect(res).toMatchObject({ title: "Frontend Engineer", company: "Parcelwerk", location: "Berlin" });
    expect(res.duplicateOf?.id).toBe(job.id);

    const fresh = await ok<ParseResult>(
      await parse(send("POST", "/api/parse", cookie, { input: "Data Engineer\nCompany: Parcelwerk" }), ctx()),
    );
    expect(fresh.duplicateOf).toBeNull();
  });

  it("GET /api/emails with outcome and job filters", async () => {
    await seed();
    const all = await ok<Email[]>(await listEmails(get("/api/emails", cookie), ctx()));
    expect(all).toHaveLength(SEED.emails.length);
    const review = await ok<Email[]>(await listEmails(get("/api/emails?outcome=review", cookie), ctx()));
    expect(review.map((e) => e.outcome)).toEqual(SEED.emails.filter((e) => e.outcome === "review").map(() => "review"));

    const northwind = (await ok<Job[]>(await listJobs(get("/api/jobs?q=northwind", cookie), ctx())))[0];
    const linked = await ok<Email[]>(await listEmails(get(`/api/emails?jobId=${northwind.id}`, cookie), ctx()));
    expect(linked).toHaveLength(northwind.emailCount);
    expect(linked.every((e) => e.jobId === northwind.id)).toBe(true);
    expect(await ok(await listEmails(get("/api/emails?jobId=not-a-uuid", cookie), ctx()))).toEqual([]);
  });

  it("POST /api/emails/:id/resolve confirms a seeded review email", async () => {
    await seed();
    const review = await ok<Email[]>(await listEmails(get("/api/emails?outcome=review", cookie), ctx()));
    const lumen = review.find((e) => e.fromName === "Lumen Health")!;
    const res = await ok<{ email: Email; job: Job | null }>(
      await resolveEmail(send("POST", `/api/emails/${lumen.id}/resolve`, cookie, { action: "confirm" }), ctx({ id: lumen.id })),
    );
    expect(res.email).toMatchObject({ id: lumen.id, outcome: "resolved", jobId: lumen.suggestedJobIds[0] });
    expect(res.job).toMatchObject({ id: lumen.suggestedJobIds[0], company: "Lumen Health" });
  });

  it("POST /api/inbox/check answers 409 while no inbox is connected, and changes nothing", async () => {
    // Gmail mode, whatever MAIL_SOURCE the environment has (CI runs fixture). The demo mode and
    // the sync itself: tests/handlers/inbox-check.test.ts.
    inboxEnv();
    await seed();
    const before = await ok<Stats>(await getStats(get("/api/stats", cookie), ctx()));
    await fails(await checkInbox(send("POST", "/api/inbox/check", cookie), ctx()), 409, "Connect Gmail in Settings first.");
    expect(await ok(await getStats(get("/api/stats", cookie), ctx()))).toEqual(before);
    const settings = await ok<Settings>(await getSettings(get("/api/settings", cookie), ctx()));
    expect(settings.inbox).toMatchObject({ connected: false, state: "not_connected", address: null, lastCheckedAt: null });
  });

  it("POST /api/classify runs the rule tester on the user's rules and jobs", async () => {
    await makeJob(userId, { title: "Senior Frontend Engineer", company: "Northwind Labs", status: "applied" });
    const res = await ok<ClassifyResult>(
      await classify(
        send("POST", "/api/classify", cookie, {
          fromName: "Northwind Labs Recruiting",
          fromAddress: "jobs@northwindlabs.example.com",
          subject: "Interview invitation: Senior Frontend Engineer",
          body: "We would like to invite you to an interview. Please share your availability.",
        }),
        ctx(),
      ),
    );
    expect(res).toMatchObject({ related: true, status: "interview", outcome: "matched" });
    expect(res.candidates[0]).toMatchObject({ company: "Northwind Labs" });
  });

  it("GET, POST and DELETE /api/rules", async () => {
    const rules = await ok<KeywordRule[]>(await listRules(get("/api/rules", cookie), ctx()));
    expect(rules.length).toBeGreaterThan(0);
    const added = await ok<KeywordRule>(
      await addRule(send("POST", "/api/rules", cookie, { status: "offer", phrase: "Zusage", language: "de" }), ctx()),
      201,
    );
    expect(added).toEqual({ id: expect.any(String), status: "offer", phrase: "Zusage", language: "de" });
    expect(await ok(await deleteRule(send("DELETE", `/api/rules/${added.id}`, cookie), ctx({ id: added.id })))).toEqual({
      ok: true,
    });
    expect(await ok<KeywordRule[]>(await listRules(get("/api/rules", cookie), ctx()))).toEqual(rules);
  });

  /** Settings.inbox with Gmail set up (INBOX_TOKEN_KEY, sign-in) and nothing connected. */
  const NOT_CONNECTED_INBOX = {
    provider: "gmail",
    address: null,
    connected: false,
    state: "not_connected",
    syncing: false,
    backfill: null,
    lastCheckedAt: null,
    lastError: null,
    intervalMinutes: 15,
    configured: true,
    demo: false,
  };

  it("GET and PATCH /api/settings", async () => {
    // The same whatever INBOX_TOKEN_KEY and MAIL_SOURCE the environment has (CI runs fixture).
    inboxEnv();
    const settings = await ok<Settings>(await getSettings(get("/api/settings", cookie), ctx()));
    expect(settings).toEqual({
      inbox: NOT_CONNECTED_INBOX,
      noResponseDays: 30,
      createFromConfirmation: true,
      reviewUncertain: true,
      languages: ["en", "de"],
    });
    const patched = await ok<Settings>(
      await patchSettings(send("PATCH", "/api/settings", cookie, { noResponseDays: 45, inbox: { intervalMinutes: 60 } }), ctx()),
    );
    expect(patched).toEqual({ ...settings, noResponseDays: 45, inbox: { ...settings.inbox, intervalMinutes: 60 } });
    expect(await ok(await getSettings(get("/api/settings", cookie), ctx()))).toEqual(patched);
  });

  it("PATCH /api/settings takes only inbox.intervalMinutes from the inbox block", async () => {
    inboxEnv();
    const res = await ok<Settings>(
      await patchSettings(
        send("PATCH", "/api/settings", cookie, {
          inbox: {
            provider: "outlook",
            address: "someone@example.com",
            connected: true,
            state: "connected",
            demo: true,
            lastCheckedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
        ctx(),
      ),
    );
    expect(res.inbox).toEqual(NOT_CONNECTED_INBOX);
    const both = await ok<Settings>(
      await patchSettings(send("PATCH", "/api/settings", cookie, { inbox: { connected: true, intervalMinutes: 30 } }), ctx()),
    );
    expect(both.inbox).toEqual({ ...res.inbox, intervalMinutes: 30 });
    expect((await ok<Settings>(await getSettings(get("/api/settings", cookie), ctx()))).inbox).toEqual(both.inbox);
  });

  /* ----------------------------------------------------- 404, 409, 400 */

  it("answers 404 for another user's job, email and rule, as for a missing one", async () => {
    const { user: other } = await signedIn(OTHER);
    const theirs = await makeJob(other.id, { title: "Secret role", company: "Elsewhere" });
    const theirEmail = await makeEmail(other.id);
    const [theirRule] = await withTx((tx) => tx<{ id: string }[]>`SELECT id FROM keyword_rules WHERE user_id = ${other.id} LIMIT 1`);

    const id = { id: theirs.id };
    await fails(await getJob(get(`/api/jobs/${theirs.id}`, cookie), ctx(id)), 404, "Job not found");
    await fails(await patchJob(send("PATCH", `/api/jobs/${theirs.id}`, cookie, { title: "Mine now" }), ctx(id)), 404);
    await fails(await deleteJob(send("DELETE", `/api/jobs/${theirs.id}`, cookie), ctx(id)), 404);
    await fails(
      await resolveEmail(send("POST", `/api/emails/${theirEmail}/resolve`, cookie, { action: "dismiss" }), ctx({ id: theirEmail })),
      404,
      "Email not found",
    );
    await fails(await deleteRule(send("DELETE", `/api/rules/${theirRule.id}`, cookie), ctx({ id: theirRule.id })), 404);
    // An email of mine assigned to their job.
    const mine = await makeEmail(userId);
    await fails(
      await resolveEmail(
        send("POST", `/api/emails/${mine}/resolve`, cookie, { action: "assign", jobId: theirs.id, status: "interview" }),
        ctx({ id: mine }),
      ),
      404,
    );
    // Malformed ids are missing too, not a 500.
    await fails(await getJob(get("/api/jobs/job_0001", cookie), ctx({ id: "job_0001" })), 404);

    // Untouched.
    const [row] = await withTx((tx) => tx<{ title: string }[]>`SELECT title FROM jobs WHERE id = ${theirs.id}`);
    expect(row.title).toBe("Secret role");
  });

  it("answers 409 for a link edit that collides with another job", async () => {
    await makeJob(userId, { title: "Backend Engineer", company: "Quarry", url: "https://jobs.example.com/quarry/1" });
    const other = await makeJob(userId, { title: "Frontend Engineer", company: "Quarry", url: "https://jobs.example.com/quarry/2" });
    await fails(
      await patchJob(
        send("PATCH", `/api/jobs/${other.id}`, cookie, { url: "https://www.jobs.example.com/quarry/1/?utm_source=x" }),
        ctx({ id: other.id }),
      ),
      409,
      "Another job already has this link",
    );
    const after = await ok<JobWithEmails>(await getJob(get(`/api/jobs/${other.id}`, cookie), ctx({ id: other.id })));
    expect(after.url).toBe("https://jobs.example.com/quarry/2");
  });

  it("answers 409 for resolving an email that is no longer in review", async () => {
    const emailId = await makeEmail(userId);
    const resolve = (action: unknown) =>
      resolveEmail(send("POST", `/api/emails/${emailId}/resolve`, cookie, action), ctx({ id: emailId }));
    await ok(await resolve({ action: "dismiss" }));
    await fails(await resolve({ action: "dismiss" }), 409, "no longer waiting for review");
    await fails(await resolve({ action: "create", status: "applied", company: "Kettle", title: "Engineer" }), 409);
  });

  it("answers 400 for invalid input, from the schema or from a service", async () => {
    const job = await makeJob(userId);
    await fails(await createJob(send("POST", "/api/jobs", cookie, { title: "", company: "X", status: "saved" }), ctx()), 400, "Invalid request");
    await fails(await listJobs(get("/api/jobs?status=archived", cookie), ctx()), 400);
    await fails(await listEmails(get("/api/emails?outcome=spam", cookie), ctx()), 400);
    await fails(await patchJob(send("PATCH", `/api/jobs/${job.id}`, cookie, { status: "hired" }), ctx({ id: job.id })), 400);
    await fails(await patchSettings(send("PATCH", "/api/settings", cookie, { noResponseDays: 3 }), ctx()), 400);
    await fails(await patchSettings(send("PATCH", "/api/settings", cookie, { inbox: { intervalMinutes: 1 } }), ctx()), 400);
    // Capped lists and text: a list of languages too long, a rule tester body too long.
    const languages = Array.from({ length: MAX_SETTINGS_LANGUAGES + 1 }, (_, i) => `l${i}`);
    await fails(await patchSettings(send("PATCH", "/api/settings", cookie, { languages }), ctx()), 400);
    await fails(await patchSettings(send("PATCH", "/api/settings", cookie, { languages: ["english"] }), ctx()), 400);
    const body = "x".repeat(CLASSIFY_LIMITS.body + 1);
    await fails(await classify(send("POST", "/api/classify", cookie, { subject: "Hi", body }), ctx()), 400);
    await fails(await parse(send("POST", "/api/parse", cookie, { input: "   " }), ctx()), 400);
    // Dates PostgreSQL has no room for (year 0) or that postgres.js reads back wrong (years 1-99).
    for (const at of ["0000-01-01T00:00:00Z", "0026-12-01T22:59:00Z", "1969-12-31T23:59:59Z"]) {
      await fails(await patchJob(send("PATCH", `/api/jobs/${job.id}`, cookie, { offerDeadline: at }), ctx({ id: job.id })), 400);
      await fails(
        await patchJob(send("PATCH", `/api/jobs/${job.id}`, cookie, { nextInterview: { at, round: "" } }), ctx({ id: job.id })),
        400,
      );
    }
    // A job's link is rendered as a link: http and https only.
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "ftp://files.example.com/job"]) {
      await fails(await createJob(send("POST", "/api/jobs", cookie, { title: "T", company: "C", url, status: "saved" }), ctx()), 400);
      await fails(await patchJob(send("PATCH", `/api/jobs/${job.id}`, cookie, { url }), ctx({ id: job.id })), 400);
    }
    // Passes the schema (two characters), but normalizes to nothing: the service refuses it.
    await fails(
      await addRule(send("POST", "/api/rules", cookie, { status: "offer", phrase: "́́", language: "en" }), ctx()),
      400,
      "The phrase has nothing to match",
    );
  });

  it.each([
    "",
    " ",
    "../settings",
    "0",
    "019a0000-0000-7000-8000-00000000000g",
    "{019a0000-0000-7000-8000-000000000000}",
    "019a00000000700080000000000000000",
    "x".repeat(10_000),
    "\u0000",
    "019A0000-0000-7000-8000-000000000000",
  ])("answers 404, never 500, for a malformed or unknown id: %#", async (id) => {
    const path = `/api/x/${encodeURIComponent(id)}`;
    const statuses = [
      (await getJob(get(path, cookie), ctx({ id }))).status,
      (await patchJob(send("PATCH", path, cookie, { title: "x" }), ctx({ id }))).status,
      (await deleteJob(send("DELETE", path, cookie), ctx({ id }))).status,
      (await deleteRule(send("DELETE", path, cookie), ctx({ id }))).status,
      (await resolveEmail(send("POST", path, cookie, { action: "dismiss" }), ctx({ id }))).status,
    ];
    expect(statuses).toEqual([404, 404, 404, 404, 404]);
  });

  it("takes any query text without a 500", async () => {
    const status = async (path: string) =>
      (await (path.startsWith("/api/jobs") ? listJobs : listEmails)(get(path, cookie), ctx())).status;
    expect(await status("/api/jobs?q=%00%25_%5C")).toBe(200);
    expect(await status("/api/jobs?status=,,")).toBe(200);
    expect(await status("/api/jobs?status=%00")).toBe(400);
    expect(await status(`/api/jobs?q=${"a".repeat(20_000)}`)).toBe(200);
    expect(await status("/api/emails?jobId=%00")).toBe(200);
    expect(await status("/api/emails?jobId=019A0000-0000-7000-8000-000000000000")).toBe(200);
    expect(await status("/api/emails?outcome=review,%00")).toBe(400);
  });
});
