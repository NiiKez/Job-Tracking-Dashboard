import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseGmailMessage } from "@/lib/server/inbox/parse/gmail-message";
import { HISTORY_BASE, createFixtureSource } from "@/lib/server/inbox/source/fixture-source";
import type { GmailMessage, GmailPart } from "@/lib/server/inbox/source/types";
import { MailSourceError, isMailSourceError } from "@/lib/server/inbox/sync/errors";

const DAY = 86_400_000;
const DIR = path.join(import.meta.dirname, "../../../fixtures/mail");
const NOW = new Date("2026-11-20T12:00:00Z");
const source = (now = NOW, extra = {}) => createFixtureSource({ dir: DIR, now: () => now, ...extra });

async function all(src = source()) {
  const { messageIds } = await src.listAddedSince(String(HISTORY_BASE));
  return Promise.all(messageIds.map(async (id) => (await src.getMessage(id))!));
}

/**
 * The mail the mock store delivered on "Check inbox now" (INCOMING in db/seed/fixtures.ts until
 * step 2.2 moved it here), exactly as the mock had it.
 */
const INCOMING = [
  {
    fromName: "Ember Finance Talent",
    fromAddress: "talent@emberfinance.co.example",
    subject: "Interview invitation: Software Engineer",
    body: "Hi,\n\nThanks for applying to Ember Finance. We'd love to schedule a call with one of our engineering managers. What's your availability this week?\n\nEmber Finance",
  },
  {
    fromName: "Brightline Energy",
    fromAddress: "jobs@brightline-energy.example",
    subject: "Ihre Bewerbung bei Brightline Energy",
    body: "Guten Tag,\n\nleider können wir Ihre Bewerbung nicht weiter berücksichtigen. Wir haben uns für andere Kandidaten entschieden.\n\nMit freundlichen Grüßen\nBrightline Energy",
  },
  {
    fromName: "Driftwood Audio Careers",
    fromAddress: "careers@driftwoodaudio.example",
    subject: "Thank you for applying – Frontend Engineer",
    body: "Hi,\n\nThank you for applying for the Frontend Engineer role at Driftwood Audio. We received your application and will review it shortly.\n\nDriftwood Audio",
  },
  {
    fromName: "JobRadar",
    fromAddress: "alerts@jobradar-mail.example",
    subject: "12 new jobs match your search",
    body: "New this week for 'frontend Berlin': 12 jobs. Unsubscribe anytime.",
  },
];

const header = (m: GmailMessage, name: string) => m.payload?.headers?.find((h) => h.name === name)?.value;

