import { describe, expect, it } from "vitest";
import { parseGmailMessage } from "@/lib/server/inbox/parse/gmail-message";
import { MAX_DEPTH } from "@/lib/server/inbox/parse/html";
import { cleanBody, isForwardSubject } from "@/lib/server/inbox/parse/quoted";
import { html, message, multipart, plain } from "./build";

// Findings of the review of step 2.2, one block each, with the reviewer's input. Each input lost
// the text that matters before the fix: the comment above it says how.

describe("review 6: quoted-reply stripping keeps the sender's own text", () => {
  // "Am 14. März …" joined with the next line read as a German reply header ("Am … schrieb …:"),
  // so the invitation was cut and the mail read like a mere confirmation.
  it("does not take sentences joined over lines for a reply header", () => {
    const de = [
      "Sehr geehrte Frau Schmidt,",
      "",
      "vielen Dank für Ihre Bewerbung.",
      "Am 14. März um 10 Uhr möchten wir Sie zu einem Vorstellungsgespräch einladen.",
      "Ihre künftige Teamleiterin schrieb uns dazu:",
      "Ich freue mich auf das Gespräch.",
      "",
      "Mit freundlichen Grüßen",
    ].join("\n");
    expect(cleanBody(de).body).toBe(de.replace("\n\n\n", "\n\n"));
    const en = [
      "Hi Sam,",
      "On Monday 3 March at 10:00 you will meet the team for the interview.",
      "Here is what the hiring manager wrote:",
      "We are excited to meet you.",
    ].join("\n");
    expect(cleanBody(en).body).toBe(en);
  });

  it("still cuts a wrapped header that names an address", () => {
    const text = "Thanks!\n\nOn Mon, Nov 9, 2026 at 6:02 PM Alex Demo with a long name\n<demo@example.com> wrote:\n> Hi";
    expect(cleanBody(text).body).toBe("Thanks!");
    const de = "Danke!\n\nAm Mo., 9. Nov. 2026 um 18:02 Uhr schrieb Alex Demo\n<demo@example.com>:\n> Hallo";
    expect(cleanBody(de).body).toBe("Danke!");
  });

  // An Outlook forward ("see below", then a From:/Sent: block) lost everything below the note.
  const forward = [
    "Hi Sam, see below from the hiring manager.",
    "",
    "From: Dana Lee",
    "Sent: Monday, March 3, 2026 10:00 AM",
    "To: Recruiting",
    "Subject: Sam",
    "",
    "Please invite Sam for an interview next week.",
  ].join("\n");

  it("keeps a forwarded message below an Outlook header block", () => {
    expect(cleanBody(forward, undefined, { forwarded: true }).body).toBe(forward);
    // A reply (no forward marker) is still cut there.
    expect(cleanBody(forward).body).toBe("Hi Sam, see below from the hiring manager.");
  });

  it("knows a forward by its subject, in the languages the stripper reads", () => {
    for (const subject of ["FW: Sam", "Fwd: Sam", "fw:Sam", "WG: Sam", "TR: Sam", "RV: Sam", "Doorst: Sam", " FWD : Sam"]) {
      expect(isForwardSubject(subject), subject).toBe(true);
    }
    for (const subject of ["RE: FW: Sam", "AW: WG: Sam", "Sam", "Forward planning", "TRAINING: Sam", ""]) {
      expect(isForwardSubject(subject), subject).toBe(false);
    }
  });

  it("reads the subject when parsing a message", async () => {
    const fw = await parseGmailMessage(message(plain(forward), { From: "Jo <jo@example.com>", Subject: "FW: Sam" }));
    expect(fw.body).toContain("Please invite Sam for an interview next week.");
    const re = await parseGmailMessage(message(plain(forward), { From: "Jo <jo@example.com>", Subject: "RE: Sam" }));
    expect(re.body).toBe("Hi Sam, see below from the hiring manager.");
  });
});

describe("review 8: the body of an HTML mail with a plain-text footer part", () => {
  // multipart/mixed [text/html body, text/plain disclaimer]: every text/plain part came before
  // every text/html part, so the body was the disclaimer.
  it("takes the first readable part, preferring text/plain only among alternatives", async () => {
    const msg = message(
      multipart("multipart/mixed", [
        html("<p>We would like to invite you to an interview on Monday.</p>"),
        plain("This message is confidential. If you are not the intended recipient, delete it."),
      ]),
      { From: "Acme <jobs@acme.example>", Subject: "Your application" },
      { snippet: "We would like to invite you" },
    );
    expect((await parseGmailMessage(msg)).body).toBe("We would like to invite you to an interview on Monday.");
  });

  it("still prefers text/plain inside multipart/alternative, also nested", async () => {
    const msg = message(
      multipart("multipart/mixed", [
        multipart("multipart/alternative", [
          multipart("multipart/related", [html("<p>Body as HTML</p>")]),
          plain("Body as text"),
        ]),
        plain("Footer"),
      ]),
    );
    expect((await parseGmailMessage(msg)).body).toBe("Body as text");
  });
});

describe("review 9a: HTML cut at the nesting limit marks the body truncated", () => {
  // The depth cut left out the rest of the mail without saying so.
  it("marks the body truncated when the HTML nests too deep", async () => {
    const deep = `<p>Visible part.</p>${"<div>".repeat(MAX_DEPTH + 10)}hidden${"</div>".repeat(MAX_DEPTH + 10)}`;
    const p = await parseGmailMessage(message(html(deep)));
    expect(p).toMatchObject({ body: "Visible part.", bodyTruncated: true });
    const normal = await parseGmailMessage(message(html("<div><p>All of it.</p></div>")));
    expect(normal).toMatchObject({ body: "All of it.", bodyTruncated: false });
  });
});
