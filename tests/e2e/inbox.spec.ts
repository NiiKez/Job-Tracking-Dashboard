// The inbox in demo mode (MAIL_SOURCE=fixture: the invented mail in fixtures/mail), from the
// owner's side: connecting and disconnecting it in Settings, "Sync now" and "Scan again", what a
// sync does to the board, the Email activity feed, and the mail a job shows in its detail page.
// The pipeline's decisions are unit tested; these tests check that the screens tell the owner
// what happened. Each test starts from an empty account and runs its own sync.
import type { Locator, Page } from "@playwright/test";
import type { Email, Job } from "@/lib/types";
import { expect, test, toasts } from "./support/fixtures";
import { checkDemoInbox, EMPTY_ACCOUNT, madeEarlier, stayOffline } from "./support/inbox";

test.beforeEach(async ({ context }) => {
  await stayOffline(context);
});

const inboxSettings = (page: Page) => page.getByRole("region", { name: "Inbox" });
// The sidebar has no landmark of its own, and Settings has a second "Sync now": its footer it is.
const sidebar = (page: Page) => page.locator("[data-sidebar=footer]");
const sidebarSync = (page: Page) => sidebar(page).getByRole("button", { name: "Sync now" });

/** A board column ("Applied", "Interview", …; Rejected sits inside "Closed"). */
function column(page: Page, name: string): Locator {
  const board = page.getByRole("region", { name: "Applications board" });
  if (name === "Rejected") return board.getByRole("region", { name: "Closed" }).getByRole("region", { name: "Rejected" });
  return board.getByRole("region", { name, exact: true });
}

/** The card (or Closed row) of a job: its open button is named "<company>, <title>. …". */
const card = (where: Locator, company: string, title: string) =>
  where.getByRole("button", { name: new RegExp(`^${escape(`${company}, ${title}.`)}`) });

/** An entry of the Email activity feed, found by the email's subject. */
const feedEntry = (page: Page, subject: string) =>
  page.getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: subject, exact: true }) });

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Connects the demo inbox by its address, as a typed URL does (the Connect link is tested on its
 * own), and waits until Settings has taken the result out of the address bar: a navigation
 * started before that is lost to the address change.
 */
async function connectDemoInbox(page: Page) {
  await page.goto("/api/inbox/connect");
  await expect(toasts(page).getByText("Inbox connected")).toBeVisible();
  await expect(page).toHaveURL("/settings");
}

async function jobNamed(api: { get<T>(path: string): Promise<T> }, company: string): Promise<Job> {
  const job = (await api.get<Job[]>("/api/jobs")).find((j) => j.company === company);
  if (!job) throw new Error(`no job at ${company}`);
  return job;
}

/* ------------------------------------------------------------ Settings */

test("Settings: Connect turns on the demo inbox without a trip to Google", async ({ page, account }) => {
  await page.goto("/settings");
  const inbox = inboxSettings(page);
  await expect(inbox.getByText("Not connected")).toBeVisible();
  await expect(inbox.getByText("Demo mode: syncing reads invented sample emails, not your Gmail.")).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Sync now" })).toBeDisabled();
  await expect(inbox.getByRole("button", { name: "Scan again" })).toBeDisabled();

  await inbox.getByRole("link", { name: "Connect" }).click();

  // Back on Settings, without the ?inbox=connected that brought the toast (a reload must not repeat it).
  await expect(toasts(page).getByText("Inbox connected")).toBeVisible();
  await expect(toasts(page).getByText(account.email)).toBeVisible();
  await expect(page).toHaveURL("/settings");
  await expect(inbox.getByText(account.email)).toBeVisible();
  await expect(inbox.getByText("Connected", { exact: true })).toBeVisible();
  await expect(inbox.getByText("Demo mail")).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await expect(inbox.getByRole("link", { name: "Connect" })).toHaveCount(0);
  // Connected, but nothing is read until someone asks: the scheduler is off in these tests.
  await expect(inbox.getByText("Not synced yet")).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Sync now" })).toBeEnabled();
  await expect(sidebar(page).getByText("Inbox connected")).toBeVisible();
});

