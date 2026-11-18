import "server-only";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { MailSourceError } from "../sync/errors";
import type { GmailMessage, GmailPart, MailSource, MailboxProfile } from "./types";

/**
 * The fixture mail source (MAIL_SOURCE=fixture: development, tests and CI, without any Google
 * secret). It serves the Gmail Message resources in fixtures/mail/*.json (format=full, one per
 * file; see fixtures/mail/README.md) and behaves like Gmail where the sync engine can tell:
 *
 *   Dates     Files keep fixed dates. Every message is moved by the same whole number of days,
 *             so the newest one falls within the 24 hours before `now` and the rest keep their
 *             spacing: a development "Check inbox" finds the demo mail any day, also with the
 *             30-day first scan. internalDate and the Date header move; dates written inside
 *             bodies do not.
 *   History   Messages are ordered by their file date (then id) and get history ids
 *             HISTORY_BASE + 1, + 2, ... getProfile answers the highest; listAddedSince(start)
 *             answers the messages above `start`, in order, and the highest id. A start below
 *             HISTORY_BASE, a malformed one, or the `historyExpired` option throws
 *             MailSourceError("history_expired"), as Gmail's 404 does.
 *   Listing   listMessageIds(after) leaves out mail received at or before `after`, and sent
 *             mail, drafts, chats, spam and trash (the first scan's query). listAddedSince
 *             leaves nothing out: like history.list, it reports sent mail too.
 *   Attachments  A part with body.attachmentId has its data in the file's "_attachments" map.
 *
 * Deterministic: the same files and the same `now` give the same answers. Files are read on
 * first use (never at import time; `next build` does not read the folder) and kept for the
 * life of the source. Top-level keys starting with "_" are not part of the message ("_note",
 * "_attachments"). A missing folder or a broken file throws MailSourceError("setup") whose
 * cause names the file.
 */

export const HISTORY_BASE = 100_000;
const DAY = 86_400_000;
const NOT_LISTED = new Set(["SENT", "DRAFT", "CHAT", "SPAM", "TRASH"]);

export interface FixtureSourceOptions {
  /** The folder of fixture files. Default: fixtures/mail under the working directory. */
  dir?: string;
  /** Messages to serve instead of reading `dir` (tests). Same rules as files. */
  messages?: ReadonlyArray<GmailMessage & { _attachments?: Record<string, string> }>;
  /** The clock. Default: the system clock. */
  now?: () => Date;
  /** The mailbox address getProfile answers. Default: demo@example.com. */
  emailAddress?: string;
  /** Moves dates as described above (default true). False serves the files' own dates. */
  shiftDates?: boolean;
  /** listAddedSince throws history_expired whatever the start (the "position too old" path). */
  historyExpired?: boolean;
}

export const DEFAULT_FIXTURE_ADDRESS = "demo@example.com";

interface Fixture {
  message: GmailMessage;
  internalDate: number;
  historyId: number;
  attachments: Map<string, string>;
}

interface Mailbox {
  /** Oldest first. */
  fixtures: Fixture[];
  byId: Map<string, Fixture>;
  latest: number;
  historyId: number;
}

export function createFixtureSource(opts: FixtureSourceOptions = {}): MailSource {
  let loading: Promise<Mailbox> | null = null;
  const mailbox = () => {
    loading ??= load(opts).catch((err) => {
      loading = null; // a fixed file is read again on the next call
      throw err;
    });
    return loading;
  };

  /** How far every date moves, for the clock's current time. */
  const shiftFor = (box: Mailbox) => {
    if (opts.shiftDates === false || !box.fixtures.length) return 0;
    const now = (opts.now ?? (() => new Date()))().getTime();
    return Math.floor((now - box.latest) / DAY) * DAY;
  };

  return {
    async getProfile(): Promise<MailboxProfile> {
      const box = await mailbox();
      return { emailAddress: opts.emailAddress ?? DEFAULT_FIXTURE_ADDRESS, historyId: String(box.historyId) };
    },

    async listMessageIds(after: Date): Promise<string[]> {
      const box = await mailbox();
      const shift = shiftFor(box);
      const afterMs = after.getTime();
      return box.fixtures
        .filter((f) => f.internalDate + shift > afterMs)
        .filter((f) => !(f.message.labelIds ?? []).some((l) => NOT_LISTED.has(l)))
        .map((f) => f.message.id)
        .reverse(); // newest first, as Gmail usually answers
    },

    async listAddedSince(startHistoryId: string) {
      const box = await mailbox();
      const start = /^\d{1,15}$/.test(startHistoryId) ? Number(startHistoryId) : NaN;
      if (opts.historyExpired || !(start >= HISTORY_BASE)) {
        throw new MailSourceError("history_expired", "history_expired");
      }
      return {
        messageIds: box.fixtures.filter((f) => f.historyId > start).map((f) => f.message.id),
        historyId: String(box.historyId),
      };
    },

    async getMessage(id: string): Promise<GmailMessage | null> {
      const box = await mailbox();
      const fixture = box.byId.get(id);
      return fixture ? shifted(fixture, shiftFor(box)) : null;
    },

    async getAttachment(messageId: string, attachmentId: string): Promise<string | null> {
      const box = await mailbox();
      return box.byId.get(messageId)?.attachments.get(attachmentId) ?? null;
    },
  };
}

