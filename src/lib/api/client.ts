import type {
  ClassifyInput,
  ClassifyResult,
  DefaultRulesUpdate,
  Email,
  EmailOutcome,
  ExtensionKeyCreated,
  ExtensionOverview,
  InboxCheckResult,
  Job,
  JobInput,
  JobWithEmails,
  KeywordRule,
  Me,
  ParseResult,
  ReviewAction,
  ReviewRecheckResult,
  Settings,
  Stats,
  Status,
  UpsertResult,
} from "@/lib/types";

/**
 * Typed HTTP client for the Job Tracker API: the Route Handlers in src/app/api,
 * on the same origin as the pages. Every id that goes into a path is passed
 * through encodeURIComponent: an id from the page URL (/jobs/..%2Fsettings
 * gives "../settings") must stay one segment, not climb to another endpoint.
 */
const BASE = "/api";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Signed out or the session expired: open the login page, which brings the
 * browser back here after sign-in. /login itself decides whether `next` is safe.
 */
function redirectToLogin() {
  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  if (pathname === "/login") return;
  const here = `${pathname}${search}`;
  window.location.assign(here === "/" ? "/login" : `/login?next=${encodeURIComponent(here)}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) redirectToLogin();
    throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status, data);
  }
  return data as T;
}

const json = (body: unknown) => JSON.stringify(body);

/**
 * Connecting (and reconnecting) the mailbox is a full-page trip to Google and back, not a fetch:
 * a link to this route, which answers with a redirect to Google's consent screen.
 */
export const INBOX_CONNECT_HREF = `${BASE}/inbox/connect`;

/**
 * The Chrome extension's zip (Settings, Chrome extension): a plain link, so the browser downloads
 * it with the session cookie. 404 when this server has no build of the extension.
 */
export const EXTENSION_DOWNLOAD_HREF = `${BASE}/extension/download`;

/**
 * POST /api/inbox/disconnect's answer. `revoked` is false when the stored token was deleted but
 * Google did not confirm its revocation: the screen then points to the Google Account.
 */
export interface InboxDisconnectResult {
  ok: true;
  revoked: boolean;
}

export type JobPatch = Partial<
  Pick<
    Job,
    | "title"
    | "company"
    | "location"
    | "url"
    | "description"
    | "status"
    | "statusLocked"
    | "nextInterview"
    | "offerDeadline"
  >
>;

/**
 * What PATCH /api/settings takes. Of the inbox block only the sync interval:
 * connecting a mailbox is its own flow.
 */
export type SettingsPatch = Partial<Omit<Settings, "inbox">> & {
  inbox?: Partial<Pick<Settings["inbox"], "intervalMinutes">>;
};

export interface JobsQuery {
  q?: string;
  statuses?: Status[];
}

export const api = {
  jobs: {
    list: ({ q, statuses }: JobsQuery = {}) => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (statuses?.length) params.set("status", statuses.join(","));
      const qs = params.toString();
      return request<Job[]>(`/jobs${qs ? `?${qs}` : ""}`);
    },
    get: (id: string) => request<JobWithEmails>(`/jobs/${encodeURIComponent(id)}`),
    create: (input: JobInput) =>
      request<UpsertResult>("/jobs", { method: "POST", body: json(input) }),
    update: (id: string, patch: JobPatch) =>
      request<Job>(`/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: json(patch) }),
    remove: (id: string) => request<{ ok: true }>(`/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    parse: (input: string) =>
      request<ParseResult>("/parse", { method: "POST", body: json({ input }) }),
  },
  me: () => request<Me>("/me"),
  stats: () => request<Stats>("/stats"),
  emails: {
    list: (opts: { outcomes?: EmailOutcome[]; jobId?: string } = {}) => {
      const params = new URLSearchParams();
      if (opts.outcomes?.length) params.set("outcome", opts.outcomes.join(","));
      if (opts.jobId) params.set("jobId", opts.jobId);
      const qs = params.toString();
      return request<Email[]>(`/emails${qs ? `?${qs}` : ""}`);
    },
    resolve: (id: string, action: ReviewAction) =>
      request<{ email: Email; job: Job | null }>(`/emails/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        body: json(action),
      }),
    /** Classifies the mail that waits for review again, oldest first. */
    recheck: () => request<ReviewRecheckResult>("/emails/recheck", { method: "POST" }),
  },
  inbox: {
    check: () => request<InboxCheckResult>("/inbox/check", { method: "POST" }),
    /**
     * Stops syncing, deletes the stored access and asks Google to revoke it. A JSON body, as
     * every non-GET route requires.
     */
    disconnect: () => request<InboxDisconnectResult>("/inbox/disconnect", { method: "POST", body: json({}) }),
    /**
     * Starts a new full scan of the mailbox; mail already filed is not read again. Answers when
     * the scan has started (Settings shows its progress). `forgotten`: ledger rows cleared.
     */
    scanAgain: () => request<{ ok: true; forgotten: number }>("/inbox/scan-again", { method: "POST", body: json({}) }),
  },
  classify: (input: ClassifyInput) =>
    request<ClassifyResult>("/classify", { method: "POST", body: json(input) }),
  rules: {
    list: () => request<KeywordRule[]>("/rules"),
    add: (input: Omit<KeywordRule, "id">) =>
      request<KeywordRule>("/rules", { method: "POST", body: json(input) }),
    remove: (id: string) => request<{ ok: true }>(`/rules/${encodeURIComponent(id)}`, { method: "DELETE" }),
    /** Removes retired default phrases and adds the current defaults that are missing. */
    updateDefaults: () => request<DefaultRulesUpdate>("/rules/defaults", { method: "POST" }),
  },
  extension: {
    /** The version this server can hand out (null: no build) and the connected browsers. */
    overview: () => request<ExtensionOverview>("/extension"),
    /**
     * A key for the extension, from the connect page. The answer carries the token once: hand it
     * to the extension and drop it, never store or log it.
     */
    createKey: (label: string) =>
      request<ExtensionKeyCreated>("/extension/keys", { method: "POST", body: json({ label }) }),
    /** Revokes a connected browser's key: the extension there gets 401 from then on. */
    revokeKey: (id: string) =>
      request<{ ok: true }>(`/extension/keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
  settings: {
    get: () => request<Settings>("/settings"),
    update: (patch: SettingsPatch) =>
      request<Settings>("/settings", { method: "PATCH", body: json(patch) }),
  },
};