describe("the fixtures in fixtures/mail", () => {
  it("parse to exactly the mock's queued demo emails (INCOMING)", async () => {
    const src = source();
    const parsed = await Promise.all(
      (await all(src)).map((m) => parseGmailMessage(m, { getAttachment: (a) => src.getAttachment(m.id, a) })),
    );
    for (const mail of INCOMING) {
      const match = parsed.find((p) => p.subject === mail.subject);
      expect(match, mail.subject).toBeDefined();
      expect({ fromName: match!.fromName, fromAddress: match!.fromAddress, subject: match!.subject, body: match!.body }).toEqual({
        fromName: mail.fromName,
        fromAddress: mail.fromAddress,
        subject: mail.subject,
        body: mail.body,
      });
    }
    const alert = parsed.find((p) => p.fromAddress === "alerts@jobradar-mail.example")!;
    expect(alert.bulk.listUnsubscribe).toBe(true);
    expect(alert.bulk.listId).toBe("alerts.jobradar-mail.example");
  });

  it("use invented addresses and domains only, in headers and in every text part", async () => {
    const src = source();
    for (const m of await all(src)) {
      // Every text part decoded (attachment references through the source), as one text.
      const texts: string[] = [JSON.stringify(m.payload?.headers)];
      const walk = async (part: GmailPart | undefined): Promise<void> => {
        if (!part) return;
        const data = part.body?.data ?? (part.body?.attachmentId && (await src.getAttachment(m.id, part.body.attachmentId)));
        if (part.mimeType.startsWith("text/") && data) texts.push(Buffer.from(data, "base64url").toString("latin1"));
        for (const child of part.parts ?? []) await walk(child);
      };
      await walk(m.payload);
      const text = texts.join("\n");
      const domains = [
        ...(text.match(/[\w.+-]+@[\w.-]*\w/g) ?? []).map((a) => a.slice(a.indexOf("@") + 1)),
        ...(text.match(/https?:\/\/[\w.-]*\w/g) ?? []).map((u) => u.replace(/^https?:\/\//, "")),
      ];
      expect(domains.length, m.id).toBeGreaterThan(0);
      for (const d of domains) expect(d, `${m.id}: ${d}`).toMatch(/^(([\w-]+\.)*example\.(com|org|net)|([\w-]+\.)*[\w-]+\.example)$/i);
    }
  });

  it("all parse to a non-empty body without truncation", async () => {
    const src = source();
    for (const m of await all(src)) {
      const p = await parseGmailMessage(m, { getAttachment: (a) => src.getAttachment(m.id, a) });
      expect(p.body.length, m.id).toBeGreaterThan(20);
      expect(p.bodyTruncated, m.id).toBe(false);
      expect(p.fromAddress, m.id).not.toBe("");
    }
  });

  it("cover the cases the plan asks for", async () => {
    const src = source();
    const msgs = await all(src);
    const parsed = await Promise.all(msgs.map((m) => parseGmailMessage(m, { getAttachment: (a) => src.getAttachment(m.id, a) })));
    const by = (pred: (m: GmailMessage) => boolean) => msgs.filter(pred);
    expect(by((m) => m.payload?.mimeType === "text/html")).toHaveLength(1); // HTML only
    expect(by((m) => m.payload?.mimeType === "multipart/alternative").length).toBeGreaterThan(1);
    expect(by((m) => /iso-8859-1/i.test(JSON.stringify(m.payload)))).toHaveLength(1);
    expect(by((m) => (m.labelIds ?? []).includes("SENT"))).toHaveLength(1);
    expect(by((m) => JSON.stringify(m.payload).includes('"attachmentId"')).length).toBe(1);
    // A reply in the thread of the SENT message, with its quote stripped.
    const sent = by((m) => (m.labelIds ?? []).includes("SENT"))[0];
    const reply = parsed.find((p) => p.gmailThreadId === sent.threadId && p.gmailMessageId !== sent.id)!;
    expect(reply.body).not.toMatch(/wrote:|^>/m);
    // The ATS sender with a Reply-To at the company.
    expect(parsed.some((p) => p.fromAddress.endsWith("greenhouse-mail.example") && p.replyToAddress)).toBe(true);
    // A German subject from an encoded word.
    expect(parsed.some((p) => p.subject.startsWith("Terminbestätigung"))).toBe(true);
    // The personal mail's quoted interview mention is gone.
    const personal = parsed.find((p) => p.fromAddress === "sam.rivera@example.com")!;
    expect(personal.body).not.toContain("Vorstellungsgespräch");
  });
});

describe("createFixtureSource", () => {
  it("reads nothing until it is used", () => {
    expect(() => createFixtureSource({ dir: "/no/such/folder" })).not.toThrow();
  });

  it("answers the profile with the highest history id", async () => {
    const files = (await all()).length;
    expect(await source().getProfile()).toEqual({ emailAddress: "demo@example.com", historyId: String(HISTORY_BASE + files) });
    expect((await source(NOW, { emailAddress: "owner@example.org" }).getProfile()).emailAddress).toBe("owner@example.org");
  });

  it("moves dates by whole days so the newest message falls within the day before now", async () => {
    for (const now of [NOW, new Date("2026-11-13T00:00:00Z"), new Date("2027-03-01T23:59:00Z"), new Date("2026-11-12T09:30:00Z")]) {
      const dates = (await all(source(now))).map((m) => Number(m.internalDate));
      const newest = Math.max(...dates);
      expect(newest).toBeLessThanOrEqual(now.getTime());
      expect(newest).toBeGreaterThan(now.getTime() - DAY);
    }
    const unshifted = (await all(source(NOW, { shiftDates: false }))).map((m) => Number(m.internalDate));
    const shifted = (await all(source(NOW))).map((m) => Number(m.internalDate));
    const offsets = new Set(shifted.map((d, i) => d - unshifted[i]));
    expect(offsets.size).toBe(1);
    expect([...offsets][0] % DAY).toBe(0);
  });

  it("moves the Date header with internalDate and keeps its zone", async () => {
    const src = source();
    const before = (await source(NOW, { shiftDates: false }).getMessage("19a6d2c4e8f1a007"))!;
    const after = (await src.getMessage("19a6d2c4e8f1a007"))!;
    const shift = Number(after.internalDate) - Number(before.internalDate);
    expect(Date.parse(header(after, "Date")!) - Date.parse(header(before, "Date")!)).toBe(shift);
    expect(header(after, "Date")).toMatch(/^\w{3}, \d{1,2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0100$/);
  });

  it("is deterministic for the same files and the same now", async () => {
    expect(JSON.stringify(await all(source()))).toBe(JSON.stringify(await all(source())));
    expect(await source().listMessageIds(new Date(0))).toEqual(await source().listMessageIds(new Date(0)));
  });

  it("lists by date, without sent mail, drafts, chats, spam or trash", async () => {
    const msgs = await all();
    const ids = await source().listMessageIds(new Date(NOW.getTime() - 30 * DAY));
    const sent = msgs.filter((m) => m.labelIds?.includes("SENT")).map((m) => m.id);
    expect(sent).toHaveLength(1);
    expect(ids).toHaveLength(msgs.length - 1);
    expect(ids).not.toContain(sent[0]);
    // `after` is respected: only mail received after it.
    const dates = msgs.filter((m) => !sent.includes(m.id)).map((m) => Number(m.internalDate)).sort((a, b) => a - b);
    const cut = new Date(dates[5]);
    const later = await source().listMessageIds(cut);
    expect(later).toHaveLength(dates.length - 6);
    for (const id of later) expect(Number(msgs.find((m) => m.id === id)!.internalDate)).toBeGreaterThan(cut.getTime());
    expect(await source().listMessageIds(NOW)).toEqual([]);
  });

  it("numbers history in date order and lists what was added after a start id", async () => {
    const msgs = await all();
    const historyIds = msgs.map((m) => Number(m.historyId));
    expect(historyIds).toEqual(historyIds.map((_, i) => HISTORY_BASE + i + 1));
    const dates = msgs.map((m) => Number(m.internalDate));
    expect(dates).toEqual([...dates].sort((a, b) => a - b));

    const src = source();
    const profile = await src.getProfile();
    expect(await src.listAddedSince(profile.historyId)).toEqual({ messageIds: [], historyId: profile.historyId });
    const lastThree = await src.listAddedSince(String(Number(profile.historyId) - 3));
    expect(lastThree).toEqual({ messageIds: msgs.slice(-3).map((m) => m.id), historyId: profile.historyId });
    // History reports sent mail too, as Gmail's does.
    const everything = await src.listAddedSince(String(HISTORY_BASE));
    expect(everything.messageIds).toHaveLength(msgs.length);
  });

  it("throws history_expired below the oldest id, on a malformed id, or when told to", async () => {
    const expired = async (p: Promise<unknown>) => {
      const err = await p.catch((e: unknown) => e);
      expect(isMailSourceError(err, "history_expired")).toBe(true);
      expect((err as MailSourceError).code).toBe("history_expired");
    };
    await expired(source().listAddedSince("1"));
    await expired(source().listAddedSince("not-a-number"));
    await expired(source().listAddedSince(""));
    await expired(source(NOW, { historyExpired: true }).listAddedSince(String(HISTORY_BASE + 5)));
  });

  it("answers null for an unknown message or attachment, and serves attachment data", async () => {
    const src = source();
    expect(await src.getMessage("no-such-id")).toBeNull();
    expect(await src.getAttachment("no-such-id", "x")).toBeNull();
    const offer = (await all(src)).find((m) => JSON.stringify(m.payload).includes('"attachmentId"'))!;
    const ids = [...JSON.stringify(offer.payload).matchAll(/"attachmentId":"([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) expect(await src.getAttachment(offer.id, id)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await src.getAttachment(offer.id, "unknown")).toBeNull();
  });

  it("removes the _ keys and hands out copies", async () => {
    const src = source();
    const [first] = await all(src);
    expect(Object.keys(first).some((k) => k.startsWith("_"))).toBe(false);
    first.payload!.headers = [];
    first.labelIds!.push("CHANGED");
    const again = (await src.getMessage(first.id))!;
    expect(again.payload!.headers!.length).toBeGreaterThan(0);
    expect(again.labelIds).not.toContain("CHANGED");
  });

  it("serves messages given in memory", async () => {
    const msg = (id: string, internalDate: string, labelIds = ["INBOX"]): GmailMessage => ({ id, threadId: id, labelIds, internalDate });
    const src = createFixtureSource({
      messages: [msg("b", "2000"), msg("a", "1000"), { ...msg("c", "3000", ["SPAM"]), _attachments: { att: "eA" } }],
      now: () => new Date(3000 + 5 * DAY),
    });
    expect(await src.listAddedSince(String(HISTORY_BASE))).toEqual({ messageIds: ["a", "b", "c"], historyId: String(HISTORY_BASE + 3) });
    expect(await src.listMessageIds(new Date(0))).toEqual(["b", "a"]);
    expect((await src.getMessage("a"))!.internalDate).toBe(String(1000 + 5 * DAY));
    expect(await src.getAttachment("c", "att")).toBe("eA");
  });

  describe("broken setups", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fixture-source-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("a missing folder is a setup error", async () => {
      const err = await createFixtureSource({ dir: path.join(dir, "missing") }).getProfile().catch((e: unknown) => e);
      expect(isMailSourceError(err, "setup")).toBe(true);
      expect((err as MailSourceError).code).toBe("fixtures_missing");
    });

    it("a broken file is a setup error naming the file, and is read again once fixed", async () => {
      const file = path.join(dir, "broken.json");
      writeFileSync(file, "{ nope");
      const src = createFixtureSource({ dir });
      const err = await src.getProfile().catch((e: unknown) => e);
      expect(isMailSourceError(err, "setup")).toBe(true);
      expect((err as MailSourceError).code).toBe("fixture_invalid");
      expect(String(((err as Error).cause as Error).message)).toContain("broken.json");
      writeFileSync(file, JSON.stringify({ id: "x", threadId: "x", internalDate: "1000" }));
      expect((await src.getProfile()).historyId).toBe(String(HISTORY_BASE + 1));
    });

    it.each([
      [{ threadId: "x", internalDate: "1" }, "id"],
      [{ id: "x", internalDate: "1" }, "threadId"],
      [{ id: "x", threadId: "x", internalDate: 1 }, "internalDate"],
      [[], "not an object"],
    ])("rejects %j", async (value, detail) => {
      const err = await createFixtureSource({ messages: [value as unknown as GmailMessage] })
        .getProfile()
        .catch((e: unknown) => e);
      expect(isMailSourceError(err, "setup")).toBe(true);
      expect(((err as Error).cause as Error).message).toContain(detail);
    });

    it("rejects duplicate ids", async () => {
      const m = { id: "x", threadId: "x", internalDate: "1" };
      const err = await createFixtureSource({ messages: [m, m] }).getProfile().catch((e: unknown) => e);
      expect(((err as Error).cause as Error).message).toContain("duplicate");
    });
  });
});
