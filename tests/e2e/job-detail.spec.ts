// The job detail page (/jobs/[id]) and the same view in the dashboard's side sheet: the facts,
// the description, editing the fields (with validation, and a link another job already has),
// a status change by hand with its timeline entry and lock, the interview date that the board
// card then shows, and deleting with its confirmation.
import type { Job } from "@/lib/types";
import { expect, test } from "./support/fixtures";
import { card, column, INVALID_LINK, toast } from "./support/jobs";

test("the page shows the job's link, facts, description and history", async ({ page, api }) => {
  const job = await api.createJob({
    title: "Frontend Engineer",
    company: "Parcelwerk",
    location: "Berlin",
    url: INVALID_LINK,
    description: "Build the parcel tracking views.\nWork with the logistics team in Berlin.",
  });
  await page.goto(`/jobs/${job.id}`);

  const article = page.getByRole("article", { name: "Frontend Engineer at Parcelwerk" });
  await expect(article.getByRole("heading", { level: 2, name: "Frontend Engineer" })).toBeVisible();
  await expect(article.getByText(/^Parcelwerk\s*·\s*Berlin$/)).toBeVisible();
  await expect(article.getByRole("link", { name: /^jobs\.parcelwerk\.invalid/ })).toHaveAttribute("href", INVALID_LINK);
  await expect(article.getByRole("region", { name: "Description" })).toContainText(
    "Build the parcel tracking views.\nWork with the logistics team in Berlin.",
  );
  await expect(article.getByRole("complementary", { name: "Status and history" })).toMatchAriaSnapshot(`
    - region "Details":
      - term: Status
      - definition: Saved Added by paste
      - term: Added
      - definition:
        - time
        - text: by pasting the posting
      - term: Applied
      - definition: Not yet
      - term: Linked emails
      - definition: "0"
    - region "Activity":
      - list:
        - listitem:
          - paragraph: Saved
          - time
          - paragraph: Added by paste
  `);
  // A saved job offers the next step.
  await expect(article.getByRole("button", { name: "Mark as applied" })).toBeVisible();
});

test("a status changed by hand shows in the timeline and locks until emails may update it", async ({ page, api }) => {
  const job = await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk", status: "applied" });
  await page.goto(`/jobs/${job.id}`);
  await page.getByRole("button", { name: "Applied Change status" }).click();
  await page.getByRole("menuitem", { name: "Interview" }).click();

  await expect(toast(page, "Moved to Interview")).toBeVisible();
  await expect(page.getByRole("button", { name: "Interview Change status" })).toBeVisible();
  const lockNotice = page.getByText("You set this status by hand, so emails won't change it.");
  await expect(lockNotice).toBeVisible();
  const status = page.getByRole("definition").filter({ hasText: "Changed by you" });
  await expect(status).toHaveText("InterviewChanged by you · emails won’t change it");
  const activity = page.getByRole("region", { name: "Activity" }).getByRole("listitem");
  await expect(activity).toHaveCount(2);
  await expect(activity.first()).toContainText("Moved Applied to Interview");
  await expect(activity.first()).toContainText("Changed by you");
  await expect(activity.last()).toContainText("Added by paste");

  await page.getByRole("button", { name: "Let emails update it" }).click();
  await expect(lockNotice).toBeHidden();
  await expect(status).toHaveText("InterviewChanged by you");
  await expect
    .poll(async () => (await api.get<Job>(`/api/jobs/${job.id}`)).statusLocked)
    .toBe(false);
});

// App bug: LockNotice unmounts on the optimistic unlock, so TanStack Query drops its per-call
// onSuccess/onError: no confirmation toast, and a failed unlock would say nothing either.
test.fixme("unlocking the status confirms it with a toast", async ({ page, api }) => {
  const job = await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk", status: "applied" });
  await api.patch(`/api/jobs/${job.id}`, { status: "interview" });
  await page.goto(`/jobs/${job.id}`);
  await page.getByRole("button", { name: "Let emails update it" }).click();
  await expect(toast(page, "Emails can update this status again")).toBeVisible();
});

