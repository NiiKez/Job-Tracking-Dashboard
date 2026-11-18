// The mail the mock store delivered on "Check inbox now" (formerly INCOMING in
// db/seed/fixtures.ts), now Gmail-shaped fixtures in fixtures/mail/. Read through the Gmail
// parser, as ingest reads it, and returned as classifier input in the mock's order.
//
//   const INCOMING = await loadIncoming();
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseGmailMessage } from "@/lib/server/inbox/parse/gmail-message";
import type { GmailMessage } from "@/lib/server/inbox/source/types";
import type { ClassifyInput } from "@/lib/types";

const DIR = path.resolve(import.meta.dirname, "../../fixtures/mail");

/** The mock's four queued emails, in its order. */
export const INCOMING_FILES = [
  "ember-interview-invite.json",
  "brightline-rejection-de.json",
  "driftwood-confirmation.json",
  "jobradar-alert.json",
] as const;

export type DemoMail = Required<Pick<ClassifyInput, "fromName" | "fromAddress" | "subject" | "body">>;

export async function loadIncoming(): Promise<DemoMail[]> {
  return Promise.all(
    INCOMING_FILES.map(async (file) => {
      const message = JSON.parse(await readFile(path.join(DIR, file), "utf8")) as GmailMessage;
      const { fromName, fromAddress, subject, body } = await parseGmailMessage(message);
      return { fromName, fromAddress, subject, body };
    }),
  );
}
