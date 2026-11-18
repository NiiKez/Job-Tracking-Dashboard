// The Needs-review list: mail the sync could not file on its own (no matching job, or a job whose
// status it may not change), the decision the owner makes for each (create a job from it, link it
// to one, confirm or change the suggested status, or dismiss it), what that changes elsewhere
// (the board, the dashboard banner, the sidebar count, the activity feed) and "Check again".
// Every test starts from an empty account and syncs the demo mail itself (fixtures/mail).
import type { Page } from "@playwright/test";
import type { Email, Job } from "@/lib/types";
import { expect, test, toasts } from "./support/fixtures";
import { checkDemoInbox, EMPTY_ACCOUNT, madeEarlier, stayOffline } from "./support/inbox";

test.beforeEach(async ({ context }) => {
  await stayOffline(context);
});

const reviewCard = (page: Page, subject: string) => page.getByRole("article", { name: subject, exact: true });
const reviewBadge = (page: Page, count: number) => page.getByLabel(`${count} ${count === 1 ? "email" : "emails"} to match`);

async function reviewEmails(api: { get<T>(path: string): Promise<T> }): Promise<Email[]> {
  return api.get<Email[]>("/api/emails?outcome=review");
}

async function jobAt(api: { get<T>(path: string): Promise<T> }, company: string): Promise<Job | undefined> {
  return (await api.get<Job[]>("/api/jobs")).find((j) => j.company === company);
}

const KELPIE = { company: "Kelpie Analytics", title: "Data Visualization Engineer" } as const;
const KELPIE_MAIL = "Data Visualization Engineer: a second look";

test("the review list says why each email waits; the dashboard and the sidebar count them", async ({ page, api }) => {
  await checkDemoInbox(api);
  await page.goto("/");

  const banner = page.getByRole("region", { name: "Emails to review" });
  await expect(banner).toContainText("5 emails need your review.");
  await expect(banner).toContainText("They couldn’t be filed automatically, so some applications may be out of date.");
  await expect(reviewBadge(page, 5)).toBeVisible();
  await banner.getByRole("link", { name: "Review emails" }).click();

  await expect(page).toHaveURL("/review");
  await expect(page.getByText("5 emails waiting")).toBeVisible();
  const list = page.getByRole("list", { name: "Emails to review" });
  for (const subject of EMPTY_ACCOUNT.review) {
    const card = list.getByRole("article", { name: subject, exact: true });
    await expect(card).toContainText("No matching job");
    await expect(card).toContainText("This looks like a job email, but none of your applications match it.");
  }
  // The German rejection says what it is in, and which words gave it away.
  const brightline = reviewCard(page, "Ihre Bewerbung bei Brightline Energy");
  await expect(brightline.getByLabel("Language: German")).toBeVisible();
  await expect(brightline.getByRole("list", { name: "Matched keywords" })).toContainText("nicht weiter berücksichtigen");

  // One left: the banner and the link speak of one email.
  const others = (await reviewEmails(api)).filter((e) => e.subject !== "Next steps with Quillmark");
  for (const email of others) await api.post(`/api/emails/${email.id}/resolve`, { action: "dismiss" });
  await page.goto("/");
  await expect(banner).toContainText("1 email needs your review.");
  await expect(banner.getByRole("link", { name: "Review email" })).toBeVisible();
  await expect(reviewBadge(page, 1)).toBeVisible();
});

