// Helpers for the inbox, review and activity specs: checking the demo mail (fixtures/mail) and
// making jobs that the demo mail can move.
//
// The demo mail is dated a few days before now (the newest message within the last 24 hours, see
// fixtures/mail/README.md). The pipeline never moves a job with mail older than the job
// (src/lib/inbox/pipeline/decide.ts: such mail goes to review as "Doesn't fit the current
// status"), so a job a test makes "now" has to be moved back in time first: madeEarlier().
import type { BrowserContext } from "@playwright/test";
import type { Job, Settings, Status } from "@/lib/types";
import { db } from "./db";
import { expect, type Api } from "./fixtures";
import { BASE_URL } from "./settings";

/**
 * Aborts every request a page makes off the e2e server. Demo mode never sends the browser to
 * Google, but outside it Connect and Reconnect are links to Google's consent screen, so such a
 * regression fails here at once. (A server redirect's hops never reach page.route(); those fail
 * at the browser's resolver, which playwright.config.ts limits to the e2e server.)
 */
export async function stayOffline(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => /^(https?|wss?):$/.test(url.protocol) && url.origin !== BASE_URL,
    (route) => route.abort("blockedbyclient"),
  );
}

/**
 * "Check inbox now" through the API, as the browser's button does. In demo mode the check first
 * connects the demo inbox. The route waits up to 20 s and answers `state: "running"` when the
 * sync is not done by then; the sync goes on, so wait until Settings no longer says it is syncing.
 */
export async function checkDemoInbox(api: Api): Promise<void> {
  const res = await api.post<{ state: "done" | "running" }>("/api/inbox/check");
  if (res.state === "running") {
    await expect
      .poll(async () => (await api.get<Settings>("/api/settings")).inbox, { timeout: 60_000 })
      .toMatchObject({ syncing: false, backfill: null });
  }
}

/**
 * A job as if it had been added `days` ago (default 14: before every demo mail, and well inside
 * the 30 days after which an applied job counts as "no response"). Statuses other than saved and
 * applied are set with a PATCH, as a change by hand; `locked` says whether that change keeps
 * mail from moving the job (a change by hand locks it in the app; here it is explicit).
 */
export async function madeEarlier(
  api: Api,
  job: { company: string; title: string; status: Status; locked?: boolean },
  days = 14,
): Promise<Job> {
  const created = await api.createJob({
    company: job.company,
    title: job.title,
    status: job.status === "saved" ? "saved" : "applied",
  });
  if (!["saved", "applied"].includes(job.status) || job.locked) {
    await api.patch(`/api/jobs/${created.id}`, {
      ...(job.status !== created.status ? { status: job.status } : {}),
      statusLocked: job.locked ?? false,
    });
  }
  const sql = db();
  const shift = sql`make_interval(days => ${days})`;
  await sql`
    UPDATE jobs SET created_at = created_at - ${shift}, applied_at = applied_at - ${shift},
      updated_at = updated_at - ${shift}, last_activity_at = last_activity_at - ${shift}
    WHERE id = ${created.id}`;
  await sql`UPDATE job_status_events SET at = at - ${shift} WHERE job_id = ${created.id}`;
  return api.get<Job>(`/api/jobs/${created.id}`);
}

/**
 * What the demo mail does to an account with no jobs (default settings and keyword rules), as the
 * first check found it. Subjects as the app shows them (encoded words decoded).
 */
export const EMPTY_ACCOUNT = {
  /** Jobs the check creates, with the status they end in. */
  created: [
    { company: "Driftwood Audio", title: "Frontend Engineer", status: "applied", subject: "Thank you for applying – Frontend Engineer" },
    { company: "Juniper Learning", title: "Frontend Developer", status: "interview", subject: "Juniper Learning: Interview invitation for Frontend Developer" },
    { company: "Kelpie Analytics", title: "Data Visualization Engineer", status: "interview", subject: "Data Visualization Engineer: a second look" },
    { company: "Orbit Payments", title: "Frontend Engineer, Checkout", status: "rejected", subject: "Your application for Frontend Engineer, Checkout" },
  ],
  /** Mail that waits in Needs review as "No matching job". */
  review: [
    "Interview invitation: Software Engineer",
    "Ihre Bewerbung bei Brightline Energy",
    "Your offer from Nimbus Docs – Product Engineer",
    "Interview invitation – Product Engineer (React)",
    "Next steps with Quillmark",
  ],
  /** Mail that is not about a job (a job alert, a newsletter, a friend's mail): kept nowhere. */
  notJobMail: [
    "12 new jobs match your search",
    "Frontend Weekly #87: 7 interview questions about React Server Components",
    "AW: Abendessen am Samstag",
  ],
} as const;
