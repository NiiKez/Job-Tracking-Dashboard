// Settings → Test an email (the rule tester): an email pasted or picked from the samples goes
// through the same pipeline as the inbox (POST /api/classify), with the account's own rules,
// jobs and settings, and nothing is stored. It is how a user checks a new keyword before
// trusting it with real mail, so the tests compare what it shows with what the pipeline decides.
import type { Job } from "@/lib/types";
import { db } from "./support/db";
import {
  addKeyword,
  expect,
  openSettings,
  pick,
  removeButton,
  resultRow,
  ruleGroup,
  settingsSection,
  test,
  testedEmail,
  testerForm,
} from "./support/settings-page";

test("a sample email shows the status, the matched phrases and what would happen", async ({ page, account }) => {
  await openSettings(page);
  const form = testerForm(page);
  const section = settingsSection(page, "Test an email");
  await expect(section.getByText("The result appears here")).toBeVisible();

  await pick(page, form.getByLabel("Try an example"), "Interview invite (EN)");
  await expect(form.getByLabel("Subject")).toHaveValue("Next steps for the Senior Frontend Engineer role");
  await expect(form.getByLabel("From address (optional)")).toHaveValue("talent@northwindlabs.example");

  // No job in the dashboard: the invitation would start one, in Interview.
  await expect(section.getByText("New application", { exact: true })).toBeVisible();
  await expect(
    section.getByText(
      "Would add Northwind Labs · Senior Frontend Engineer as a new application marked Interview, because no job in the dashboard matches.",
    ),
  ).toBeVisible();
  await expect(resultRow(page, "Detected status")).toHaveText(/^Interview\s*Language: English$/);
  // Matched phrases are grouped by the status they point to.
  const byStatus = resultRow(page, "Matched keywords").getByRole("listitem").filter({ has: page.getByRole("list") });
  await expect(byStatus).toHaveText([/^Interview\s*interview\s*availability$/]);
  await expect(resultRow(page, "Candidate jobs")).toHaveText("No application matches the sender or wording.");
  await expect(testedEmail(page).locator("mark")).toHaveText(["interview", "availability"]);

  // A test changes nothing.
  const [{ jobs, emails }] = await db()<{ jobs: number; emails: number }[]>`
    SELECT (SELECT count(*)::int FROM jobs WHERE user_id = ${account.userId}) AS jobs,
           (SELECT count(*)::int FROM emails WHERE user_id = ${account.userId}) AS emails`;
  expect({ jobs, emails }).toEqual({ jobs: 0, emails: 0 });
});

test("an email that is not about an application is ignored", async ({ page }) => {
  await openSettings(page);
  const section = settingsSection(page, "Test an email");
  await pick(page, testerForm(page).getByLabel("Try an example"), "Newsletter");

  await expect(section.getByText("Ignored", { exact: true })).toBeVisible();
  await expect(section.getByText("Would be ignored: not enough in it points to a job application.")).toBeVisible();
  await expect(resultRow(page, "Detected status")).toHaveText(/^No status\s*Language: English$/);
  await expect(resultRow(page, "Matched keywords")).toHaveText("None. Add a phrase above if this email should count.");
  await expect(testedEmail(page).locator("mark")).toHaveCount(0);
});

test("a pasted reply is matched to the job it is about, without changing the job", async ({ page, api }) => {
  const job = await api.createJob({ title: "Full-Stack Developer", company: "Fernweh Mobility", status: "applied" });
  await openSettings(page);
  const form = testerForm(page);
  const section = settingsSection(page, "Test an email");
  const testButton = form.getByRole("button", { name: "Test", exact: true });

  await expect(testButton).toBeDisabled();
  await expect(form.getByText("Add a subject or body first.")).toBeVisible();
  await form.getByLabel("From address (optional)").fill("jobs@fernweh-mobility.example");
  await form.getByLabel("Subject").fill("Ihre Bewerbung als Full-Stack Developer");
  await expect(testButton).toBeEnabled();
  await form
    .getByLabel("Body")
    .fill(
      "Guten Tag,\n\nleider haben wir uns für einen der anderen Kandidaten entschieden.\n\nMit freundlichen Grüßen\nFernweh Mobility",
    );
  await testButton.click();

  await expect(section.getByText("Status updated", { exact: true })).toBeVisible();
  await expect(
    section.getByText("Would move Fernweh Mobility · Full-Stack Developer from Applied to Rejected."),
  ).toBeVisible();
  await expect(resultRow(page, "Detected status")).toHaveText(/^Rejected\s*Language: German$/);
  const best = resultRow(page, "Candidate jobs").getByRole("link");
  await expect(best).toHaveCount(1);
  await expect(best).toContainText("Fernweh Mobility · Full-Stack Developer");
  await expect(best).toContainText("Best match");
  await expect(best).toHaveAttribute("href", `/?job=${job.id}`);
  // The phrase is marked as the email writes it, not as the rule does.
  await expect(testedEmail(page).locator("mark")).toHaveText(["anderen Kandidaten"]);

  const jobs = await api.get<Job[]>("/api/jobs");
  expect(jobs.map((j) => [j.id, j.status, j.emailCount])).toEqual([[job.id, "applied", 0]]);
});