/* ---------------------------------------------------------------- loading */

async function load(opts: FixtureSourceOptions): Promise<Mailbox> {
  const raw: Array<{ name: string; value: unknown }> = opts.messages
    ? opts.messages.map((value, i) => ({ name: `messages[${i}]`, value }))
    : await readFolder(opts.dir ?? path.join(process.cwd(), "fixtures/mail"));

  const fixtures = raw.map(({ name, value }) => toFixture(name, value));
  fixtures.sort((a, b) => a.internalDate - b.internalDate || (a.message.id < b.message.id ? -1 : 1));
  const byId = new Map<string, Fixture>();
  fixtures.forEach((f, i) => {
    if (byId.has(f.message.id)) throw invalid(`duplicate message id ${f.message.id}`);
    f.historyId = HISTORY_BASE + i + 1;
    f.message.historyId = String(f.historyId);
    byId.set(f.message.id, f);
  });
  return {
    fixtures,
    byId,
    latest: fixtures.length ? fixtures[fixtures.length - 1].internalDate : 0,
    historyId: HISTORY_BASE + fixtures.length,
  };
}

function invalid(detail: string, cause?: unknown) {
  return new MailSourceError("setup", "fixture_invalid", { cause: new Error(detail, { cause }) });
}

async function readFolder(dir: string): Promise<Array<{ name: string; value: unknown }>> {
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    throw new MailSourceError("setup", "fixtures_missing", { cause: err });
  }
  return Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name);
      try {
        return { name, value: JSON.parse(await readFile(file, "utf8")) as unknown };
      } catch (err) {
        throw invalid(`${name}: not readable JSON`, err);
      }
    }),
  );
}

function toFixture(name: string, value: unknown): Fixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${name}: not an object`);
  const message: Record<string, unknown> = {};
  let attachments = new Map<string, string>();
  for (const [key, v] of Object.entries(value)) {
    if (key === "_attachments" && v && typeof v === "object") {
      attachments = new Map(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
    } else if (!key.startsWith("_")) {
      message[key] = v;
    }
  }
  if (typeof message.id !== "string" || !message.id) throw invalid(`${name}: "id" is missing`);
  if (typeof message.threadId !== "string" || !message.threadId) throw invalid(`${name}: "threadId" is missing`);
  if (typeof message.internalDate !== "string" || !/^\d{1,15}$/.test(message.internalDate)) {
    throw invalid(`${name}: "internalDate" must be milliseconds as a decimal string`);
  }
  const msg = structuredClone(message) as unknown as GmailMessage;
  return { message: msg, internalDate: Number(msg.internalDate), historyId: 0, attachments };
}

/* ---------------------------------------------------------------- dates */

/** A copy of the message with its dates moved by `shift` milliseconds. */
function shifted(fixture: Fixture, shift: number): GmailMessage {
  const copy = structuredClone(fixture.message);
  copy.internalDate = String(fixture.internalDate + shift);
  if (shift && copy.payload) shiftDateHeader(copy.payload, shift);
  return copy;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shiftDateHeader(part: GmailPart, shift: number) {
  for (const h of part.headers ?? []) {
    if (h.name.toLowerCase() !== "date") continue;
    const ms = Date.parse(h.value);
    if (Number.isNaN(ms)) continue;
    // Keep the sender's zone: "+0100" stays "+0100".
    const zone = /([+-])(\d{2})(\d{2})\s*(\([^)]*\))?\s*$/.exec(h.value);
    const offsetMin = zone ? (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])) : 0;
    const local = new Date(ms + shift + offsetMin * 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    h.value =
      `${WEEKDAYS[local.getUTCDay()]}, ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()} ` +
      `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} ` +
      (zone ? `${zone[1]}${zone[2]}${zone[3]}` : "+0000");
  }
}
