// Settings → Keyword rules: the phrases that decide what an email means. A new account starts
// with the default rules (src/lib/domain/defaults.ts); the user adds, removes and restores
// phrases, and "Update defaults" brings an older list up to date. These rules drive every status
// change from mail, so the list must show what is stored and refuse what would be ambiguous.
import { DEFAULT_RULES, RETIRED_DEFAULT_RULES } from "@/lib/domain/defaults";
import { normalize } from "@/lib/domain/normalize";
import type { KeywordRule, Settings } from "@/lib/types";
import { db } from "./support/db";
import {
  addKeyword,
  defaultPhrases,
  expect,
  keywordForm,
  openSettings,
  pick,
  reloadSettings,
  removeButton,
  ruleChips,
  ruleGroup,
  settingsSection,
  test,
  toasts,
  type RuleStatus,
} from "./support/settings-page";

const STATUSES: RuleStatus[] = ["applied", "interview", "offer", "rejected"];
const TOTAL = DEFAULT_RULES.length;

test("the default rules are listed by status, and the language filter narrows them", async ({ page }) => {
  await openSettings(page);
  const section = settingsSection(page, "Keyword rules");
  await expect(section.getByText(`${TOTAL} phrases · 2 languages`)).toBeVisible();

  for (const status of STATUSES) {
    await expect(ruleGroup(page, status).getByRole("heading", { level: 3 })).toBeVisible();
    await expect(ruleChips(page, status)).toHaveCount(defaultPhrases({ status }).length);
    // The chips are in the order the rules were added, which is the defaults' order.
    await expect(ruleChips(page, status)).toContainText(defaultPhrases({ status }));
    await expect(ruleGroup(page, status)).toContainText(`EN ${defaultPhrases({ status, language: "en" }).length}`);
    await expect(ruleGroup(page, status)).toContainText(`DE ${defaultPhrases({ status, language: "de" }).length}`);
  }

  const filter = section.getByRole("radiogroup", { name: "Show phrases for language" });
  await expect(filter.getByRole("radio", { name: `All languages, ${TOTAL} phrases` })).toBeChecked();
  const german = defaultPhrases({ language: "de" }).length;
  await filter.getByRole("radio", { name: `German, ${german} phrases` }).click();

  const germanInterview = defaultPhrases({ status: "interview", language: "de" });
  await expect(ruleChips(page, "interview")).toHaveCount(germanInterview.length);
  await expect(ruleGroup(page, "interview")).toContainText(
    `${germanInterview.length} of ${defaultPhrases({ status: "interview" }).length}`,
  );
  await expect(removeButton(page, "interview")).toBeHidden();
  await expect(removeButton(page, "vorstellungsgespräch")).toBeVisible();
});

test("a new keyword is added under its status and is still there after a reload", async ({ page, account }) => {
  await openSettings(page);
  const form = keywordForm(page);
  // Spaces are tidied the way the matcher reads them anyway.
  await addKeyword(page, "  Vertrag   zur Unterschrift ", { status: "offer", language: "German" });

  await expect(toasts(page).getByText("Keyword added")).toBeVisible();
  await expect(toasts(page).getByText("“Vertrag zur Unterschrift” → Offer · DE")).toBeVisible();
  await expect(removeButton(ruleGroup(page, "offer"), "Vertrag zur Unterschrift")).toBeVisible();
  await expect(ruleChips(page, "offer")).toHaveCount(defaultPhrases({ status: "offer" }).length + 1);
  // Ready for the next phrase: emptied and focused, status and language kept.
  await expect(form.getByLabel("Phrase")).toHaveValue("");
  await expect(form.getByLabel("Phrase")).toBeFocused();
  await expect(form.getByLabel("Status")).toHaveText("Offer");

  await reloadSettings(page);
  await expect(removeButton(ruleGroup(page, "offer"), "Vertrag zur Unterschrift")).toBeVisible();
  const rows = await db()<{ status: string; language: string }[]>`
    SELECT status, language FROM keyword_rules
    WHERE user_id = ${account.userId} AND phrase = 'Vertrag zur Unterschrift'`;
  expect(rows).toEqual([{ status: "offer", language: "de" }]);
});

