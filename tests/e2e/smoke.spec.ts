// The e2e setup itself: a signed-out visitor is sent to sign in, a signed-in account starts empty,
// and data made through the API shows up in the browser.
import { expect, test } from "./support/fixtures";

test("a signed-out visitor is sent to the login page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/login?next=%2F");
});

test("a new account starts with no jobs", async ({ page, account }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible();
  await expect(page.getByText("Add your first job")).toBeVisible();
  expect(account.email).toMatch(/^e2e-\d+@example\.com$/);
});

test("a job made through the API is on the board", async ({ page, api }) => {
  await api.createJob({ title: "Platform Engineer", company: "Invented Harbor GmbH" });
  await page.goto("/");
  await expect(page.getByText("Platform Engineer").first()).toBeVisible();
  await expect(page.getByText("Invented Harbor GmbH").first()).toBeVisible();
});
