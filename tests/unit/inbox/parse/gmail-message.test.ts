import { describe, expect, it, vi } from "vitest";
import {
  MAX_ATTACHMENT_FETCH,
  MAX_BODY,
  MAX_DECODED_BYTES,
  MAX_PART_BYTES,
  parseGmailMessage,
} from "@/lib/server/inbox/parse/gmail-message";
import type { GmailMessage, GmailPart } from "@/lib/server/inbox/source/types";
import { MailSourceError } from "@/lib/server/inbox/sync/errors";
import { b64u, html, message, multipart, plain, sample, textPart } from "./build";

const From = "Jane Doe <jane@example.com>";

describe("parseGmailMessage: fields", () => {
  it("reads ids, labels, sender, subject and the received time from internalDate", async () => {
    const msg = message(
      plain("Hello"),
      {
        From: '"Doe, Jane" <Jane@Example.com>',
        "reply-to": "Talent <talent@company.example>",
        SUBJECT: "=?UTF-8?Q?Ihre_Bewerbung_=E2=80=93?=\r\n  Frontend",
        Date: "Mon, 2 Nov 2026 10:00:00 +0000",
      },
      { id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], internalDate: "1794480000000" },
    );
    const p = await parseGmailMessage(msg);
    expect(p).toMatchObject({
      gmailMessageId: "m1",
      gmailThreadId: "t1",
      labelIds: ["INBOX", "UNREAD"],
      fromName: "Doe, Jane",
      fromAddress: "jane@example.com",
      replyToAddress: "talent@company.example",
      subject: "Ihre Bewerbung – Frontend",
      body: "Hello",
      bodyTruncated: false,
      bulk: { listUnsubscribe: false, listId: null, precedence: null },
      contentLanguage: null,
    });
    expect(p.receivedAt.toISOString()).toBe(new Date(1794480000000).toISOString());
  });

  it("reads the bulk-mail headers", async () => {
    const p = await parseGmailMessage(
      message(plain("x"), {
        From,
        "List-Unsubscribe": "<mailto:u@example.com>",
        "List-ID": "JobRadar alerts <alerts.jobradar.example>",
        Precedence: " Bulk ",
      }),
    );
    expect(p.bulk).toEqual({ listUnsubscribe: true, listId: "alerts.jobradar.example", precedence: "bulk" });
    const bare = await parseGmailMessage(message(plain("x"), { "List-Id": "plain-list-id", "List-Unsubscribe": "  " }));
    expect(bare.bulk).toEqual({ listUnsubscribe: false, listId: "plain-list-id", precedence: null });
  });

  it.each([
    ["de-DE, en", "de"],
    ["EN", "en"],
    ["de_AT", "de"],
    ["x-klingon", null],
    ["", null],
    ["12", null],
  ])("Content-Language %j gives %j", async (value, expected) => {
    const p = await parseGmailMessage(message(plain("x"), { "Content-Language": value }));
    expect(p.contentLanguage).toBe(expected);
  });

  it("falls back to the body part's Content-Language", async () => {
    const part = plain("Hallo");
    part.headers!.push({ name: "Content-Language", value: "de" });
    const p = await parseGmailMessage(message(multipart("multipart/alternative", [part])));
    expect(p.contentLanguage).toBe("de");
  });

  it("uses internalDate, then the Date header, then the epoch", async () => {
    const withHeader = message(plain("x"), { Date: "Tue, 3 Nov 2026 09:00:00 +0100" }, { internalDate: "garbage" });
    expect((await parseGmailMessage(withHeader)).receivedAt.toISOString()).toBe("2026-11-03T08:00:00.000Z");
    const none = message(plain("x"), {}, { internalDate: "" });
    expect((await parseGmailMessage(none)).receivedAt.getTime()).toBe(0);
    const huge = message(plain("x"), {}, { internalDate: "9".repeat(30) });
    expect(Number.isNaN((await parseGmailMessage(huge)).receivedAt.getTime())).toBe(false);
  });

  it("leaves the reply-to null and the sender empty when they are unusable", async () => {
    const p = await parseGmailMessage(message(plain("x"), { From: "undisclosed-recipients:;", "Reply-To": "nobody" }));
    expect(p).toMatchObject({ fromName: "", fromAddress: "", replyToAddress: null });
  });
});