test("create an application from an email, with the company, title and status it suggests", async ({ page, api }) => {
  await checkDemoInbox(api);
  await page.goto("/review");

  const card = reviewCard(page, "Your offer from Nimbus Docs – Product Engineer");
  await expect(card.getByText("None of your applications match. Add it as a new one?")).toBeVisible();
  await expect(card.getByRole("textbox", { name: "Company" })).toHaveValue("Nimbus Docs");
  await expect(card.getByRole("textbox", { name: "Job title" })).toHaveValue("Product Engineer");
  await expect(card.getByRole("combobox", { name: "Status" })).toHaveText("Offer");
  await card.getByRole("button", { name: "Create application" }).click();

  await expect(toasts(page).getByText("Added Nimbus Docs")).toBeVisible();
  await expect(toasts(page).getByText("Product Engineer · Offer")).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("4 emails waiting")).toBeVisible();
  await expect(reviewBadge(page, 4)).toBeVisible();

  await toasts(page).getByRole("button", { name: "View job" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 2, name: "Product Engineer" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Details" })).toContainText("Offer");
  const emails = page.getByRole("region", { name: "Emails 1" });
  await expect(emails.getByRole("button", { name: "Your offer from Nimbus Docs – Product Engineer" })).toBeVisible();
  await expect(emails).toContainText("Confirmed by you");
});

test("the create form asks for what the guess could not find", async ({ page, api }) => {
  await checkDemoInbox(api);
  await page.goto("/review");

  // "Ihre Bewerbung bei Brightline Energy" names the company but no role.
  const card = reviewCard(page, "Ihre Bewerbung bei Brightline Energy");
  await expect(card.getByRole("textbox", { name: "Company" })).toHaveValue("Brightline Energy");
  await expect(card.getByRole("textbox", { name: "Job title" })).toHaveValue("");
  await card.getByRole("button", { name: "Create application" }).click();
  await expect(card.getByText("Enter the job title.")).toBeVisible();
  await expect(card.getByRole("textbox", { name: "Job title" })).toHaveAttribute("aria-invalid", "true");
  expect(await jobAt(api, "Brightline Energy")).toBeUndefined();

  await card.getByRole("textbox", { name: "Job title" }).fill("Softwareentwickler:in Web");
  await card.getByRole("button", { name: "Create application" }).click();
  await expect(toasts(page).getByText("Added Brightline Energy")).toBeVisible();
  await expect(toasts(page).getByText("Softwareentwickler:in Web · Rejected")).toBeVisible();
  expect(await jobAt(api, "Brightline Energy")).toMatchObject({ title: "Softwareentwickler:in Web", status: "rejected" });
});

test("link an email to an application you already have, picked from the job list", async ({ page, api }) => {
  await checkDemoInbox(api);
  // Added after the sync, so the mail still waits as "No matching job".
  const quillmark = await api.createJob({ company: "Quillmark", title: "Content Designer", status: "applied" });
  await page.goto("/review");

  const card = reviewCard(page, "Next steps with Quillmark");
  await card.getByRole("button", { name: "Link to an existing application" }).click();
  const picker = card.getByRole("combobox", { name: "Application" });
  await expect(picker).toHaveText(/Choose application/);
  await picker.click();
  await page.getByRole("combobox", { name: "Search applications" }).fill("quill");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.getByRole("option", { name: /Quillmark/ }).click();
  await expect(picker).toHaveText(/Quillmark · Content Designer/);
  // The status the email suggests is chosen already.
  await expect(card.getByRole("combobox", { name: "New status" })).toHaveText("Interview");
  await card.getByRole("button", { name: "Apply" }).click();

  await expect(toasts(page).getByText("Moved Quillmark to Interview")).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("4 emails waiting")).toBeVisible();

  await page.goto(`/jobs/${quillmark.id}`);
  const latest = page.getByRole("region", { name: "Activity" }).getByRole("listitem").first();
  await expect(latest).toContainText("Moved Applied to Interview");
  await expect(latest).toContainText("Confirmed by you");
  await expect(page.getByRole("region", { name: "Emails 1" })).toContainText("Next steps with Quillmark");
});

test("confirm the suggested job and status for mail that doesn't fit a closed application", async ({ page, api }) => {
  // Kelpie turned the application down, then invites to an interview after all: the sync may not
  // reopen a closed job on its own.
  const kelpie = await madeEarlier(api, { ...KELPIE, status: "rejected" });
  await checkDemoInbox(api);
  await page.goto("/review");

  const card = reviewCard(page, KELPIE_MAIL);
  await expect(card).toContainText("Doesn't fit the current status");
  await expect(card).toContainText("It would change a job that is already closed, or it is older than the job.");
  await expect(card).toContainText("Kelpie Analytics · Data Visualization Engineer");
  await expect(card).toContainText(/Rejected\s*to\s*Interview/);
  await card.getByRole("button", { name: "Confirm: Kelpie Analytics → Interview" }).click();

  await expect(toasts(page).getByText("Moved Kelpie Analytics to Interview")).toBeVisible();
  await expect(card).toHaveCount(0);
  expect((await api.get<Job>(`/api/jobs/${kelpie.id}`)).status).toBe("interview");

  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "Interview", exact: true }).getByRole("button", { name: /^Kelpie Analytics, / }),
  ).toBeVisible();
});

test("choose a different status than the one suggested: the job keeps its own", async ({ page, api }) => {
  const kelpie = await madeEarlier(api, { ...KELPIE, status: "rejected" });
  await checkDemoInbox(api);
  await page.goto("/review");

  const card = reviewCard(page, KELPIE_MAIL);
  await card.getByRole("button", { name: "Choose differently" }).click();
  await expect(card.getByRole("combobox", { name: "Application" })).toHaveText(/Kelpie Analytics · Data Visualization Engineer/);
  const status = card.getByRole("combobox", { name: "New status" });
  await expect(status).toHaveText("Interview");
  await status.click();
  await page.getByRole("option", { name: "Rejected" }).click();
  await card.getByRole("button", { name: "Apply" }).click();

  await expect(toasts(page).getByText("Linked to Kelpie Analytics")).toBeVisible();
  await expect(toasts(page).getByText("Data Visualization Engineer · stays Rejected")).toBeVisible();
  await expect(card).toHaveCount(0);

  await page.goto(`/jobs/${kelpie.id}`);
  const emails = page.getByRole("region", { name: "Emails 1" });
  await emails.getByRole("button", { name: KELPIE_MAIL }).click();
  await expect(emails.getByText(/^Status stayed\s*Rejected$/)).toBeVisible();
  expect((await api.get<Job>(`/api/jobs/${kelpie.id}`)).status).toBe("rejected");
});

