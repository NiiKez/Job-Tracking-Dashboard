import { describe, expect, it } from "vitest";
import { MAX_BODY, cleanBody, stripPadding, stripQuoted, unflowText } from "@/lib/server/inbox/parse/quoted";

const own = "Hi Alex,\n\nWednesday at 3 pm works.\n\nNoor";

describe("stripQuoted", () => {
  it.each([
    ["Gmail, English", "On Mon, Nov 9, 2026 at 6:02 PM Alex Demo <demo@example.com> wrote:\n> Hi Noor,\n> could we move it?"],
    ["Gmail, wrapped header", "On Mon, Nov 9, 2026 at 6:02 PM Alex Demo with a long name <demo@example.com>\nwrote:\n\n> Hi Noor"],
    ["Apple Mail", "On 9. Nov 2026, at 18:02, Alex Demo <demo@example.com> wrote:\n\n> Hi Noor"],
    ["Gmail, German", "Am Mo., 9. Nov. 2026 um 18:02 Uhr schrieb Alex Demo <demo@example.com>:\n> Hallo Noor"],
    ["Thunderbird, German", "Am 09.11.26 um 18:02 schrieb Alex Demo:\n> Hallo Noor"],
    ["French", "Le lun. 9 nov. 2026 à 18:02, Alex Demo <demo@example.com> a écrit :\n> Bonjour"],
    ["Spanish", "El lun, 9 nov 2026 a las 18:02, Alex Demo (<demo@example.com>) escribió:\n> Hola"],
    ["Dutch", "Op ma 9 nov 2026 om 18:02 schreef Alex Demo <demo@example.com>:\n> Hallo"],
    ["Outlook separator", "-----Original Message-----\nFrom: Alex Demo\nSent: Monday\nI was writing about the interview"],
    ["Outlook separator, German", "-----Ursprüngliche Nachricht-----\nVon: Alex Demo\nIch schrieb über das Vorstellungsgespräch"],
    [
      "Outlook block, English",
      "________________________________\nFrom: Alex Demo <demo@example.com>\nSent: Monday, November 9, 2026 6:02 PM\nTo: Noor\nSubject: Interview\n\nHi Noor, about the interview",
    ],
    [
      "Outlook block, German",
      "Von: Alex Demo <demo@example.com>\nGesendet: Montag, 9. November 2026 18:02\nAn: Noor\nBetreff: Vorstellungsgespräch\n\nHallo Noor",
    ],
    ["Outlook block, bold and on one line", "*From:* Alex Demo <demo@example.com> *Sent:* Monday 18:02 *To:* Noor\nHi Noor"],
    [
      "Outlook on the web block, Spanish",
      "De: Alex Demo <demo@example.com>\nEnviado el: lunes, 9 de noviembre de 2026 18:02\nPara: Noor\nAsunto: Entrevista\n\nHola Noor",
    ],
    [
      "Outlook for Mac block, English",
      "From: Alex Demo <demo@example.com>\nDate: Monday, 9 November 2026 at 18:02\nTo: Noor <noor@example.com>\nSubject: Re: Interview\n\nHi Noor, about the interview",
    ],
    [
      "Outlook for Mac block, German",
      "Von: Alex Demo <demo@example.com>\nDatum: Montag, 9. November 2026 um 18:02\nAn: Noor <noor@example.com>\nBetreff: AW: Vorstellungsgespräch\n\nHallo Noor",
    ],
    [
      "Outlook for Mac block, Spanish",
      "De: Alex Demo <demo@example.com>\nFecha: lunes, 9 de noviembre de 2026, 18:02\nPara: Noor\nAsunto: Entrevista\n\nHola Noor",
    ],
    ["Outlook for Mac block, bold", "*From:* Alex Demo <demo@example.com>\n*Date:* Monday, 9 November 2026 at 18:02\n\nHi Noor"],
  ])("cuts a %s reply header and everything below", (_name, quote) => {
    const text = `${own}\n\n${quote}`;
    expect(stripQuoted(text).trim()).toBe(own);
  });

  it.each([
    [
      "Gmail",
      "---------- Forwarded message ---------\nFrom: Dana Lee <dana@example.com>\nDate: Mon, 9 Nov 2026 at 18:02\nSubject: Sam\nTo: Recruiting <recruiting@example.com>",
    ],
    [
      "Gmail, German",
      "---------- Weitergeleitete Nachricht ---------\nVon: Dana Lee <dana@example.com>\nDate: Mo., 9. Nov. 2026 um 18:02 Uhr\nSubject: Sam\nTo: <recruiting@example.com>",
    ],
    [
      "Gmail, Spanish",
      "---------- Mensaje reenviado ---------\nDe: Dana Lee <dana@example.com>\nDate: lun, 9 nov 2026 a las 18:02\nSubject: Sam\nTo: <recruiting@example.com>",
    ],
    [
      "Apple Mail",
      "Begin forwarded message:\n\nFrom: Dana Lee <dana@example.com>\nSubject: Sam\nDate: 9 November 2026 at 18:02:00 CET\nTo: Recruiting <recruiting@example.com>",
    ],
    [
      "Thunderbird, French",
      "-------- Message transféré --------\nDe : Dana Lee <dana@example.com>\nDate : lun. 9 nov. 2026 18:02\nÀ : Recruiting",
    ],
  ])("keeps a From/Date block below a %s forwarded-message line", (_name, header) => {
    const text = `Hi Sam, see the note from the hiring manager below.\n\n${header}\n\nPlease invite Sam for an interview next week.`;
    expect(stripQuoted(text)).toBe(text);
  });

  it("still cuts a From/Date reply block that comes before a forwarded message", () => {
    const text = `${own}\n\nFrom: Alex Demo <demo@example.com>\nDate: Monday, 9 November 2026 at 18:02\nSubject: Fwd: Sam\n\n---------- Forwarded message ---------\nFrom: Dana Lee <dana@example.com>\nDate: Mon, 9 Nov 2026\n\nPlease invite Sam.`;
    expect(stripQuoted(text).trim()).toBe(own);
  });

  it("keeps an Outlook for Mac block in a mail whose subject marks a forward", () => {
    const text = `${own}\n\nFrom: Dana Lee <dana@example.com>\nDate: Monday, 9 November 2026 at 18:02\n\nPlease invite Sam.`;
    expect(stripQuoted(text, { forwarded: true })).toBe(text);
  });

  it("removes '>' lines anywhere (inline replies)", () => {
    expect(stripQuoted("> Can you do Tuesday?\nYes, Tuesday works.\n> And the address?\nMain street 1.")).toBe(
      "Yes, Tuesday works.\nMain street 1.",
    );
  });

  it("keeps a forwarded message: it is content", () => {
    const text =
      "FYI, see below.\n\n---------- Forwarded message ---------\nFrom: Hiring <jobs@example.com>\nDate: Mon, 9 Nov 2026 at 10:00\nSubject: Interview\n\nWe would like to invite you to an interview.";
    expect(stripQuoted(text)).toBe(text);
  });

  it("does not cut a header that has nothing of the sender's above it", () => {
    const text = "On Mon, Nov 9, 2026 at 6:02 PM Alex <demo@example.com> wrote:\nThe interview is on Tuesday.";
    expect(stripQuoted(text)).toBe(text);
  });

  it("keeps the quote when it is all there is", () => {
    expect(stripQuoted("> only quoted\n> text")).toBe("> only quoted\n> text");
  });

  it("needs a date in an attribution line, so ordinary sentences stay", () => {
    const text = "Hi,\n\nOn second thought, here is what I wrote:\nthe interview is on Tuesday.";
    expect(stripQuoted(text)).toBe(text);
  });

  it("does not take a From: line without Sent: or a dated Date: for an Outlook block", () => {
    const text = "Hi,\n\nFrom: the team at Lumen Health\nDate: soon\nWe look forward to meeting you.";
    expect(stripQuoted(text)).toBe(text);
  });
});