describe("parseGmailMessage: choosing the body", () => {
  it("prefers text/plain over text/html in multipart/alternative", async () => {
    const msg = message(multipart("multipart/alternative", [html("<p>From HTML</p>"), plain("From plain")]));
    expect((await parseGmailMessage(msg)).body).toBe("From plain");
  });

  it("uses text/html when there is no text/plain", async () => {
    const msg = message(
      multipart("multipart/mixed", [
        html('<p>Hi <a href="https://x.example/">there</a></p><img src="y.png">'),
        textPart("application/pdf", "%PDF", { filename: "cv.pdf" }),
      ]),
    );
    expect((await parseGmailMessage(msg)).body).toBe("Hi there");
  });

  it("walks depth-first and takes the first plain part", async () => {
    const msg = message(
      multipart("multipart/mixed", [
        multipart("multipart/related", [multipart("multipart/alternative", [plain("Deep first"), html("<p>Deep html</p>")])]),
        plain("Later plain"),
      ]),
    );
    expect((await parseGmailMessage(msg)).body).toBe("Deep first");
  });

  it("skips text parts that are attachments (a filename, or Content-Disposition: attachment)", async () => {
    const msg = message(
      multipart("multipart/mixed", [
        plain("notes.txt content", { filename: "notes.txt" }),
        plain("disposition content", { disposition: 'attachment; filename="x.txt"' }),
        html("<p>The real body</p>"),
      ]),
    );
    expect((await parseGmailMessage(msg)).body).toBe("The real body");
  });

  it("keeps an inline text part without a filename", async () => {
    const msg = message(multipart("multipart/mixed", [plain("Inline body", { disposition: "inline" })]));
    expect((await parseGmailMessage(msg)).body).toBe("Inline body");
  });

  it("does not take the body of an attached message (message/rfc822)", async () => {
    const attached: GmailPart = { ...multipart("message/rfc822", [plain("Forwarded plain")]), filename: "" };
    const msg = message(multipart("multipart/mixed", [attached, html("<p>Own HTML</p>")]));
    expect((await parseGmailMessage(msg)).body).toBe("Own HTML");
  });

  it("passes over a plain part that is empty or only padding", async () => {
    const msg = message(multipart("multipart/alternative", [plain(" ‌͏ \r\n"), html("<p>Real</p>")]));
    expect((await parseGmailMessage(msg)).body).toBe("Real");
  });

  it("reads a part without a Content-Type header by its mimeType", async () => {
    const part = plain("No header");
    part.headers = [];
    expect((await parseGmailMessage(message(part))).body).toBe("No header");
  });

  it("uses the snippet (entities decoded) when there is no text part", async () => {
    const msg = message(multipart("multipart/mixed", [textPart("image/png", "png", { filename: "a.png" })]), {}, {
      snippet: "I&#39;m &quot;here&quot; &amp; ready",
    });
    expect(await parseGmailMessage(msg)).toMatchObject({ body: 'I\'m "here" & ready', bodyTruncated: false });
  });
});

describe("parseGmailMessage: encodings", () => {
  it("decodes the part's charset", async () => {
    const msg = message(plain("", { charset: "ISO-8859-1", bytes: Buffer.from("Grüße aus München", "latin1") }));
    expect((await parseGmailMessage(msg)).body).toBe("Grüße aus München");
  });

  it("does not throw on an unknown charset", async () => {
    const msg = message(plain("Grüße", { charset: "x-made-up" }));
    expect((await parseGmailMessage(msg)).body).toBe("Grüße");
  });

  it("does not decode quoted-printable twice", async () => {
    const msg = message(plain("Price: 100=3D? No: a=b and Grüße", { cte: "quoted-printable" }));
    expect((await parseGmailMessage(msg)).body).toBe("Price: 100=3D? No: a=b and Grüße");
  });

  it("decodes quoted-printable that Gmail left encoded", async () => {
    const encoded = "Gr=C3=BC=C3=9Fe aus M=C3=BCnchen, this line is long enough to need a soft line=\r\n break.";
    const msg = message(plain(encoded, { cte: "quoted-printable" }));
    expect((await parseGmailMessage(msg)).body).toBe("Grüße aus München, this line is long enough to need a soft line break.");
  });

  it("decodes base64 that Gmail left encoded", async () => {
    const encoded = Buffer.from("Thank you for applying to Lumen Health.").toString("base64");
    const msg = message(plain(encoded, { cte: "base64" }));
    expect((await parseGmailMessage(msg)).body).toBe("Thank you for applying to Lumen Health.");
  });

  it("undoes format=flowed", async () => {
    const msg = message(
      plain("Thank you for \r\napplying to \r\nLumen Health.\r\n", { contentType: 'text/plain; charset=utf-8; format="flowed"' }),
    );
    expect((await parseGmailMessage(msg)).body).toBe("Thank you for applying to Lumen Health.");
  });
});