test("Settings: Sync now reads the demo mail and sums up what it did", async ({ page, account }) => {
  await connectDemoInbox(page);
  const inbox = inboxSettings(page);
  await expect(inbox.getByText(account.email)).toBeVisible();

  await inbox.getByRole("button", { name: "Sync now" }).click();

  // 14 messages: 9 about a job (4 started an application, 5 wait for review), the rest not kept.
  await expect(toasts(page).getByText("Inbox checked")).toBeVisible();
  await expect(toasts(page).getByText("9 new emails · 4 updated a job · 5 need review")).toBeVisible();
  await expect(inbox.getByText("Not synced yet")).toHaveCount(0);
  await expect(inbox.getByRole("time")).toHaveText(/^\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
  await expect(page.getByLabel("5 emails to match")).toBeVisible(); // the sidebar's Needs review badge

  // The mailbox position is kept: a second sync finds nothing new and files nothing twice.
  await inbox.getByRole("button", { name: "Sync now" }).click();
  await expect(toasts(page).getByText("Inbox is up to date")).toBeVisible();
  await expect(toasts(page).getByText("No new job emails.")).toBeVisible();
  await expect(page.getByLabel("5 emails to match")).toBeVisible();
});

test("Settings: Disconnect stops syncing and keeps the filed mail; connecting again picks up where it left off", async ({
  page,
  api,
}) => {
  await checkDemoInbox(api);
  await page.goto("/settings");
  const inbox = inboxSettings(page);
  await expect(inbox.getByText("Connected", { exact: true })).toBeVisible();

  await inbox.getByRole("button", { name: "Disconnect" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Disconnect the inbox?" });
  // A demo inbox has no Google access to revoke, so the dialog doesn't promise to.
  await expect(dialog).toContainText("Syncing stops. Emails already filed stay, and connecting again picks up where it left off.");
  await dialog.getByRole("button", { name: "Disconnect" }).click();

  await expect(dialog).toBeHidden();
  await expect(toasts(page).getByText("Inbox disconnected")).toBeVisible();
  await expect(toasts(page).getByText("Syncing has stopped.")).toBeVisible();
  await expect(inbox.getByText("Not connected")).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Sync now" })).toBeDisabled();
  await expect(inbox.getByRole("button", { name: "Scan again" })).toBeDisabled();
  await expect(sidebar(page).getByText("Inbox not connected")).toBeVisible();
  await expect(sidebarSync(page)).toBeDisabled();

  // What the sync filed stays: the jobs it created and the mail waiting for review.
  await page.getByRole("link", { name: "Applications" }).click();
  await expect(card(column(page, "Applied"), "Driftwood Audio", "Frontend Engineer")).toBeVisible();
  await expect(page.getByLabel("5 emails to match")).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await inbox.getByRole("link", { name: "Connect" }).click();
  await expect(toasts(page).getByText("Inbox connected")).toBeVisible();
  await inbox.getByRole("button", { name: "Sync now" }).click();
  await expect(toasts(page).getByText("No new job emails.")).toBeVisible();
  expect(await api.get<Job[]>("/api/jobs")).toHaveLength(EMPTY_ACCOUNT.created.length);
});

test("Settings: Scan again reads mail the first sync passed over, now that its job exists", async ({ page, api }) => {
  // The Fernweh Mobility appointment mail names no role and fits no job, so the first sync
  // leaves it: it is not kept.
  await checkDemoInbox(api);
  const fernweh = await madeEarlier(api, { company: "Fernweh Mobility", title: "Full-Stack Developer", status: "applied" });
  await page.goto("/settings");
  const inbox = inboxSettings(page);

  await inbox.getByRole("button", { name: "Scan again" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Scan the mailbox again?" });
  await dialog.getByRole("button", { name: "Scan again" }).click();
  await expect(toasts(page).getByText("Scanning the mailbox again")).toBeVisible();

  await expect.poll(async () => (await api.get<Job>(`/api/jobs/${fernweh.id}`)).status).toBe("interview");
  await page.goto(`/jobs/${fernweh.id}`);
  const emails = page.getByRole("region", { name: /^Emails/ });
  await expect(emails.getByRole("button", { name: "Terminbestätigung: Ihr Vorstellungsgespräch am Dienstag" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Activity" }).getByText("Moved Applied to Interview")).toBeVisible();
  // Mail filed by the first sync is not filed again.
  await expect(page.getByLabel("5 emails to match")).toBeVisible();
  expect(await api.get<Job[]>("/api/jobs")).toHaveLength(EMPTY_ACCOUNT.created.length + 1);
});

/* --------------------------------------------------------------- board */

test("a sync from the sidebar puts the applications it found on the board", async ({ page, account }) => {
  await connectDemoInbox(page);
  await page.getByRole("link", { name: "Applications" }).click();
  await expect(page.getByText("Add your first job")).toBeVisible();
  await expect(sidebar(page)).toContainText(`Inbox connected${account.email}Not synced yet`);

  await sidebarSync(page).click();

  await expect(toasts(page).getByText("Inbox checked")).toBeVisible();
  // A confirmation starts an application as Applied; the first mail about an unknown application
  // starts it where that mail says (an invitation: Interview, a rejection: Rejected).
  await expect(card(column(page, "Applied"), "Driftwood Audio", "Frontend Engineer")).toBeVisible();
  await expect(card(column(page, "Interview"), "Juniper Learning", "Frontend Developer")).toBeVisible();
  await expect(card(column(page, "Interview"), "Kelpie Analytics", "Data Visualization Engineer")).toBeVisible();
  await expect(card(column(page, "Rejected"), "Orbit Payments", "Frontend Engineer, Checkout")).toBeVisible();
  await expect(page.getByRole("region", { name: "Emails to review" })).toContainText("5 emails need your review.");
  await expect(page.getByLabel("5 emails to match")).toBeVisible();
});

test("an interview invitation, a rejection and an offer move the applications you added", async ({ page, api }) => {
  await madeEarlier(api, { company: "Ember Finance", title: "Software Engineer", status: "applied" });
  await madeEarlier(api, { company: "Brightline Energy", title: "Softwareentwickler:in Web", status: "applied" });
  await madeEarlier(api, { company: "Nimbus Docs", title: "Product Engineer", status: "interview" });
  await page.goto("/");
  await expect(card(column(page, "Applied"), "Ember Finance", "Software Engineer")).toBeVisible();

  await checkDemoInbox(api);
  await page.reload();

  await expect(card(column(page, "Interview"), "Ember Finance", "Software Engineer")).toBeVisible();
  await expect(card(column(page, "Rejected"), "Brightline Energy", "Softwareentwickler:in Web")).toBeVisible();
  await expect(card(column(page, "Offer"), "Nimbus Docs", "Product Engineer")).toBeVisible();
  await expect(card(column(page, "Applied"), "Ember Finance", "Software Engineer")).toHaveCount(0);

  // The activity feed says which mail moved what.
  await page.goto("/activity?filter=changes");
  await expect(page.getByRole("tab", { name: "Status changes 3", selected: true })).toBeVisible();
  await expect(feedEntry(page, "Interview invitation: Software Engineer")).toContainText(/Applied\s*to\s*Interview/);
  await expect(feedEntry(page, "Ihre Bewerbung bei Brightline Energy")).toContainText(/Applied\s*to\s*Rejected/);
  await expect(feedEntry(page, "Your offer from Nimbus Docs – Product Engineer")).toContainText(/Interview\s*to\s*Offer/);
});

test("a status you set by hand is not moved by mail, but the mail is linked to the job", async ({ page, api }) => {
  const job = await madeEarlier(api, {
    company: "Brightline Energy",
    title: "Softwareentwickler:in Web",
    status: "interview",
    locked: true,
  });
  await checkDemoInbox(api);

  await page.goto("/");
  await expect(card(column(page, "Interview"), "Brightline Energy", "Softwareentwickler:in Web")).toBeVisible();

  await page.goto(`/jobs/${job.id}`);
  await expect(page.getByText("You set this status by hand, so emails won't change it.")).toBeVisible();
  const emails = page.getByRole("region", { name: "Emails 1" });
  await emails.getByRole("button", { name: "Ihre Bewerbung bei Brightline Energy" }).click();
  await expect(emails.getByText(/^Status stayed\s*Interview$/)).toBeVisible();
  // The history has no change from the mail: the last one is still yours.
  const timeline = page.getByRole("region", { name: "Activity" }).getByRole("listitem");
  await expect(timeline).toHaveCount(2);
  await expect(timeline.first()).toContainText("Moved Applied to Interview");
  await expect(timeline.first()).toContainText("Changed by you");
});

/* ---------------------------------------------------------- job detail */

test("job detail: the mail that moved a job is linked, and the timeline says it came from email", async ({
  page,
  api,
}) => {
  const job = await madeEarlier(api, { company: "Ember Finance", title: "Software Engineer", status: "applied" });
  await checkDemoInbox(api);
  await page.goto(`/jobs/${job.id}`);

  const details = page.getByRole("region", { name: "Details" });
  await expect(details.getByText("Interview", { exact: true })).toBeVisible();
  await expect(details.getByText("From an email")).toBeVisible();

  const emails = page.getByRole("region", { name: "Emails 1" });
  const item = emails.getByRole("listitem").filter({ hasText: "Ember Finance Talent" });
  await expect(emails.getByRole("listitem").filter({ hasText: "talent@" })).toHaveCount(1);
  await expect(item).toContainText("Status updated");
  const subject = item.getByRole("button", { name: "Interview invitation: Software Engineer" });
  await expect(subject).toHaveAttribute("aria-expanded", "false");

  const latest = page.getByRole("region", { name: "Activity" }).getByRole("listitem").first();
  await expect(latest).toContainText("Moved Applied to Interview");
  await expect(latest).toContainText("From an email");
  await latest.getByRole("button", { name: "View email" }).click();

  // "View email" opens that email in the list, with what it changed.
  await expect(subject).toHaveAttribute("aria-expanded", "true");
  await expect(item).toContainText("From Ember Finance Talent <talent@emberfinance.co.example>");
  await expect(item.getByText(/^This email moved the job from Applied\s*to\s*Interview$/)).toBeVisible();
});

test("job detail: a job the mail created shows the mail that started it", async ({ page, api }) => {
  await checkDemoInbox(api);
  const driftwood = await jobNamed(api, "Driftwood Audio");
  await page.goto(`/jobs/${driftwood.id}`);

  await expect(page.getByRole("heading", { level: 2, name: "Frontend Engineer" })).toBeVisible();
  const emails = page.getByRole("region", { name: "Emails 1" });
  await expect(emails).toContainText("New application");
  await emails.getByRole("button", { name: "Thank you for applying – Frontend Engineer" }).click();
  await expect(emails.getByText(/^This email added the job as\s*Applied$/)).toBeVisible();
  const timeline = page.getByRole("region", { name: "Activity" });
  await expect(timeline).toContainText("From an email · Created from a confirmation email");

  // The first mail about an application can be its rejection: created, then moved on.
  const orbit = await jobNamed(api, "Orbit Payments");
  await page.goto(`/jobs/${orbit.id}`);
  const orbitTimeline = page.getByRole("region", { name: "Activity" }).getByRole("listitem");
  await expect(orbitTimeline).toHaveCount(2);
  await expect(orbitTimeline.filter({ hasText: "Moved Applied to Rejected" })).toContainText("From an email");
  await expect(orbitTimeline.filter({ hasText: "Created from the first email about this application" })).toBeVisible();
});

// App bug: the timeline is "newest first" (status-timeline.tsx sorts by `at`, descending), but a
// job started by its rejection has both events at the mail's time, and the stable sort keeps
// them oldest first: "Applied" is listed above "Moved Applied → Rejected", as if it came after.
test.fixme("job detail: a job the mail created and closed lists the rejection above its start", async ({ page, api }) => {
  await checkDemoInbox(api);
  const orbit = await jobNamed(api, "Orbit Payments");
  await page.goto(`/jobs/${orbit.id}`);
  const timeline = page.getByRole("region", { name: "Activity" }).getByRole("listitem");
  await expect(timeline.first()).toContainText("Moved Applied to Rejected");
  await expect(timeline.last()).toContainText("Created from the first email about this application");
});

/* ------------------------------------------------------- Email activity */

test("Email activity: every job email by day, with what it did and a filter for each outcome", async ({ page, api }) => {
  await checkDemoInbox(api);
  await page.goto("/activity");

  const tabs = page.getByRole("tablist", { name: "Filter email activity" });
  await expect(tabs.getByRole("tab", { name: "All 9", selected: true })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "Status changes 0" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "New applications 4" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "Needs review 5" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "Ignored 0" })).toBeVisible();
  await expect(page.getByText(/Demo mail · connected/)).toBeVisible();

  const quillmark = feedEntry(page, "Next steps with Quillmark");
  await expect(quillmark).toContainText(/Waiting for your review\s*· No matching job/);
  await quillmark.getByRole("button", { name: "Show email" }).click();
  await expect(quillmark).toContainText("with our team lead to continue the conversation");

  await tabs.getByRole("tab", { name: /^New applications/ }).click();
  await expect(page).toHaveURL("/activity?filter=created");
  await expect(page.getByRole("article")).toHaveCount(EMPTY_ACCOUNT.created.length);
  const driftwood = feedEntry(page, "Thank you for applying – Frontend Engineer");
  await expect(driftwood).toContainText("Created a new application");
  await driftwood.getByRole("link", { name: /Driftwood Audio/ }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 2, name: "Frontend Engineer" })).toBeVisible();

  await page.goto("/activity?filter=review");
  await expect(page.getByRole("article")).toHaveCount(EMPTY_ACCOUNT.review.length);
  await feedEntry(page, "Next steps with Quillmark").getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL("/review");
  await expect(page.getByRole("article", { name: "Next steps with Quillmark" })).toBeVisible();
});

test("Email activity: Sync inbox now on the empty feed fills it", async ({ page, account }) => {
  await connectDemoInbox(page);
  await page.getByRole("link", { name: "Email activity" }).click();
  const feed = page.getByRole("tabpanel");
  await expect(feed.getByText("No email activity yet")).toBeVisible();
  // Settings, the page before, stays in the document, hidden, and shows the address too.
  await expect(page.getByRole("main").getByText(account.email).filter({ visible: true })).toBeVisible();

  await feed.getByRole("button", { name: "Sync inbox now" }).click();

  await expect(page.getByRole("tab", { name: "All 9" })).toBeVisible();
  await expect(feedEntry(page, "Thank you for applying – Frontend Engineer")).toBeVisible();
  await expect(page.getByText(/Last synced \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}/).first()).toBeVisible();
});

// App bug: the summary toast never shows when the sync is started from an empty feed (or the
// empty review list). useCheckInbox's onSettled waits for the refetch, the refetched mail
// replaces the empty state that holds the button, and TanStack Query drops the callbacks passed
// to mutate() of an unmounted observer, so useRunInboxCheck's toast is never called.
test.fixme("Email activity: Sync inbox now on the empty feed says what it found", async ({ page, account }) => {
  await connectDemoInbox(page);
  await page.goto("/activity");
  const feed = page.getByRole("tabpanel");
  await expect(feed.getByText("No email activity yet")).toBeVisible();
  await expect(page.getByRole("main").getByText(account.email)).toBeVisible();
  await feed.getByRole("button", { name: "Sync inbox now" }).click();
  await expect(page.getByRole("tab", { name: "All 9" })).toBeVisible();
  await expect(toasts(page).getByText("9 new emails · 4 updated a job · 5 need review")).toBeVisible();
});

// App bug: after a full page load the header's "Sync inbox now" (CheckInboxButton) is sometimes
// stuck disabled while the inbox is connected: the server renders it disabled (no settings yet),
// and when /api/settings has answered before the header hydrates, the hydration render says
// enabled; React keeps the server's `disabled` attribute and later renders don't touch it
// (DOM disabled, React props disabled=false; 3 of 8 loads here). The sidebar's button waits for
// hydration (useHydrated) and isn't affected.
test.fixme("Email activity: the header's Sync inbox now is usable after every page load", async ({ page, api }) => {
  await checkDemoInbox(api);
  for (let load = 0; load < 6; load++) {
    await page.goto("/activity");
    await expect(page.getByRole("tab", { name: "All 9" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: "Sync inbox now" })).toBeEnabled();
  }
});

test("mail that isn't about a job (a newsletter, a job alert, a friend's mail) is shown nowhere", async ({ page, api }) => {
  await checkDemoInbox(api);

  const kept = await api.get<Email[]>("/api/emails");
  expect(kept.map((e) => e.subject).sort()).toEqual(
    [...EMPTY_ACCOUNT.created.map((c) => c.subject), ...EMPTY_ACCOUNT.review].sort(),
  );

  await page.goto("/activity?filter=ignored");
  await expect(page.getByText("Nothing ignored")).toBeVisible();

  // Each screen once its data is in: the feed, the review list, the board.
  const screens: Array<[string, Locator]> = [
    ["/activity", page.getByRole("tab", { name: "All 9" })],
    ["/review", page.getByText("5 emails waiting")],
    ["/", card(column(page, "Applied"), "Driftwood Audio", "Frontend Engineer")],
  ];
  for (const [path, loaded] of screens) {
    await page.goto(path);
    await expect(loaded).toBeVisible();
    for (const text of [...EMPTY_ACCOUNT.notJobMail, "JobRadar", "Frontend Weekly", "Sam Rivera"]) {
      await expect(page.getByText(text), `${text} on ${path}`).toHaveCount(0);
    }
  }
});
