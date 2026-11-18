import "server-only";
import { z } from "zod";
import { STATUSES } from "@/lib/types";

export const statusSchema = z.enum(STATUSES);
export const ruleStatusSchema = z.enum(["applied", "interview", "offer", "rejected"]);

/**
 * A job's link: http or https only, as the add-job form allows (it is rendered as a link, so a
 * javascript: or data: URL must not get in). "" means no link.
 */
const jobUrlSchema = z
  .string()
  .trim()
  .url({ protocol: /^https?$/, message: "Use an http or https link" })
  .nullable()
  .or(z.literal("").transform(() => null));

export const jobInputSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  company: z.string().trim().min(1, "Company is required").max(200),
  location: z.string().trim().max(200).default(""),
  url: jobUrlSchema.default(null),
  description: z.string().max(50_000).default(""),
  status: z.enum(["saved", "applied"]),
  captureMethod: z.enum(["extension", "paste"]).default("paste"),
});

export const jobPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    company: z.string().trim().min(1).max(200),
    location: z.string().trim().max(200),
    url: jobUrlSchema,
    description: z.string().max(50_000),
    status: statusSchema,
    statusLocked: z.boolean(),
    nextInterview: z
      .object({ at: z.iso.datetime(), round: z.string().trim().max(80) })
      .nullable(),
    offerDeadline: z.iso.datetime().nullable(),
  })
  .partial();

export const reviewActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("assign"), jobId: z.string(), status: statusSchema }),
  z.object({
    action: z.literal("create"),
    status: statusSchema,
    company: z.string().trim().min(1),
    title: z.string().trim().min(1),
  }),
  z.object({ action: z.literal("dismiss") }),
]);

/** A language code as a keyword rule stores it ("en", "de", "pt-BR"): the keyword_rules check. */
const languageSchema = z.string().trim().min(2).max(5);

export const ruleInputSchema = z.object({
  status: ruleStatusSchema,
  phrase: z.string().trim().min(2, "Use at least 2 characters").max(120),
  language: languageSchema,
});

/**
 * Caps on the rule tester's input, so a request cannot make it work on any amount of text. The
 * header fields take what the inbox keeps of a real message (MAX_NAME and MAX_ADDRESS in
 * src/lib/server/inbox/parse/address.ts, MAX_SUBJECT in parse/gmail-message.ts). The body is
 * pasted raw, quoted replies and all, so it gets more than the 20,000 characters the inbox keeps
 * after cleaning: as much as a job description.
 */
export const CLASSIFY_LIMITS = { fromName: 200, fromAddress: 320, subject: 1_000, body: 50_000 } as const;

/** POST /api/classify (the rule tester). */
export const classifyInputSchema = z.object({
  fromName: z.string().max(CLASSIFY_LIMITS.fromName).optional(),
  fromAddress: z.string().max(CLASSIFY_LIMITS.fromAddress).default(""),
  subject: z.string().max(CLASSIFY_LIMITS.subject).default(""),
  body: z.string().max(CLASSIFY_LIMITS.body).default(""),
});

/**
 * At most this many languages in settings. Six have stopwords and labels today and a new user
 * has two; the Settings screen never sends the list (a rule's new language joins it on the
 * server), so the cap only stops a hand-made request from storing an endless one.
 */
export const MAX_SETTINGS_LANGUAGES = 20;

/**
 * PATCH /api/settings. The inbox block takes only intervalMinutes: provider, address and
 * connected belong to the mailbox connection (Gmail ingest's own flow), and like any other
 * unknown key they are dropped, not refused.
 */
export const settingsPatchSchema = z
  .object({
    inbox: z.object({ intervalMinutes: z.number().int().min(5).max(1440) }).partial(),
    noResponseDays: z.number().int().min(7).max(120),
    createFromConfirmation: z.boolean(),
    reviewUncertain: z.boolean(),
    languages: z.array(languageSchema).max(MAX_SETTINGS_LANGUAGES),
  })
  .partial();

/* -------------------------------------------------------- Chrome extension */
// docs/plan/4-chrome-extension.md: "API" and "Snapshot limits". The extension cuts what it
// reads to these limits before sending, so a request over them is refused, not cut.

/** POST /api/extension/keys: where the browser was connected, e.g. "Chrome on Linux". */
export const extensionKeyInputSchema = z.object({
  label: z.string().trim().min(1, "Name this browser").max(80),
});

/** POST /api/extension/jobs: the add-job input; the route sets captureMethod "extension". */
export const extensionJobInputSchema = jobInputSchema.omit({ captureMethod: true });

const MAX_URL = 2_048;
const MAX_TEXT = 100_000;

/** What a site reader found (SiteFields). Its link is used only when it is http(s). */
const siteFieldsSchema = z.object({
  url: z.string().max(MAX_URL).optional(),
  title: z.string().max(1_000).optional(),
  company: z.string().max(1_000).optional(),
  location: z.string().max(1_000).optional(),
  description: z.string().max(MAX_TEXT).optional(),
});

/**
 * POST /api/extension/read: { page: PageSnapshot }. The tab's address must be http(s); the
 * canonical link may be anything up to the limit (src/lib/server/parse/snapshot.ts uses it only
 * when it is http(s) on the tab's host). Everything but `url` may be left out.
 */
export const pageSnapshotSchema = z.object({
  url: z.string().max(MAX_URL).url({ protocol: /^https?$/, message: "Use an http or https link" }),
  canonicalUrl: z.string().max(MAX_URL).nullable().default(null),
  title: z.string().max(1_000).default(""),
  meta: z
    .record(z.string().max(40), z.string().max(5_000))
    .refine((meta) => Object.keys(meta).length <= 10, "At most 10 meta tags")
    .default({}),
  jsonLd: z.array(z.string().max(200_000)).max(20).default([]),
  site: z
    .object({ reader: z.string().regex(/^[a-z0-9-]{1,40}$/), fields: siteFieldsSchema })
    .nullable()
    .default(null),
  selection: z.string().max(MAX_TEXT).default(""),
});

export const extensionReadSchema = z.object({ page: pageSnapshotSchema });