describe("parseGmailMessage: cleaning", () => {
  it("strips a quoted Gmail reply from an HTML-only message", async () => {
    const p = await parseGmailMessage(message(html(sample("gmail-reply.html"))));
    expect(p.body).toBe("Hi Alex,\n\nthanks, Wednesday at 3 pm works. I'll send you the video link tomorrow.\n\nBest,\nNoor");
  });

  it("strips a German Outlook reply block", async () => {
    const p = await parseGmailMessage(message(html(sample("outlook-reply-de.html"))));
    expect(p.body).toBe(
      "Hallo Alex,\n\nvielen Dank für Ihre Rückmeldung. Wir freuen uns auf das Gespräch am Donnerstag.\n\nBeste Grüße\nKatrin Vogel",
    );
    expect(p.body).not.toContain("leider");
  });

  it("keeps a Gmail forward whose subject does not say so", async () => {
    const text =
      "Hi Sam, see the note from the hiring manager below.\n\n---------- Forwarded message ---------\n" +
      "From: Dana Lee <dana@example.com>\nDate: Mon, 9 Nov 2026 at 18:02\nSubject: Sam\nTo: Recruiting <recruiting@example.com>\n\n" +
      "Please invite Sam for an interview next week.";
    const p = await parseGmailMessage(message(plain(text), { From: "Jo <jo@example.com>", Subject: "Next steps for Sam" }));
    expect(p.body).toBe(text);
  });

  it("strips an Outlook for Mac reply", async () => {
    const text =
      "Hi Alex,\n\nthanks, see you on Thursday.\n\nFrom: Alex Demo <demo@example.com>\nDate: Monday, 9 November 2026 at 18:02\n" +
      "To: Noor <noor@example.com>\nSubject: Re: Interview\n\nHi Noor, I applied last week. Unfortunately I cannot make Tuesday.";
    const p = await parseGmailMessage(message(plain(text), { From: "Noor <noor@example.com>", Subject: "Re: Interview" }));
    expect(p.body).toBe("Hi Alex,\n\nthanks, see you on Thursday.");
  });

  it("removes preheader padding and soft hyphens from an HTML template", async () => {
    const p = await parseGmailMessage(message(html(sample("marketing-preheader.html"))));
    expect(p.body.startsWith("Your application to Kelpie Analytics is in\n")).toBe(true);
    expect(p.body).toContain("We have received your application for the position Data Visualization Engineer.");
    expect(p.body).not.toMatch(/[­͏​‌ ]|https?:/);
  });
});

describe("parseGmailMessage: attachment references", () => {
  const refPart = (size: number, mime = "text/plain") => textPart(mime, "", { attachmentId: "att-1", size, bytes: Buffer.from("") });

  it("fetches a text part delivered as an attachment reference", async () => {
    const getAttachment = vi.fn(async (id: string) => (id === "att-1" ? b64u("Fetched body") : null));
    const p = await parseGmailMessage(message(refPart(12)), { getAttachment });
    expect(p.body).toBe("Fetched body");
    expect(getAttachment).toHaveBeenCalledWith("att-1");
  });

  it("does not fetch at MAX_ATTACHMENT_FETCH bytes or more: the snippet stands in", async () => {
    const getAttachment = vi.fn(async () => b64u("never"));
    const msg = message(refPart(MAX_ATTACHMENT_FETCH), {}, { snippet: "Snippet text" });
    expect(await parseGmailMessage(msg, { getAttachment })).toMatchObject({ body: "Snippet text", bodyTruncated: true });
    expect(getAttachment).not.toHaveBeenCalled();
  });

  it("uses the snippet without a fetcher, and when the attachment is gone", async () => {
    const msg = message(refPart(10), {}, { snippet: "Snippet text" });
    expect(await parseGmailMessage(msg)).toMatchObject({ body: "Snippet text", bodyTruncated: true });
    expect(await parseGmailMessage(msg, { getAttachment: async () => null })).toMatchObject({ body: "Snippet text" });
  });

  it("tries an inline HTML alternative before the snippet", async () => {
    const msg = message(multipart("multipart/alternative", [refPart(MAX_ATTACHMENT_FETCH + 1), html("<p>Inline HTML</p>")]));
    expect((await parseGmailMessage(msg)).body).toBe("Inline HTML");
  });

  it("passes a mail source failure on, so the engine can retry", async () => {
    const err = new MailSourceError("temporary", "rate_limited");
    await expect(parseGmailMessage(message(refPart(10)), { getAttachment: async () => Promise.reject(err) })).rejects.toBe(err);
  });

  it("never fetches a non-text attachment", async () => {
    const getAttachment = vi.fn(async () => b64u("x"));
    const pdf = textPart("application/pdf", "", { attachmentId: "pdf", size: 10, filename: "offer.pdf" });
    await parseGmailMessage(message(multipart("multipart/mixed", [plain("Body"), pdf])), { getAttachment });
    expect(getAttachment).not.toHaveBeenCalled();
  });
});

