// Adding a job through the "Add a job" dialog: pasted text and links are read on the server and
// shown for review, saving puts the job in Saved or Applied, adding one that is already tracked
// updates it instead of making a second, and the review step refuses a job without a title or
// company. Reading a link is the server's real fetch, so the link is on the reserved .invalid
// TLD: it can't resolve, and the app falls back to guessing from the link (README, "Links are
// fetched and read…"). Nothing here reaches a real host.
import type { Job } from "@/lib/types";
import { expect, test } from "./support/fixtures";
import { card, column, INVALID_LINK, POSTING, toast } from "./support/jobs";

test("pasted job text is read into the review step, and Save job puts it in Saved", async ({ page, api }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add job", exact: true }).click();

  const paste = page.getByRole("dialog", { name: "Add a job" });
  await paste.getByLabel("Job link or job text").fill(POSTING.text);
  await expect(paste.getByText("Job text detected")).toBeVisible();
  await paste.getByRole("button", { name: "Read job" }).click();

  const review = page.getByRole("dialog", { name: "Check the details" });
  await expect(review.getByLabel("Title")).toHaveValue(POSTING.title);
  await expect(review.getByLabel("Company")).toHaveValue(POSTING.company);
  await expect(review.getByLabel("Location")).toHaveValue(POSTING.location);
  await expect(review.getByLabel("Description")).toHaveValue(/build the shipment views/);
  await expect(review.getByRole("radio", { name: /^Saved/ })).toBeChecked();

  // The fields are the user's to correct before saving.
  await review.getByLabel("Title").fill("Senior Frontend Engineer, Tracking");
  await review.getByRole("button", { name: "Save job" }).click();

  await expect(toast(page, "Added to Saved")).toContainText("Lumen Freight · Senior Frontend Engineer, Tracking");
  await expect(review).toBeHidden();
  await expect(card(column(page, "Saved"), "Lumen Freight", "Senior Frontend Engineer, Tracking")).toBeVisible();
  await expect(page.getByText("1 job tracked.")).toBeVisible();
  // A saved job is not an application yet: nothing waits for a reply.
  await expect(page.getByRole("region", { name: "Waiting for a reply" })).toContainText("Nothing is waiting.");
  await expect(page.getByRole("region", { name: "Overview" })).toContainText("Nothing sent yet");

  // The description isn't on the board; read it back.
  const jobs = await api.get<Job[]>("/api/jobs");
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    title: "Senior Frontend Engineer, Tracking",
    company: POSTING.company,
    location: POSTING.location,
    status: "saved",
    captureMethod: "paste",
  });
  expect(jobs[0].description).toContain("React and TypeScript");
});

test("the Applied column's + adds the job as applied, and the KPI row counts it as sent", async ({ page, api }) => {
  // One job already, so the board (with its column buttons) shows instead of the empty state.
  await api.createJob({ title: "Data Analyst", company: "Invented Harbor GmbH" });
  await page.goto("/");
  await page.getByRole("button", { name: "Add an applied job" }).click();

  const paste = page.getByRole("dialog", { name: "Add a job" });
  await paste.getByLabel("Job link or job text").fill(POSTING.text);
  await paste.getByRole("button", { name: "Read job" }).click();

  const review = page.getByRole("dialog", { name: "Check the details" });
  await expect(review.getByRole("radio", { name: /^Applied/ })).toBeChecked();
  await review.getByRole("button", { name: "Add as applied" }).click();

  await expect(toast(page, "Added to Applied")).toBeVisible();
  const applied = column(page, "Applied");
  await expect(card(applied, POSTING.company, POSTING.title)).toBeVisible();
  await expect(applied.getByText("0 of 30 days")).toBeVisible();

  const waiting = page.getByRole("region", { name: "Waiting for a reply" });
  await expect(waiting.getByText("1", { exact: true })).toBeVisible();
  await expect(waiting.getByRole("button", { name: /Lumen Freight/ })).toContainText("0 days");
  await expect(page.getByRole("region", { name: "Overview" })).toMatchAriaSnapshot(`
    - region "Applications sent":
      - paragraph: "1"
    - term: Reply rate
    - definition: 0%
    - definition: 0 of 1 answered
  `);
  await expect(page.getByText("2 jobs tracked.")).toBeVisible();
});