test("a phrase that is already a keyword for that status is not added twice", async ({ page, api, account }) => {
  await openSettings(page);
  const form = keywordForm(page);
  const phrase = form.getByLabel("Phrase");

  // Case does not matter…
  await phrase.fill("INTERVIEW");
  await expect(form.getByText("“interview” is already a Interview keyword (EN).")).toBeVisible();
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(phrase).toHaveValue("INTERVIEW");
  await expect(phrase).toBeFocused();

  // …and neither do accents.
  await phrase.fill("Vorstellungsgesprach");
  await expect(form.getByText("“vorstellungsgespräch” is already a Interview keyword (DE).")).toBeVisible();
  await phrase.press("Enter");

  await expect(ruleChips(page, "interview")).toHaveCount(defaultPhrases({ status: "interview" }).length);
  await expect(toasts(page).getByText("Keyword added")).toHaveCount(0);

  // The API keeps one rule as well: it answers with the rule that is already there.
  const existing = DEFAULT_RULES.findIndex((r) => r.phrase === "interview");
  const answered = await api.post<KeywordRule>("/api/rules", { phrase: "Interview", status: "interview", language: "en" });
  expect(answered.phrase).toBe(DEFAULT_RULES[existing].phrase);
  const [{ count }] = await db()<{ count: number }[]>`
    SELECT count(*)::int AS count FROM keyword_rules WHERE user_id = ${account.userId}`;
  expect(count).toBe(TOTAL);
});

test("a phrase listed under another status says which one wins, and can still be added", async ({ page }) => {
  await openSettings(page);
  const form = keywordForm(page);

  await form.getByLabel("Phrase").fill("unfortunately");
  await expect(
    form.getByText(
      "Also listed under Rejected. Emails with this phrase will go to review because the keywords disagree.",
    ),
  ).toBeVisible();

  await pick(page, form.getByLabel("Status"), "Applied");
  await expect(form.getByText("Also listed under Rejected. Rejected wins when both match.")).toBeVisible();
  await form.getByRole("button", { name: "Add", exact: true }).click();

  await expect(toasts(page).getByText("“unfortunately” → Applied · EN")).toBeVisible();
  await expect(removeButton(ruleGroup(page, "applied"), "unfortunately")).toBeVisible();
  await expect(removeButton(ruleGroup(page, "rejected"), "unfortunately")).toBeVisible();
});

test("an empty, too short or too long phrase is refused with the form's message", async ({ page, account }) => {
  await openSettings(page);
  const form = keywordForm(page);
  const phrase = form.getByLabel("Phrase");
  const add = form.getByRole("button", { name: "Add", exact: true });

  await phrase.fill("   ");
  await add.click();
  await expect(form.getByRole("alert")).toHaveText("Type a phrase from the email, e.g. “wir freuen uns”.");
  await expect(phrase).toHaveAttribute("aria-invalid", "true");

  await phrase.fill("a");
  await expect(form.getByRole("alert")).toHaveText("Use at least 2 characters.");
  await add.click();

  // Too long shows while typing, before any submit.
  await reloadSettings(page);
  await phrase.fill("x".repeat(121));
  await expect(form.getByRole("alert")).toHaveText("Keep it under 120 characters.");
  await add.click();
  await phrase.press("Backspace");
  await expect(form.getByRole("alert")).toBeHidden();
  await expect(form.getByText("Matches anywhere in the subject or body. Case doesn’t matter.")).toBeVisible();
  await expect(phrase).not.toHaveAttribute("aria-invalid");

  await expect(toasts(page).getByText("Keyword added")).toHaveCount(0);
  const [{ count }] = await db()<{ count: number }[]>`
    SELECT count(*)::int AS count FROM keyword_rules WHERE user_id = ${account.userId}`;
  expect(count).toBe(TOTAL);
});

test("a removed keyword stays removed, and Undo brings one back", async ({ page, account }) => {
  await openSettings(page);
  const interview = ruleGroup(page, "interview");

  await removeButton(interview, "availability").click();
  await expect(toasts(page).getByText("Removed “availability”")).toBeVisible();
  await expect(toasts(page).getByText("Interview · English")).toBeVisible();
  await expect(removeButton(interview, "availability")).toBeHidden();
  await expect(ruleChips(page, "interview")).toHaveCount(defaultPhrases({ status: "interview" }).length - 1);

  await reloadSettings(page);
  await expect(removeButton(interview, "availability")).toBeHidden();
  // Deleting a default on purpose is not an outdated list: no offer to update the defaults.
  await expect(page.getByRole("button", { name: "Update defaults" })).toHaveCount(0);

  await removeButton(ruleGroup(page, "offer"), "offer letter").click();
  const removed = toasts(page).getByRole("listitem").filter({ hasText: "Removed “offer letter”" });
  await removed.getByRole("button", { name: "Undo" }).click();
  await expect(toasts(page).getByText("Keyword restored")).toBeVisible();
  await expect(removeButton(ruleGroup(page, "offer"), "offer letter")).toBeVisible();

  await reloadSettings(page);
  await expect(removeButton(ruleGroup(page, "offer"), "offer letter")).toBeVisible();
  const phrases = await db()<{ phrase: string }[]>`
    SELECT phrase FROM keyword_rules WHERE user_id = ${account.userId} AND status = 'interview'`;
  expect(phrases.map((r) => r.phrase)).not.toContain("availability");
});