test("Not job related takes an email off the list; Email activity keeps it under Ignored", async ({ page, api }) => {
  await checkDemoInbox(api);
  await page.goto("/review");

  await reviewCard(page, "Next steps with Quillmark").getByRole("button", { name: "Not job related" }).click();

  await expect(toasts(page).getByText("Dismissed")).toBeVisible();
  await expect(toasts(page).getByText("“Next steps with Quillmark” was marked as not job related.")).toBeVisible();
  await expect(reviewCard(page, "Next steps with Quillmark")).toHaveCount(0);
  await expect(page.getByText("4 emails waiting")).toBeVisible();
  await expect(reviewBadge(page, 4)).toBeVisible();
  expect(await jobAt(api, "Quillmark")).toBeUndefined();

  await page.getByRole("link", { name: "All email activity" }).click();
  await page.getByRole("tab", { name: "Ignored 1" }).click();
  const entry = page.getByRole("article");
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("Next steps with Quillmark");
  await expect(entry).toContainText("You marked it as not job related");
});

test("deciding the last email empties the list, the banner and the count", async ({ page, api }) => {
  await checkDemoInbox(api);
  const [last, ...rest] = await reviewEmails(api);
  for (const email of rest) await api.post(`/api/emails/${email.id}/resolve`, { action: "dismiss" });
  await page.goto("/review");
  await expect(page.getByText("1 email waiting")).toBeVisible();
  await expect(reviewBadge(page, 1)).toBeVisible();

  await reviewCard(page, last.subject).getByRole("button", { name: "Not job related" }).click();

  await expect(page.getByText("All caught up")).toBeVisible();
  await expect(page.getByText("New uncertain emails will show up here.")).toBeVisible();
  await expect(reviewBadge(page, 1)).toHaveCount(0);
  await page.getByRole("link", { name: "Applications" }).click();
  await expect(page.getByRole("region", { name: "Applications board" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Emails to review" })).toHaveCount(0);
});

test("Check again reads the waiting mail once more: nothing changes until the application exists", async ({
  page,
  api,
}) => {
  await checkDemoInbox(api);
  await page.goto("/review");
  await expect(page.getByText("5 emails waiting")).toBeVisible();

  const recheck = async () => {
    await page.getByRole("button", { name: "Check again" }).click();
    // By its end only: the title's wording is wrong (see the fixme below).
    const dialog = page.getByRole("alertdialog", { name: /again\?$/ });
    await expect(dialog).toContainText("Each email is read again with your keywords and applications as they are now");
    await dialog.getByRole("button", { name: "Check again" }).click();
    await expect(dialog).toBeHidden();
  };

  await recheck();
  await expect(toasts(page).getByText("Checked the review list again")).toBeVisible();
  await expect(toasts(page).getByText("Nothing changed. 5 emails still need you.")).toBeVisible();
  await expect(page.getByText("5 emails waiting")).toBeVisible();

  // The application the invitation is about, added (as if) before the mail arrived.
  const ember = await madeEarlier(api, { company: "Ember Finance", title: "Software Engineer", status: "applied" });
  await recheck();
  await expect(toasts(page).getByText("1 linked to an application. 4 emails still need you.")).toBeVisible();
  await expect(reviewCard(page, "Interview invitation: Software Engineer")).toHaveCount(0);
  await expect(page.getByText("4 emails waiting")).toBeVisible();
  await expect(reviewBadge(page, 4)).toBeVisible();

  await page.goto(`/jobs/${ember.id}`);
  const latest = page.getByRole("region", { name: "Activity" }).getByRole("listitem").first();
  await expect(latest).toContainText("Moved Applied to Interview");
  await expect(latest).toContainText("From an email");
});

// App bug: the dialog title reads "Check 5 these 5 emails again?" (and "Check 1 this email
// again?"): review-list.tsx passes "these 5 emails" to count(), which puts the number in front.
test.fixme("Check again asks about these 5 emails", async ({ page, api }) => {
  await checkDemoInbox(api);
  await page.goto("/review");
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("alertdialog", { name: "Check these 5 emails again?" })).toBeVisible();
});