test("adding a job that is already tracked updates it instead of adding a second one", async ({ page, api }) => {
  await api.createJob({ title: POSTING.title, company: POSTING.company, location: "", description: "Short note." });
  await page.goto("/");
  await expect(card(column(page, "Saved"), POSTING.company, POSTING.title)).toBeVisible();

  await page.getByRole("button", { name: "Add a job" }).click();
  await page.getByLabel("Job link or job text").fill(POSTING.text);
  await page.getByRole("button", { name: "Read job" }).click();

  const review = page.getByRole("dialog", { name: "Check the details" });
  const notice = review.getByRole("alert").filter({ hasText: "Already in your dashboard" });
  await expect(notice).toContainText(`${POSTING.company} · ${POSTING.title}`);
  await expect(notice).toContainText("Saving updates that entry instead of creating a duplicate.");
  // The existing entry had no location: the parsed one fills the gap.
  await expect(review.getByLabel("Location")).toHaveValue(POSTING.location);

  // Saved -> Applied is the one move an update makes.
  await review.getByText("I've sent my application").click();
  await review.getByRole("button", { name: "Update existing job" }).click();

  await expect(toast(page, "Updated existing job")).toBeVisible();
  await expect(card(column(page, "Applied"), POSTING.company, POSTING.title)).toBeVisible();
  await expect(card(column(page, "Saved"), POSTING.company, POSTING.title)).toHaveCount(0);
  await expect(page.getByText("1 job tracked.")).toBeVisible();

  const jobs = await api.get<Job[]>("/api/jobs");
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ status: "applied", location: POSTING.location });
  expect(jobs[0].description).toContain("shipment views");
});

test("a link that can't be fetched is guessed from the link itself", async ({ page, api }) => {
  await page.goto("/");
  await expect(page.getByText("Add your first job")).toBeVisible();
  // "N" opens the dialog from anywhere on the page.
  await page.keyboard.press("n");

  const paste = page.getByRole("dialog", { name: "Add a job" });
  await paste.getByLabel("Job link or job text").fill(INVALID_LINK);
  await expect(paste.getByText("Link detected")).toBeVisible();
  await paste.getByRole("button", { name: "Read job" }).click();

  // parse/text.ts parseUrl: the company from the host, the title from the slug (numbers dropped).
  const review = page.getByRole("dialog", { name: "Check the details" });
  await expect(review.getByLabel("Title")).toHaveValue("Frontend Engineer");
  await expect(review.getByLabel("Company")).toHaveValue("Parcelwerk");
  await expect(review.getByLabel("Link")).toHaveValue(INVALID_LINK);
  const missing = "Couldn't find this on the page — please fill it in";
  await expect(review.getByLabel("Location")).toHaveValue("");
  await expect(review.getByLabel("Location")).toHaveAccessibleDescription(missing);
  await expect(review.getByLabel("Description")).toHaveAccessibleDescription(missing);

  await review.getByLabel("Location").fill("Remote");
  await expect(review.getByLabel("Location")).not.toHaveAccessibleDescription(missing);
  await review.getByRole("button", { name: "Save job" }).click();

  await expect(toast(page, "Added to Saved")).toContainText("Parcelwerk · Frontend Engineer");
  await expect(card(column(page, "Saved"), "Parcelwerk", "Frontend Engineer")).toBeVisible();
  const [job] = await api.get<Job[]>("/api/jobs");
  expect(job).toMatchObject({ url: INVALID_LINK, location: "Remote", description: "" });
});

test("the review step asks for a title, a company and a real link before saving", async ({ page, api }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add job", exact: true }).click();
  await page.getByRole("button", { name: "Fill in manually" }).click();

  const review = page.getByRole("dialog", { name: "Check the details" });
  const title = review.getByLabel("Title");
  await expect(title).toBeFocused();
  await review.getByRole("button", { name: "Save job" }).click();

  await expect(title).toHaveAccessibleDescription("Add the job title.");
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(review.getByLabel("Company")).toHaveAccessibleDescription("Add the company name.");
  await expect(title).toBeFocused();

  await title.fill("Platform Engineer");
  await review.getByLabel("Company").fill("Parcelwerk");
  await review.getByLabel("Link").fill("not a link");
  await review.getByRole("button", { name: "Save job" }).click();
  await expect(review.getByLabel("Link")).toHaveAccessibleDescription(
    "Enter a full link, like https://company.com/jobs/123.",
  );
  await expect(review.getByLabel("Link")).toBeFocused();
  await expect(title).not.toHaveAttribute("aria-invalid");
  expect(await api.get<Job[]>("/api/jobs")).toHaveLength(0);

  // A bare domain is fine: the form adds https://.
  await review.getByLabel("Link").fill("jobs.parcelwerk.invalid/careers/77");
  await review.getByRole("button", { name: "Save job" }).click();
  await expect(toast(page, "Added to Saved")).toBeVisible();
  const [job] = await api.get<Job[]>("/api/jobs");
  expect(job).toMatchObject({ title: "Platform Engineer", url: "https://jobs.parcelwerk.invalid/careers/77" });
});
