import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DECODED_BYTES, parseGmailMessage } from "@/lib/server/inbox/parse/gmail-message";
import { readHtml } from "@/lib/server/inbox/parse/html";
import { b64u, html, message, multipart, plain, textPart } from "./build";

// Counts the HTML conversions (html-to-text passes) the parser makes.
vi.mock("@/lib/server/inbox/parse/html", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/server/inbox/parse/html")>();
  return { ...original, readHtml: vi.fn(original.readHtml) };
});

const STUB = "This message requires an HTML-capable email client.";
const REJECTION =
  "<p>Hi Alex,</p><p>thank you for your interest in the Frontend Engineer role at Orbit Payments. " +
  "Unfortunately, we have decided to move forward with other candidates whose experience more " +
  "closely matches what the team needs right now.</p><p>Best wishes,<br>The Orbit Payments Talent Team</p>";
const REJECTION_TEXT =
  "Hi Alex,\n\nthank you for your interest in the Frontend Engineer role at Orbit Payments. Unfortunately, we have " +
  "decided to move forward with other candidates whose experience more closely matches what the team needs right " +
  "now.\n\nBest wishes,\nThe Orbit Payments Talent Team";

beforeEach(() => {
  vi.mocked(readHtml).mockClear();
});

describe("a plain-text alternative that is only a stub of the HTML one", () => {
  it("gives way to the HTML, converted once", async () => {
    const msg = message(multipart("multipart/alternative", [plain(STUB), html(REJECTION)]));
    expect(await parseGmailMessage(msg)).toMatchObject({ body: REJECTION_TEXT, bodyTruncated: false });
    expect(readHtml).toHaveBeenCalledTimes(1);
  });

  it("also when the HTML sits in a multipart/related beside it", async () => {
    const related = multipart("multipart/related", [html(REJECTION), textPart("image/png", "png", { filename: "logo.png" })]);
    const msg = message(multipart("multipart/mixed", [multipart("multipart/alternative", [plain(STUB), related])]));
    expect((await parseGmailMessage(msg)).body).toBe(REJECTION_TEXT);
  });

  it("fetches an HTML alternative delivered as an attachment reference", async () => {
    const ref = textPart("text/html", "", { attachmentId: "att-html", size: REJECTION.length, bytes: Buffer.from("") });
    const getAttachment = vi.fn(async () => b64u(REJECTION));
    const msg = message(multipart("multipart/alternative", [plain(STUB), ref]));
    expect((await parseGmailMessage(msg, { getAttachment })).body).toBe(REJECTION_TEXT);
    expect(getAttachment).toHaveBeenCalledTimes(1);
  });

  it("is told by length: at least a third of the HTML's text is a real plain-text body", async () => {
    const third = "Unfortunately, we have decided to move forward with other candidates whose experience fits better.";
    expect(third.length * 3).toBeGreaterThanOrEqual(REJECTION_TEXT.length);
    const msg = message(multipart("multipart/alternative", [plain(third), html(REJECTION)]));
    expect((await parseGmailMessage(msg)).body).toBe(third);
    expect(readHtml).toHaveBeenCalledTimes(1); // the comparison
  });

  it("compares after cleaning: quotes and padding do not count", async () => {
    const quoted = `${STUB}\n\nOn Mon, Nov 9, 2026 at 6:02 PM Alex Demo <demo@example.com> wrote:\n${"> I applied last week and wanted to ask about the next steps.\n".repeat(20)}`;
    const msg = message(multipart("multipart/alternative", [plain(quoted), html(REJECTION)]));
    expect((await parseGmailMessage(msg)).body).toBe(REJECTION_TEXT);
  });

  it("is not looked for outside multipart/alternative", async () => {
    // A plain-text body with an unrelated (inline) HTML part after it, in multipart/mixed.
    const msg = message(multipart("multipart/mixed", [plain(STUB), html(REJECTION)]));
    expect((await parseGmailMessage(msg)).body).toBe(STUB);
    expect(readHtml).not.toHaveBeenCalled();
    // Nor against an HTML attachment.
    const attached = html(REJECTION, { filename: "letter.html" });
    const alt = message(multipart("multipart/alternative", [plain(STUB), attached]));
    expect((await parseGmailMessage(alt)).body).toBe(STUB);
    expect(readHtml).not.toHaveBeenCalled();
  });

  it("keeps the plain text when converting the HTML would go over MAX_DECODED_BYTES", async () => {
    const big = `<p>${"We would like to invite you to an interview. ".repeat(Math.ceil(MAX_DECODED_BYTES / 45))}</p>`;
    expect(Buffer.byteLength(big)).toBeGreaterThan(MAX_DECODED_BYTES);
    const msg = message(multipart("multipart/alternative", [plain(STUB), html(big)]));
    expect(await parseGmailMessage(msg)).toMatchObject({ body: STUB, bodyTruncated: false });
    expect(readHtml).not.toHaveBeenCalled();
  });

  it("an empty plain-text alternative still gives way without a comparison", async () => {
    const msg = message(multipart("multipart/alternative", [plain(" \r\n"), html(REJECTION)]));
    expect((await parseGmailMessage(msg)).body).toBe(REJECTION_TEXT);
    expect(readHtml).toHaveBeenCalledTimes(1);
  });
});