test("a keyword added above changes the result at once, and removing it changes it back", async ({ page, api }) => {
  await api.createJob({ title: "Product Designer", company: "Quillbrook", status: "applied" });
  await openSettings(page);
  const form = testerForm(page);
  const section = settingsSection(page, "Test an email");
  await form.getByLabel("From address (optional)").fill("team@quillbrook.example");
  await form.getByLabel("Subject").fill("Quillbrook: an update on your application");
  await form.getByLabel("Body").fill("Hello,\n\nthe hiring team has chosen someone else for the role.\n\nKind regards");
  await form.getByRole("button", { name: "Test", exact: true }).click();

  // The job is clear, the meaning is not: no rule knows this wording yet.
  await expect(section.getByText("Needs review", { exact: true })).toBeVisible();
  await expect(resultRow(page, "Review reason")).toHaveText(
    /^No keyword found\s*The job is clear, but no keyword rule says what the email means\.$/,
  );
  await expect(resultRow(page, "Detected status")).toHaveText(/^No status\s*Language: English$/);

  await addKeyword(page, "chosen someone else", { status: "rejected" });
  await expect(removeButton(ruleGroup(page, "rejected"), "chosen someone else")).toBeVisible();

  // No second click on Test: the tester runs again when the rules change.
  await expect(section.getByText("Status updated", { exact: true })).toBeVisible();
  await expect(section.getByText("Would move Quillbrook · Product Designer from Applied to Rejected.")).toBeVisible();
  await expect(resultRow(page, "Review reason")).toHaveCount(0);
  await expect(testedEmail(page).locator("mark")).toHaveText(["chosen someone else"]);

  await removeButton(ruleGroup(page, "rejected"), "chosen someone else").click();
  await expect(section.getByText("Needs review", { exact: true })).toBeVisible();
  await expect(testedEmail(page).locator("mark")).toHaveCount(0);
});

test("keywords of two stages in one email send it to review", async ({ page, api }) => {
  await api.createJob({ title: "Data Analyst", company: "Lindenquay", status: "applied" });
  await openSettings(page);
  const form = testerForm(page);
  const section = settingsSection(page, "Test an email");
  await form.getByLabel("From address (optional)").fill("people@lindenquay.example");
  await form.getByLabel("Subject").fill("Your interview with Lindenquay");
  await form.getByLabel("Body").fill("Unfortunately we have to cancel the interview.");
  await form.getByRole("button", { name: "Test", exact: true }).click();

  await expect(section.getByText("Needs review", { exact: true })).toBeVisible();
  await expect(section.getByText("Would go to Needs review, so you decide what it means.")).toBeVisible();
  await expect(resultRow(page, "Review reason")).toHaveText(
    /^Keywords disagree\s*Keywords for more than one status were found in this email\.$/,
  );
  const byStatus = resultRow(page, "Matched keywords").getByRole("listitem").filter({ has: page.getByRole("list") });
  await expect(byStatus).toHaveCount(2);
  await expect(byStatus.nth(0)).toHaveText(/^Interview\s*interview$/);
  await expect(byStatus.nth(1)).toHaveText(/^Rejected\s*unfortunately$/);
  await expect(resultRow(page, "Candidate jobs")).toContainText("Lindenquay · Data Analyst");
});

test("editing a tested email marks the result as out of date until it is tested again", async ({ page }) => {
  await openSettings(page);
  const form = testerForm(page);
  const section = settingsSection(page, "Test an email");
  await pick(page, form.getByLabel("Try an example"), "Newsletter");
  await expect(section.getByText("Ignored", { exact: true })).toBeVisible();

  const body = form.getByLabel("Body");
  await body.press("End");
  await body.pressSequentially(" We would like to invite you to an interview about your application.");
  await expect(section.getByText("You edited the email. Test again to update.")).toBeVisible();
  // The picker lets go of the sample once it is edited.
  await expect(form.getByLabel("Try an example")).toHaveText("Pick a sample email");

  await body.press("Control+Enter");
  await expect(section.getByText("You edited the email. Test again to update.")).toBeHidden();
  await expect(section.getByText("Needs review", { exact: true })).toBeVisible();
  await expect(resultRow(page, "Review reason")).toHaveText(/^No matching job/);
  await expect(testedEmail(page).locator("mark")).toHaveText(["interview"]);
});
