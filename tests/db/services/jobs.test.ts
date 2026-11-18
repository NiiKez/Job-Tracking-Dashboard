import { expect, it } from "vitest";
import { getDb } from "@/lib/server/db/client";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/server/errors";
import { jobPatchSchema } from "@/lib/server/schemas";
import {
  deleteJob,
  getJob,
  listJobs,
  loadJob,
  updateJob,
  upsertJob,
} from "@/lib/server/services/jobs";
import { parseInput } from "@/lib/server/services/parse";
import { ageJob, countRows, createUser, makeEmail, makeJob } from "../../helpers/factories";
import { describeDb, testSql } from "../../helpers/test-db";

const LINK = "https://boards.example.com/parcelwerk/jobs/4711";

async function keyColumns(jobId: string) {
  const [row] = await testSql()`
    SELECT url_norm, company_slug, title_norm, search_text FROM jobs WHERE id = ${jobId}`;
  return row;
}

describeDb("jobs service", () => {
  /* ------------------------------------------------------------ create */

  it("adds a job with its creating event and key columns", async () => {
    const user = await createUser();
    const { job, duplicate } = await upsertJob(user, {
      title: "Senior  Frontend Engineer",
      company: "Müller & Söhne GmbH",
      location: "Berlin",
      url: `${LINK}?utm_source=feed`,
      description: "Build things.",
      status: "applied",
      captureMethod: "extension",
    });
    expect(duplicate).toBe(false);
    expect(job).toMatchObject({
      title: "Senior  Frontend Engineer",
      company: "Müller & Söhne GmbH",
      location: "Berlin",
      status: "applied",
      statusSource: "extension",
      statusLocked: false,
      captureMethod: "extension",
      emailCount: 0,
      nextInterview: null,
      offerDeadline: null,
    });
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.appliedAt).toBe(job.createdAt);
    expect(job.lastActivityAt).toBe(job.createdAt);
    expect(job.history).toEqual([
      { id: expect.any(String), from: null, to: "applied", at: job.createdAt, source: "extension" },
    ]);
    expect(await keyColumns(job.id)).toEqual({
      url_norm: "boards.example.com/parcelwerk/jobs/4711",
      company_slug: "mullerandsohne",
      title_norm: "senior frontend engineer",
      search_text: "muller & sohne gmbh senior frontend engineer",
    });
  });

  it("stores no link key for a link that normalizes to nothing", async () => {
    const user = await createUser();
    const a = await makeJob(user, { url: "file:///", company: "Acme", title: "One" });
    const b = await makeJob(user, { url: "file:///", company: "Acme", title: "Two" });
    expect(a.id).not.toBe(b.id);
    expect((await keyColumns(a.id)).url_norm).toBeNull();
  });

  /* ------------------------------------------------------------- dedupe */

  it("treats the same link as a duplicate, tracking parameters included", async () => {
    const user = await createUser();
    const first = await makeJob(user, { url: LINK });
    const again = await upsertJob(user, {
      title: "Another title",
      company: "Other name",
      location: "",
      url: `https://www.boards.example.com/parcelwerk/jobs/4711/?utm_campaign=x&ref=mail#apply`,
      description: "",
      status: "saved",
      captureMethod: "paste",
    });
    expect(again.duplicate).toBe(true);
    expect(again.job.id).toBe(first.id);
    expect(await countRows("jobs")).toBe(1);
  });

  it("treats the same company and title without a link as a duplicate", async () => {
    const user = await createUser();
    const first = await makeJob(user, { company: "Parcelwerk GmbH", title: "Frontend Engineer" });
    const again = await upsertJob(user, {
      title: "  frontend   ENGINEER ",
      company: "PARCELWERK",
      location: "",
      url: null,
      description: "",
      status: "saved",
      captureMethod: "paste",
    });
    expect(again).toMatchObject({ duplicate: true, job: { id: first.id } });
    expect(await countRows("jobs")).toBe(1);
  });

  it("does not dedupe on company and title when the company has no key", async () => {
    const user = await createUser();
    await makeJob(user, { company: "GmbH", title: "Engineer" });
    const again = await upsertJob(user, {
      title: "Engineer",
      company: "GmbH",
      location: "",
      url: null,
      description: "",
      status: "saved",
      captureMethod: "paste",
    });
    expect(again.duplicate).toBe(false);
    expect(await countRows("jobs")).toBe(2);
  });

  it("creates exactly one job when the same link is added twice at the same moment", async () => {
    const user = await createUser();
    const input = {
      title: "Backend Engineer",
      company: "Silt & Stone",
      location: "",
      url: LINK,
      description: "",
      status: "saved" as const,
      captureMethod: "extension" as const,
    };
    const results = await Promise.all([1, 2, 3, 4].map(() => upsertJob(user, input)));
    expect(await countRows("jobs")).toBe(1);
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await countRows("job_status_events")).toBe(1);
  });

  /* -------------------------------------------------------------- merge */

  it("merges a duplicate: fields fill in, the longer description wins", async () => {
    const user = await createUser();
    const first = await makeJob(user, { url: LINK, location: "", description: "A long description of the role." });
    await ageJob(first.id);
    const before = await loadJob(getDb(), user, first.id);

    const { job } = await upsertJob(user, {
      title: "Frontend Engineer (m/w/d)",
      company: "Parcelwerk",
      location: "Hamburg",
      url: LINK,
      description: "Short.",
      status: "saved",
      captureMethod: "paste",
    });
    expect(job).toMatchObject({
      title: "Frontend Engineer (m/w/d)",
      location: "Hamburg",
      description: "A long description of the role.",
      status: "saved",
    });
    expect(job.updatedAt > before.updatedAt).toBe(true);
    expect(job.history).toHaveLength(1);

    const longer = "A much longer description of the role, with the team and the stack.";
    const { job: again } = await upsertJob(user, {
      title: "",
      company: "",
      location: "",
      url: LINK,
      description: longer,
      status: "saved",
      captureMethod: "paste",
    });
    expect(again).toMatchObject({ title: "Frontend Engineer (m/w/d)", location: "Hamburg", description: longer });
  });

  it("moves a duplicate from saved to applied only, recorded with the capture method", async () => {
    const user = await createUser();
    const job = await makeJob(user, { url: LINK, status: "saved" });
    const applied = await upsertJob(user, {
      title: "Frontend Engineer",
      company: "Parcelwerk",
      location: "",
      url: LINK,
      description: "",
      status: "applied",
      captureMethod: "extension",
    });
    expect(applied.job).toMatchObject({ id: job.id, status: "applied", statusSource: "extension", statusLocked: false });
    expect(applied.job.appliedAt).not.toBeNull();
    expect(applied.job.history.map((e) => [e.from, e.to, e.source])).toEqual([
      [null, "saved", "paste"],
      ["saved", "applied", "extension"],
    ]);

    // Never back from a later stage, and "saved" never moves anything.
    await updateJob(user, job.id, { status: "interview" });
    for (const status of ["applied", "saved"] as const) {
      const { job: again } = await upsertJob(user, {
        title: "Frontend Engineer",
        company: "Parcelwerk",
        location: "",
        url: LINK,
        description: "",
        status,
        captureMethod: "paste",
      });
      expect(again.status).toBe("interview");
      expect(again.history).toHaveLength(3);
    }
  });

  /* ------------------------------------------------------- status locks */

  it("locks a job on a manual status change", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    const moved = await updateJob(user, job.id, { status: "interview" });
    expect(moved).toMatchObject({ status: "interview", statusSource: "manual", statusLocked: true });
    expect(moved.history.at(-1)).toMatchObject({ from: "applied", to: "interview", source: "manual" });
  });

  it("does not lock on saved -> applied", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "saved" });
    const moved = await updateJob(user, job.id, { status: "applied" });
    expect(moved).toMatchObject({ status: "applied", statusSource: "manual", statusLocked: false });
    expect(moved.appliedAt).not.toBeNull();
  });

  it("lets an explicit statusLocked win", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    const unlocked = await updateJob(user, job.id, { status: "rejected", statusLocked: false });
    expect(unlocked).toMatchObject({ status: "rejected", statusLocked: false });

    const locked = await updateJob(user, job.id, { statusLocked: true });
    expect(locked).toMatchObject({ status: "rejected", statusLocked: true });
    expect(locked.history).toHaveLength(2);

    const unlockedAgain = await updateJob(user, job.id, { statusLocked: false });
    expect(unlockedAgain.statusLocked).toBe(false);

    const saved = await makeJob(user, { title: "Other", status: "saved" });
    expect(await updateJob(user, saved.id, { status: "applied", statusLocked: true })).toMatchObject({
      status: "applied",
      statusLocked: true,
    });
  });

  it("records nothing when the status does not change", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "applied" });
    const same = await updateJob(user, job.id, { status: "applied" });
    expect(same).toMatchObject({ statusLocked: false, statusSource: "paste" });
    expect(same.history).toHaveLength(1);
  });

  /* ------------------------------------------------------------ history */

  it("keeps the history in order and sets appliedAt on the first applied only", async () => {
    const user = await createUser();
    const job = await makeJob(user, { status: "saved" });
    expect(job.appliedAt).toBeNull();
    const applied = await updateJob(user, job.id, { status: "applied" });
    const firstApplied = applied.appliedAt;
    expect(firstApplied).not.toBeNull();
    await updateJob(user, job.id, { status: "interview" });
    await updateJob(user, job.id, { status: "applied" });
    const final = await updateJob(user, job.id, { status: "offer" });
    expect(final.appliedAt).toBe(firstApplied);
    expect(final.history.map((e) => [e.from, e.to])).toEqual([
      [null, "saved"],
      ["saved", "applied"],
      ["applied", "interview"],
      ["interview", "applied"],
      ["applied", "offer"],
    ]);
    const times = final.history.map((e) => e.at);
    expect([...times].sort()).toEqual(times);
    expect(final.lastActivityAt).toBe(final.history.at(-1)!.at);
  });

  /* --------------------------------------------------------------- edits */

  it("edits fields, recomputes the keys, and sets and clears the interview and deadline", async () => {
    const user = await createUser();
    const job = await makeJob(user, { url: LINK });
    await ageJob(job.id);
    const edited = await updateJob(user, job.id, {
      title: "Staff Engineer",
      company: "Bramble Labs",
      url: "https://example.com/careers/9?utm_source=x",
      location: "Remote",
      description: "New text",
      nextInterview: { at: "2026-12-01T09:30:00.000Z", round: "Technical interview" },
      offerDeadline: "2026-12-15T22:59:59.999Z",
    });
    expect(edited).toMatchObject({
      title: "Staff Engineer",
      company: "Bramble Labs",
      url: "https://example.com/careers/9?utm_source=x",
      location: "Remote",
      description: "New text",
      nextInterview: { at: "2026-12-01T09:30:00.000Z", round: "Technical interview" },
      offerDeadline: "2026-12-15T22:59:59.999Z",
      status: "saved",
    });
    expect(edited.updatedAt > job.updatedAt).toBe(true);
    expect(await keyColumns(job.id)).toEqual({
      url_norm: "example.com/careers/9",
      company_slug: "bramblelabs",
      title_norm: "staff engineer",
      search_text: "bramble labs staff engineer",
    });
    expect((await listJobs(getDb(), user, { q: "staff" })).map((j) => j.id)).toEqual([job.id]);

    const cleared = await updateJob(user, job.id, { nextInterview: null, offerDeadline: null, url: null });
    expect(cleared).toMatchObject({ nextInterview: null, offerDeadline: null, url: null });
    expect((await keyColumns(job.id)).url_norm).toBeNull();

    const emptyRound = await updateJob(user, job.id, { nextInterview: { at: "2026-12-02T10:00:00.000Z", round: "" } });
    expect(emptyRound.nextInterview).toEqual({ at: "2026-12-02T10:00:00.000Z", round: "" });
  });

  it("refuses dates outside the years 1970-9999 with BadRequestError, and round-trips the edges", async () => {
    // All of these pass the schema (a year typed as "26" in the date picker is 0026). PostgreSQL
    // has no year 0 (22008, a 500), and postgres.js reads years 0001-0099 back as other dates.
    const user = await createUser();
    const job = await makeJob(user);
    const outside = ["0000-01-01T00:00:00Z", "0012-12-01T22:59:00.000Z", "0026-12-01T09:00:00.000Z", "1969-12-31T23:59:59.999Z"];
    for (const at of outside) {
      for (const [field, body] of [
        ["offerDeadline", { offerDeadline: at }],
        ["nextInterview.at", { nextInterview: { at, round: "" } }],
      ] as const) {
        const err = await updateJob(user, job.id, jobPatchSchema.parse(body)).catch((e: unknown) => e);
        expect(err, `${field} ${at}`).toBeInstanceOf(BadRequestError);
        expect((err as Error).message).toBe(`${field} is out of range`);
      }
    }
    expect(await loadJob(getDb(), user, job.id)).toMatchObject({ offerDeadline: null, nextInterview: null });

    for (const at of ["1970-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"]) {
      const dates = { offerDeadline: at, nextInterview: { at, round: "" } };
      expect(await updateJob(user, job.id, dates)).toMatchObject(dates);
      expect(await loadJob(getDb(), user, job.id)).toMatchObject(dates);
    }
  });

  it("answers 409 for a link another job already has, and keeps the job unchanged", async () => {
    const user = await createUser();
    await makeJob(user, { url: LINK, title: "One" });
    const other = await makeJob(user, { url: "https://example.com/jobs/2", title: "Two" });
    await expect(
      updateJob(user, other.id, { url: `${LINK}?utm_source=mail`, title: "Renamed" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await loadJob(getDb(), user, other.id)).toMatchObject({ title: "Two", url: "https://example.com/jobs/2" });

    // Its own link (in another spelling) is fine.
    const same = await updateJob(user, other.id, { url: "https://www.example.com/jobs/2/" });
    expect(same.url).toBe("https://www.example.com/jobs/2/");
  });

  /* -------------------------------------------------------------- delete */

  it("deletes a job with its history, keeps its emails unlinked, and leaves other jobs alone", async () => {
    const user = await createUser();
    const doomed = await makeJob(user, { title: "Doomed", status: "applied" });
    const kept = await makeJob(user, { title: "Kept", status: "applied" });
    await updateJob(user, kept.id, { status: "interview" });
    const emailId = await makeEmail(user, { jobId: doomed.id, outcome: "matched", reviewReason: null });
    // An event of the kept job that points at the doomed job's email.
    await testSql()`
      INSERT INTO job_status_events (user_id, job_id, from_status, to_status, source, email_id)
      VALUES (${user}, ${kept.id}, 'interview', 'offer', 'email', ${emailId})`;
    const keptHistory = (await loadJob(getDb(), user, kept.id)).history;

    await deleteJob(user, doomed.id);

    await expect(getJob(getDb(), user, doomed.id)).rejects.toBeInstanceOf(NotFoundError);
    const [email] = await testSql()`SELECT job_id FROM emails WHERE id = ${emailId}`;
    expect(email.job_id).toBeNull();
    const [{ count }] = await testSql()`SELECT count(*)::int AS count FROM job_status_events WHERE job_id = ${doomed.id}`;
    expect(count).toBe(0);
    expect((await loadJob(getDb(), user, kept.id)).history).toEqual(keptHistory);
    await expect(deleteJob(user, doomed.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  /* --------------------------------------------------------- list, read */

  it("lists by last activity with history and email counts, filtered by status", async () => {
    const user = await createUser();
    const a = await makeJob(user, { title: "A", status: "applied" });
    const b = await makeJob(user, { title: "B", status: "saved" });
    const c = await makeJob(user, { title: "C", status: "applied" });
    await ageJob(a.id, 3);
    await ageJob(b.id, 2);
    await ageJob(c.id, 1);
    await makeEmail(user, { jobId: a.id, outcome: "matched", reviewReason: null });
    await makeEmail(user, { jobId: a.id, outcome: "matched", reviewReason: null });
    await updateJob(user, b.id, { status: "applied" }); // b is now the most recent

    const list = await listJobs(getDb(), user);
    expect(list.map((j) => j.title)).toEqual(["B", "C", "A"]);
    expect(list.map((j) => j.emailCount)).toEqual([0, 0, 2]);
    expect(list[0].history.map((e) => e.to)).toEqual(["saved", "applied"]);

    expect((await listJobs(getDb(), user, { statuses: ["saved"] }))).toEqual([]);
    expect((await listJobs(getDb(), user, { statuses: ["applied", "offer"] })).map((j) => j.title)).toEqual(["B", "C", "A"]);

    const detail = await getJob(getDb(), user, a.id);
    expect(detail.emailCount).toBe(2);
    expect(detail.emails).toHaveLength(2);
  });

  it("returns a job's emails newest first", async () => {
    const user = await createUser();
    const job = await makeJob(user);
    const older = await makeEmail(user, { jobId: job.id, receivedAt: new Date("2026-11-01T10:00:00Z") });
    const newer = await makeEmail(user, { jobId: job.id, receivedAt: new Date("2026-11-03T10:00:00Z") });
    const detail = await getJob(getDb(), user, job.id);
    expect(detail.emails.map((e) => e.id)).toEqual([newer, older]);
    expect(detail.emails[0]).toMatchObject({ jobId: job.id, receivedAt: "2026-11-03T10:00:00.000Z" });
  });

  it("searches company and title, with LIKE wildcards taken literally", async () => {
    const user = await createUser();
    await makeJob(user, { company: "Müller Logistik", title: "100% Remote Engineer" });
    await makeJob(user, { company: "Acme", title: "Data_Engineer" });
    await makeJob(user, { company: "Acme", title: "Data Engineer" });
    await makeJob(user, { company: "Back\\slash", title: "Engineer" });
    const titles = async (q: string) => (await listJobs(getDb(), user, { q })).map((j) => j.title).sort();

    expect(await titles("%")).toEqual(["100% Remote Engineer"]);
    expect(await titles("_")).toEqual(["Data_Engineer"]);
    expect(await titles("data_")).toEqual(["Data_Engineer"]);
    expect(await titles("\\")).toEqual(["Engineer"]);
    expect(await titles("MULLER")).toEqual(["100% Remote Engineer"]);
    expect(await titles("acme data e")).toEqual(["Data Engineer"]);
    expect(await titles("   ")).toHaveLength(4);
  });

  it("searches with NUL characters without failing", async () => {
    // PostgreSQL text cannot hold U+0000 (22021): GET /api/jobs?q=%00 answered 500.
    const user = await createUser();
    await makeJob(user, { company: "Acme", title: "Data Engineer" });
    await makeJob(user, { company: "Bramble", title: "Designer" });
    const titles = async (q: string) => (await listJobs(getDb(), user, { q })).map((j) => j.title).sort();

    expect(await titles("\u0000")).toEqual(["Data Engineer", "Designer"]);
    expect(await titles("Engi\u0000neer")).toEqual(["Data Engineer"]);
    expect(await titles("\u0000nothing")).toEqual([]);
  });

  it("answers NotFoundError for malformed and unknown ids", async () => {
    const user = await createUser();
    const unknown = "0190a5b4-0000-7000-8000-000000000000";
    for (const id of ["not-a-uuid", "", "1; DROP TABLE jobs", unknown]) {
      await expect(getJob(getDb(), user, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(loadJob(getDb(), user, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(updateJob(user, id, { title: "x" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteJob(user, id)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  /* --------------------------------------------------------------- parse */

  it("finds the job a parsed link or text duplicates", async () => {
    const user = await createUser();
    const job = await makeJob(user, { url: LINK, company: "Parcelwerk", title: "Frontend Engineer" });

    const byLink = await parseInput(getDb(), user, `${LINK}?utm_source=newsletter`);
    expect(byLink.duplicateOf?.id).toBe(job.id);
    expect(byLink.duplicateOf?.history).toHaveLength(1);

    const byText = await parseInput(getDb(), user, "Title: Frontend Engineer\nCompany: Parcelwerk GmbH\nLocation: Berlin");
    expect(byText).toMatchObject({ title: "Frontend Engineer", company: "Parcelwerk GmbH", location: "Berlin" });
    expect(byText.duplicateOf?.id).toBe(job.id);

    const fresh = await parseInput(getDb(), user, "https://example.com/careers/product-designer");
    expect(fresh.duplicateOf).toBeNull();
  });
});
