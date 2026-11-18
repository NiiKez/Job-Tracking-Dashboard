// Locators and invented postings shared by the jobs specs (jobs-add, jobs-board, job-detail).
// The names here are the ones the UI gives screen readers, so a renamed control fails loudly.
import type { Locator, Page } from "@playwright/test";
import { toasts } from "./fixtures";

/** A job ad as someone would paste it: labelled lines the text parser reads (parse/text.ts). */
export const POSTING = {
  title: "Senior Frontend Engineer",
  company: "Lumen Freight",
  location: "Hamburg",
  text: [
    "Senior Frontend Engineer",
    "Company: Lumen Freight",
    "Location: Hamburg",
    "",
    "We are looking for a frontend engineer to build the shipment views our customers use every day.",
    "You will work with a small team on React and TypeScript.",
  ].join("\n"),
} as const;

/**
 * A link on the reserved .invalid TLD (RFC 6761): the server's fetch fails at DNS, so the test
 * never reaches a real host, and the parser falls back to guessing from the link.
 */
export const INVALID_LINK = "https://jobs.parcelwerk.invalid/careers/123-frontend-engineer";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A board column by its header: Saved, Applied, Interview, Offer or Closed. */
export function column(page: Page, name: string): Locator {
  return page
    .getByRole("region", { name: "Applications board" })
    .getByRole("region", { name, exact: true });
}

/**
 * The button stretched over a board card (or a Closed row) that opens the job. It is also the
 * drag handle. Its name is "Company, Title. <what matters in its stage>", and the last part
 * holds dates, so only the start is matched.
 */
export function card(scope: Page | Locator, company: string, title: string): Locator {
  return scope.getByRole("button", { name: new RegExp(`^${escapeRegExp(company)}, ${escapeRegExp(title)}\\.`) });
}

/** A toast (sonner, bottom right) by its title. */
export function toast(page: Page, title: string): Locator {
  return toasts(page).getByRole("listitem").filter({ hasText: title });
}

/**
 * Waits until a keyboard drag that has just been announced listens for keys. dnd-kit's
 * KeyboardSensor starts the drag (and its "Picked up" announcement) at once, but adds its keydown
 * listener in a setTimeout(0) (@dnd-kit/core, KeyboardSensor.attach), so an arrow key pressed in
 * between is lost. Timers with the same delay run in the order they were set, so one set now runs
 * after dnd-kit's.
 */
export async function keyboardDragReady(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/** dnd-kit's live region: what the board announces while a card is moved by keyboard. */
export function dragAnnouncement(page: Page): Locator {
  return page.getByRole("status").filter({ hasText: /Picked up|Moved over|Dropped|Cancelled|no longer over/ });
}
