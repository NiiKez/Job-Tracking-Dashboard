// Locators and steps for the Settings page (src/components/settings/*), shared by settings.spec.ts,
// keyword-rules.spec.ts and rule-tester.spec.ts. Locators follow what a user (or a screen reader)
// sees: section headings, labels, the toast region.
import type { Locator, Page } from "@playwright/test";
import { DEFAULT_RULES } from "@/lib/domain/defaults";
import type { KeywordRule } from "@/lib/types";
import { test as base, expect, toasts, type Account } from "./fixtures";

/**
 * The fixtures' test, signed in for every test: Settings exists only for an account. Tests that
 * need the account or the API still ask for `account` or `api` (the same account).
 */
export const test = base.extend<{ signedIn: Account }>({
  signedIn: [
    async ({ account }, provide) => {
      await provide(account);
    },
    { auto: true },
  ],
});

export { expect, toasts };

export type RuleStatus = KeywordRule["status"];

export const STATUS_LABEL: Record<RuleStatus, string> = {
  applied: "Applied",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
};

/**
 * Page load, hydration and the first settings and rules requests: on a machine busy with other
 * runs this takes longer than one expect's default 5 seconds.
 */
const READY_TIMEOUT = 15_000;

/**
 * Waits until Settings is usable. Until the page has hydrated and loaded the settings and the
 * rules, the sections are skeletons; a click or a keystroke before that would be lost.
 */
export async function settingsReady(page: Page): Promise<void> {
  await expect(keywordForm(page)).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByRole("switch", { name: "Create an application from confirmation emails" })).toBeVisible({
    timeout: READY_TIMEOUT,
  });
}

export async function openSettings(page: Page, path = "/settings"): Promise<void> {
  await page.goto(path);
  await settingsReady(page);
}

export async function reloadSettings(page: Page): Promise<void> {
  await page.reload();
  await settingsReady(page);
}

/** A top-level settings section (Inbox, Chrome extension, Automation, Keyword rules, Test an email, Appearance). */
export function settingsSection(page: Page, title: string): Locator {
  return page.getByRole("region", { name: title, exact: true });
}

/* ------------------------------------------------------------ keyword rules */

export function keywordForm(page: Page): Locator {
  return page.getByRole("form", { name: "Add a keyword" });
}

/** One status group of the keyword rules: its heading, count and phrase chips. */
export function ruleGroup(page: Page, status: RuleStatus): Locator {
  return settingsSection(page, "Keyword rules").getByRole("region", { name: STATUS_LABEL[status], exact: true });
}

/** The chips of one status group. */
export function ruleChips(page: Page, status: RuleStatus): Locator {
  return ruleGroup(page, status).getByRole("listitem");
}

/** The ✕ on a phrase's chip: present exactly when the phrase is listed. */
export function removeButton(scope: Page | Locator, phrase: string): Locator {
  return scope.getByRole("button", { name: `Remove “${phrase}”`, exact: true });
}

/** Opens a Radix select and picks the option whose name matches. */
export async function pick(page: Page, combobox: Locator, option: string | RegExp): Promise<void> {
  await combobox.click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
  await expect(page.getByRole("listbox")).toBeHidden();
}

/** Fills the add form and submits it. `language` is the option's name ("German"). */
export async function addKeyword(
  page: Page,
  phrase: string,
  options: { status?: RuleStatus; language?: string } = {},
): Promise<void> {
  const form = keywordForm(page);
  await form.getByLabel("Phrase").fill(phrase);
  if (options.status) await pick(page, form.getByLabel("Status"), STATUS_LABEL[options.status]);
  if (options.language) await pick(page, form.getByLabel("Language"), new RegExp(`${options.language}$`));
  await form.getByRole("button", { name: "Add", exact: true }).click();
}

export function defaultPhrases(filter: { status?: RuleStatus; language?: string } = {}): string[] {
  return DEFAULT_RULES.filter(
    (r) => (!filter.status || r.status === filter.status) && (!filter.language || r.language === filter.language),
  ).map((r) => r.phrase);
}

/* -------------------------------------------------------------- rule tester */

export function testerForm(page: Page): Locator {
  return page.getByRole("form", { name: "Test an email" });
}

/** The value next to a term of the tester's result ("Detected status", "Review reason", …). */
export function resultRow(page: Page, term: string): Locator {
  // A <dt>/<dd> pair has no accessible link between them; each pair sits in its own <div>.
  return settingsSection(page, "Test an email")
    .locator("dl > div")
    .filter({ has: page.getByText(term, { exact: true }) })
    .getByRole("definition");
}

/** The tested email as the result shows it, with the matched phrases marked. */
export function testedEmail(page: Page): Locator {
  return settingsSection(page, "Test an email").getByRole("figure");
}