describe("parseGmailMessage: malformed and hostile input", () => {
  it.each<[string, unknown]>([
    ["no payload", { id: "a", threadId: "b", internalDate: "1" }],
    ["an empty object", {}],
    ["null", null],
    ["payload without headers or body", { id: "a", threadId: "a", internalDate: "1", payload: { mimeType: "text/plain" } }],
    ["parts that are not parts", { id: "a", threadId: "a", internalDate: "1", payload: { mimeType: "multipart/mixed", parts: [null, 5, "x", {}] } }],
    ["headers that are not headers", { id: "a", threadId: "a", internalDate: "1", payload: { mimeType: "text/plain", headers: "From: x", body: { data: 5 } } }],
    ["a body that is not base64", { id: "a", threadId: "a", internalDate: "1", payload: { mimeType: "text/plain", body: { size: 3, data: "!!!***" } } }],
    ["labels that are not strings", { id: 7, threadId: null, labelIds: [1, "INBOX", null], internalDate: "1", payload: { mimeType: "text/plain" } }],
  ])("does not throw on %s", async (_name, msg) => {
    const p = await parseGmailMessage(msg as GmailMessage);
    expect(typeof p.body).toBe("string");
    expect(Number.isNaN(p.receivedAt.getTime())).toBe(false);
    expect(p.labelIds.every((l) => typeof l === "string")).toBe(true);
  });

  it("handles parts nested thousands deep, quickly", async () => {
    let part: GmailPart = plain("Too deep to reach");
    for (let i = 0; i < 5_000; i++) part = multipart("multipart/mixed", [part]);
    const started = Date.now();
    const p = await parseGmailMessage(message(part, {}, { snippet: "From the snippet" }));
    expect(p.body).toBe("From the snippet");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("handles a message with very many parts", async () => {
    const parts = Array.from({ length: 10_000 }, () => textPart("image/png", "x", { filename: "x.png" }));
    const p = await parseGmailMessage(message(multipart("multipart/mixed", [...parts, plain("Never reached")]), {}, { snippet: "S" }));
    expect(p.body).toBe("S");
  });

  it("cuts a huge part and marks the body truncated", async () => {
    const huge = "Line of text.\n".repeat(Math.ceil((MAX_PART_BYTES * 3) / 14));
    const started = Date.now();
    const p = await parseGmailMessage(message(plain(huge)));
    expect(p.body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(p.bodyTruncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("stops trying parts after MAX_DECODED_BYTES of them, and marks the body truncated", async () => {
    // HTML parts that convert to nothing: 18 of a megabyte each, one message, took 13 to 22
    // seconds of conversion before the budget.
    const empty = html("<br>".repeat(Math.floor(MAX_PART_BYTES / 4)));
    const parts = [...Array.from({ length: Math.ceil(MAX_DECODED_BYTES / MAX_PART_BYTES) + 1 }, () => empty), plain("Out of reach")];
    const started = Date.now();
    const p = await parseGmailMessage(message(multipart("multipart/mixed", parts), {}, { snippet: "From the snippet" }));
    expect(p).toMatchObject({ body: "From the snippet", bodyTruncated: true });
    expect(Date.now() - started).toBeLessThan(15_000);
    // Small parts are all tried.
    const small = [...Array.from({ length: 50 }, () => html("<br>")), plain("Reached")];
    expect(await parseGmailMessage(message(multipart("multipart/mixed", small)))).toMatchObject({ body: "Reached", bodyTruncated: false });
  }, 30_000);

  it("cuts a long body at MAX_BODY and marks it", async () => {
    const p = await parseGmailMessage(message(plain("word ".repeat(10_000))));
    expect(p.body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(p.bodyTruncated).toBe(true);
  });

  it("cuts a huge subject and keeps NUL out of every field", async () => {
    const p = await parseGmailMessage(
      message(plain("a\u0000b"), { Subject: `x\u0000${"y".repeat(5_000)}`, From: "N\u0000ame <a@example.com>" }),
    );
    expect(p.subject.length).toBeLessThanOrEqual(1_000);
    expect(JSON.stringify(p)).not.toContain("\\u0000");
  });

  it("survives random junk", async () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const junk = (depth: number): unknown => {
      const r = rand();
      if (depth > 4 || r < 0.2) return [null, 0, "", "x", true, [], {}][Math.floor(rand() * 7)];
      if (r < 0.4) return Array.from({ length: Math.floor(rand() * 4) }, () => junk(depth + 1));
      const keys = ["mimeType", "parts", "headers", "body", "data", "size", "attachmentId", "filename", "name", "value"];
      return Object.fromEntries(keys.filter(() => rand() < 0.5).map((k) => [k, junk(depth + 1)]));
    };
    for (let i = 0; i < 300; i++) {
      const msg = { id: "a", threadId: "a", internalDate: "1", payload: junk(0) } as unknown as GmailMessage;
      await expect(parseGmailMessage(msg, { getAttachment: async () => null })).resolves.toBeDefined();
    }
  });
});