describe("stripPadding", () => {
  it("removes zero-width, soft-hyphen and grapheme-joiner padding and control characters", () => {
    expect(stripPadding("Bewer­bung​‌͏⁠﻿\u0000\u0007!")).toBe("Bewerbung!");
  });

  it("removes literal &zwnj; filler and turns &nbsp; and space-like characters into spaces", () => {
    expect(stripPadding("a&zwnj;&nbsp;&#847;&zwnj;b c d⠀e")).toBe("a b c d e");
  });

  it("keeps emoji sequences joined", () => {
    expect(stripPadding("👩‍💻 dev‍")).toBe("👩‍💻 dev");
    // With a skin tone between the person and the joiner.
    expect(stripPadding("\u{1F9D1}\u{1F3FD}\u200D\u{1F4BB} dev")).toBe("\u{1F9D1}\u{1F3FD}\u200D\u{1F4BB} dev");
  });
});

describe("unflowText (format=flowed)", () => {
  it("joins soft breaks and removes space stuffing", () => {
    expect(unflowText("Thank you for \napplying.\n From the team\n-- \nSig", false)).toBe(
      "Thank you for applying.\nFrom the team\n-- \nSig",
    );
  });

  it("with delsp=yes, removes the space at a soft break", () => {
    expect(unflowText("Bewer \nbung", true)).toBe("Bewerbung");
  });

  it("leaves quoted lines alone", () => {
    expect(unflowText("Mine \n> theirs \n> more", false)).toBe("Mine \n> theirs \n> more");
  });
});

describe("cleanBody", () => {
  it("normalises line endings, whitespace and blank lines", () => {
    expect(cleanBody("\r\n\r\n  Hi,\r\n\r\n\r\n\r\nThanks\t\t for   applying.   \r\nBye\r\n\r\n").body).toBe(
      "Hi,\n\nThanks for applying.\nBye",
    );
  });

  it("strips quotes and padding before cutting", () => {
    const quoted = `> ${"x".repeat(30_000)}`;
    const result = cleanBody(`Short reply.‌‌\n\nOn Mon, 9 Nov 2026 at 18:02 Alex <a@example.com> wrote:\n${quoted}`);
    expect(result).toEqual({ body: "Short reply.", truncated: false });
  });

  it("cuts at MAX_BODY characters without splitting a surrogate pair", () => {
    const long = "a".repeat(MAX_BODY - 1) + "😀" + "b".repeat(100);
    const { body, truncated } = cleanBody(long);
    expect(truncated).toBe(true);
    expect(body).toBe("a".repeat(MAX_BODY - 1));
    expect(cleanBody("a".repeat(MAX_BODY)).truncated).toBe(false);
  });

  it("makes lone surrogates well-formed", () => {
    expect(cleanBody("x\ud83dy").body).toBe("x�y");
  });
});