test("Update defaults removes outdated phrases, adds missing defaults and keeps the user's own", async ({
  page,
  api,
  account,
}) => {
  // An account from an earlier version: two defaults missing, two phrases that are retired now.
  const sql = db();
  await sql`
    DELETE FROM keyword_rules
    WHERE user_id = ${account.userId}
      AND ((status = 'interview' AND phrase_norm = 'interview') OR (status = 'offer' AND phrase_norm = 'offer letter'))`;
  const retired = RETIRED_DEFAULT_RULES.filter((r) => r.phrase === "leider" || r.phrase === "kennenlernen");
  await sql`
    INSERT INTO keyword_rules ${sql(
      retired.map((r) => ({
        user_id: account.userId,
        status: r.status,
        phrase: r.phrase,
        phrase_norm: normalize(r.phrase),
        language: "de",
      })),
    )}`;
  await api.post("/api/rules", { phrase: "zweite Runde", status: "interview", language: "de" });

  await openSettings(page);
  await expect(
    page.getByText(
      "The default keywords have improved: 2 new phrases, and 2 phrases here are too broad now. Keywords you added stay.",
    ),
  ).toBeVisible();
  await expect(removeButton(page, "leider")).toBeVisible();

  await page.getByRole("button", { name: "Update defaults" }).click();
  await expect(toasts(page).getByText("Default keywords updated")).toBeVisible();
  await expect(
    toasts(page).getByText("2 phrases added, 2 outdated phrases removed. Your own keywords are unchanged."),
  ).toBeVisible();

  await expect(page.getByRole("button", { name: "Update defaults" })).toHaveCount(0);
  await expect(removeButton(page, "leider")).toBeHidden();
  await expect(removeButton(page, "kennenlernen")).toBeHidden();
  await expect(removeButton(ruleGroup(page, "interview"), "interview")).toBeVisible();
  await expect(removeButton(ruleGroup(page, "offer"), "offer letter")).toBeVisible();
  await expect(removeButton(ruleGroup(page, "interview"), "zweite Runde")).toBeVisible();

  await reloadSettings(page);
  await expect(page.getByRole("button", { name: "Update defaults" })).toHaveCount(0);
  await expect(page.getByText(`${TOTAL + 1} phrases · 2 languages`)).toBeVisible();
});

test("a keyword in a new language adds that language to the filter and the settings", async ({ page, api }) => {
  await openSettings(page);
  const section = settingsSection(page, "Keyword rules");
  const form = keywordForm(page);
  await addKeyword(page, "nous avons le plaisir", { status: "offer", language: "French" });
  await expect(toasts(page).getByText("“nous avons le plaisir” → Offer · FR")).toBeVisible();
  await expect(section.getByText(`${TOTAL + 1} phrases · 3 languages`)).toBeVisible();

  const filter = section.getByRole("radiogroup", { name: "Show phrases for language" });
  await filter.getByRole("radio", { name: "French, 1 phrase" }).click();
  await expect(ruleChips(page, "offer")).toHaveCount(1);
  await expect(ruleGroup(page, "offer")).toContainText(`1 of ${defaultPhrases({ status: "offer" }).length + 1}`);

  // An empty group offers to add the first phrase there, in the language shown.
  const applied = ruleGroup(page, "applied");
  await expect(applied.getByText("No French phrases for Applied yet.")).toBeVisible();
  await applied.getByRole("button", { name: "Add one" }).click();
  await expect(form.getByLabel("Status")).toHaveText("Applied");
  await expect(form.getByLabel("Language")).toContainText("French");
  await expect(form.getByLabel("Phrase")).toBeFocused();
  await page.keyboard.type("merci pour votre candidature");
  await page.keyboard.press("Enter");
  await expect(removeButton(applied, "merci pour votre candidature")).toBeVisible();
  await expect(filter.getByRole("radio", { name: "French, 2 phrases" })).toBeChecked();

  const settings = await api.get<Settings>("/api/settings");
  expect(settings.languages).toEqual(["en", "de", "fr"]);
  await reloadSettings(page);
  await expect(filter.getByRole("radio", { name: "French, 2 phrases" })).toBeVisible();
});