test("editing the details saves them, and the board shows the new values", async ({ page, api }) => {
  const job = await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk", location: "Berlin" });
  await page.goto(`/jobs/${job.id}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit details" }).click();

  const form = page.getByRole("form", { name: "Edit details" });
  await expect(form.getByLabel("Title")).toBeFocused();
  await expect(form.getByLabel("Company")).toHaveValue("Parcelwerk");
  await expect(form.getByLabel("Location")).toHaveValue("Berlin");
  await form.getByLabel("Title").fill("Staff Frontend Engineer");
  await form.getByLabel("Location").fill("Remote");
  await form.getByLabel("Description").fill("Lead the tracking views.");
  await form.getByRole("button", { name: "Save changes" }).click();

  await expect(toast(page, "Changes saved")).toContainText("Parcelwerk · Staff Frontend Engineer");
  await expect(form).toBeHidden();
  const article = page.getByRole("article", { name: "Staff Frontend Engineer at Parcelwerk" });
  await expect(article.getByText(/^Parcelwerk\s*·\s*Remote$/)).toBeVisible();
  await expect(article.getByRole("region", { name: "Description" })).toContainText("Lead the tracking views.");

  await page.getByRole("main").getByRole("link", { name: "Applications" }).click();
  const saved = column(page, "Saved");
  await expect(card(saved, "Parcelwerk", "Staff Frontend Engineer")).toBeVisible();
  await expect(saved.getByText("Remote")).toBeVisible();
});

test("the edit form refuses an empty title, and Cancel keeps the job as it was", async ({ page, api }) => {
  const job = await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await page.goto(`/jobs/${job.id}`);
  // The empty description links straight to the form.
  await page.getByRole("button", { name: "Edit the job" }).click();

  const form = page.getByRole("form", { name: "Edit details" });
  await form.getByLabel("Title").fill("   ");
  await form.getByLabel("Company").fill("Lumen Freight");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form.getByLabel("Title")).toHaveAccessibleDescription("Add the job title.");
  await expect(form.getByLabel("Title")).toBeFocused();

  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole("article", { name: "Frontend Engineer at Parcelwerk" })).toBeVisible();
  const stored = await api.get<Job>(`/api/jobs/${job.id}`);
  expect(stored).toMatchObject({ title: "Frontend Engineer", company: "Parcelwerk" });
});

test("a link that another job already has is refused with a message", async ({ page, api }) => {
  await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk", url: INVALID_LINK });
  const other = await api.createJob({ title: "Data Analyst", company: "Lumen Freight" });
  await page.goto(`/jobs/${other.id}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit details" }).click();

  const form = page.getByRole("form", { name: "Edit details" });
  await form.getByLabel("Link").fill(INVALID_LINK);
  await form.getByRole("button", { name: "Save changes" }).click();

  // The server answers 409; the form stays open with the user's input.
  await expect(toast(page, "Couldn't save your changes")).toContainText("Another job already has this link");
  await expect(form.getByLabel("Link")).toHaveValue(INVALID_LINK);
  expect(await api.get<Job>(`/api/jobs/${other.id}`)).toMatchObject({ url: null });
});

test("an interview date set on the page shows on the board card and in the KPI row", async ({ page, api }) => {
  const job = await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk", status: "applied" });
  await api.patch(`/api/jobs/${job.id}`, { status: "interview" });
  await page.goto(`/jobs/${job.id}`);

  await page.getByRole("button", { name: "Add date" }).click();
  // A date years ahead, so the text doesn't depend on today (the browser runs in UTC).
  await page.getByLabel("Date and time").fill("2039-03-14T10:30");
  await page.getByLabel("Round (optional)").fill("Technical interview");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const nextInterview = page.getByRole("definition").filter({ hasText: "Technical interview" });
  await expect(nextInterview).toContainText("Mon 14 Mar 2039, 10:30");
  await expect(page.getByRole("button", { name: "Change", exact: true })).toBeVisible();

  await page.getByRole("main").getByRole("link", { name: "Applications" }).click();
  const interview = column(page, "Interview");
  await expect(interview.getByText("Technical interview, Mon 14 Mar 2039, 10:30")).toBeVisible();
  await expect(page.getByRole("region", { name: "Overview" })).toContainText("Next: Mon 14 Mar 2039, 10:30");
});

test("deleting asks first, then removes the job and goes back to the dashboard", async ({ page, api }) => {
  const job = await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await api.createJob({ title: "Data Analyst", company: "Lumen Freight" });
  await page.goto(`/jobs/${job.id}`);

  const confirm = page.getByRole("alertdialog", { name: "Delete this job?" });
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(confirm).toContainText("Parcelwerk · Frontend Engineer and its status history will be removed.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole("article", { name: "Frontend Engineer at Parcelwerk" })).toBeVisible();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await confirm.getByRole("button", { name: "Delete job" }).click();

  await expect(toast(page, "Job deleted")).toContainText("Parcelwerk · Frontend Engineer");
  await expect(page).toHaveURL("/");
  await expect(card(column(page, "Saved"), "Lumen Freight", "Data Analyst")).toBeVisible();
  await expect(card(page, "Parcelwerk", "Frontend Engineer")).toHaveCount(0);
  await expect(page.getByText("1 job tracked.")).toBeVisible();

  // An old link to it now says it is gone.
  await page.goto(`/jobs/${job.id}`);
  await expect(page.getByText("This job doesn't exist anymore")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Applications" })).toHaveAttribute("href", "/");
});

// App bug: useDeleteJob removes the job's query and the dashboard re-renders, so the sheet's
// useJob starts over (skeleton, then 404) and unmounts the header before the delete settles.
// TanStack Query then drops the per-call onSuccess: no "Job deleted" toast, and the sheet stays
// open on "This job doesn't exist anymore" with ?job= in the URL. Deleting on /jobs/[id] works.
test.fixme("deleting from the side sheet closes it and takes the card off the board", async ({ page, api }) => {
  await api.createJob({ title: "Frontend Engineer", company: "Parcelwerk" });
  await api.createJob({ title: "Data Analyst", company: "Lumen Freight", status: "applied" });
  await page.goto("/");
  await card(column(page, "Saved"), "Parcelwerk", "Frontend Engineer").click();

  const sheet = page.getByRole("dialog", { name: "Job details" });
  await sheet.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog", { name: "Delete this job?" }).getByRole("button", { name: "Delete job" }).click();

  await expect(toast(page, "Job deleted")).toBeVisible();
  await expect(sheet).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]job=/);
  await expect(card(page, "Parcelwerk", "Frontend Engineer")).toHaveCount(0);
  await expect(column(page, "Saved")).toContainText("Nothing here yet · not applied yet");
  await expect(card(column(page, "Applied"), "Lumen Freight", "Data Analyst")).toBeVisible();
});
