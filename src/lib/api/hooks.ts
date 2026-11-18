"use client";

import { useEffect } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  EmailOutcome,
  ExtensionKey,
  ExtensionKeyCreated,
  ExtensionOverview,
  Job,
  JobWithEmails,
  KeywordRule,
  ReviewAction,
  Settings,
} from "@/lib/types";
import { lockAfterManualChange } from "@/lib/domain/status-change";
import { api, type JobPatch, type JobsQuery } from "./client";

/** Query keys in one place so invalidation stays consistent. */
export const qk = {
  jobs: (q: JobsQuery = {}) => ["jobs", q] as const,
  jobsAll: ["jobs"] as const,
  job: (id: string) => ["job", id] as const,
  jobAll: ["job"] as const,
  stats: ["stats"] as const,
  emails: (o: { outcomes?: EmailOutcome[]; jobId?: string } = {}) => ["emails", o] as const,
  emailsAll: ["emails"] as const,
  rules: ["rules"] as const,
  settings: ["settings"] as const,
  me: ["me"] as const,
  extension: ["extension"] as const,
};

function invalidateJobData(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.jobsAll }),
    qc.invalidateQueries({ queryKey: qk.jobAll }),
    qc.invalidateQueries({ queryKey: qk.stats }),
    qc.invalidateQueries({ queryKey: qk.emailsAll }),
  ]);
}

/* --------------------------------------------------------------- queries */

export function useJobs(query: JobsQuery = {}) {
  return useQuery({
    queryKey: qk.jobs(query),
    queryFn: () => api.jobs.list(query),
    placeholderData: keepPreviousData,
  });
}

/** A 404 isn't retried (query defaults in providers.tsx): the not-found state shows right away. */
export function useJob(id: string | null | undefined) {
  return useQuery({
    queryKey: qk.job(id ?? ""),
    queryFn: () => api.jobs.get(id!),
    enabled: !!id,
  });
}

export function useStats() {
  return useQuery({ queryKey: qk.stats, queryFn: api.stats });
}

export function useEmails(opts: { outcomes?: EmailOutcome[]; jobId?: string } = {}) {
  return useQuery({
    queryKey: qk.emails(opts),
    queryFn: () => api.emails.list(opts),
    placeholderData: keepPreviousData,
  });
}

export function useReviewEmails() {
  return useEmails({ outcomes: ["review"] });
}

export function useRules() {
  return useQuery({ queryKey: qk.rules, queryFn: api.rules.list });
}

/** How often Settings is asked again while the inbox syncs. */
export const INBOX_POLL_MS = 4_000;

/**
 * Mail is on its way while the page is open: a sync runs (the first scan too), or a new
 * connection waits for its first sync (connecting only asks the scheduler for one, so the page
 * would otherwise show "Not synced yet" until a reload). A first scan paused between runs is
 * not: the next run is an interval or a back-off away (after a failure up to an hour, a day when
 * Google asks, or never for a setup error), and the sidebar would poll on every page meanwhile.
 */
export function isInboxBusy(inbox: Settings["inbox"] | undefined): boolean {
  if (!inbox) return false;
  const firstSyncDue = inbox.connected && inbox.lastCheckedAt === null && inbox.lastError === null;
  return inbox.syncing || firstSyncDue;
}

/**
 * Settings, polled every INBOX_POLL_MS while the inbox is busy (only while the tab is visible).
 * When a sync is seen to finish, the job data it may have changed is refreshed, as after "Sync now".
 */
export function useSettings() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: qk.settings,
    queryFn: async () => {
      const before = qc.getQueryData<Settings>(qk.settings);
      const settings = await api.settings.get();
      if (isInboxBusy(before?.inbox) && !isInboxBusy(settings.inbox)) void invalidateJobData(qc);
      return settings;
    },
    refetchInterval: (query) => (isInboxBusy(query.state.data?.inbox) ? INBOX_POLL_MS : false),
  });
}

/** The signed-in user. It doesn't change while a page is open; signing out leaves the page. */
export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: api.me, staleTime: Infinity });
}

/**
 * Settings, Chrome extension: the version this server hands out and the connected browsers.
 * Browsers are connected in another tab (/extension/connect) or disconnected in the extension's
 * popup, often within seconds, so the list is asked again every time the window gets the focus
 * back, however fresh it is. TanStack Query only listens for visibilitychange, which closing the
 * popup over this page doesn't fire, so the window's focus event is listened for too.
 */
export function useExtensionOverview() {
  const query = useQuery({ queryKey: qk.extension, queryFn: api.extension.overview, refetchOnWindowFocus: "always" });
  const { refetch } = query;
  useEffect(() => {
    // Coming back from another tab fires both events: the second joins the request in flight.
    const onFocus = () => void refetch({ cancelRefetch: false });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);
  return query;
}

/* ------------------------------------------------------------- mutations */

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.jobs.create,
    onSettled: () => invalidateJobData(qc),
  });
}

export function useParseJob() {
  return useMutation({ mutationFn: api.jobs.parse });
}

/**
 * Update a job. Status changes are applied optimistically to every cached
 * job list and to the detail cache, so drag & drop feels instant. The lock
 * follows the server's rule, an explicit statusLocked included, so an Undo
 * (which sends the lock to restore) doesn't flash the wrong one.
 */
export function useUpdateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: JobPatch }) => api.jobs.update(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: qk.jobsAll });
      await qc.cancelQueries({ queryKey: qk.job(id) });
      const lists = qc.getQueriesData<Job[]>({ queryKey: qk.jobsAll });
      const detail = qc.getQueryData<JobWithEmails>(qk.job(id));
      const apply = <T extends Job>(j: T): T => {
        const next = { ...j, ...patch } as T;
        if (patch.status && patch.status !== j.status) {
          next.statusSource = "manual";
          next.statusLocked = lockAfterManualChange(j.status, patch.status, patch.statusLocked);
          next.lastActivityAt = new Date().toISOString();
        }
        return next;
      };
      for (const [key, data] of lists) {
        if (data) qc.setQueryData<Job[]>(key, data.map((j) => (j.id === id ? apply(j) : j)));
      }
      if (detail) qc.setQueryData<JobWithEmails>(qk.job(id), apply(detail));
      return { lists, detail };
    },
    onError: (_err, { id }, ctx) => {
      for (const [key, data] of ctx?.lists ?? []) qc.setQueryData(key, data);
      if (ctx?.detail) qc.setQueryData(qk.job(id), ctx.detail);
    },
    onSettled: () => invalidateJobData(qc),
  });
}

export function useDeleteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.jobs.remove,
    onSuccess: (_d, id) => {
      for (const [key, data] of qc.getQueriesData<Job[]>({ queryKey: qk.jobsAll })) {
        if (data) qc.setQueryData<Job[]>(key, data.filter((j) => j.id !== id));
      }
      qc.removeQueries({ queryKey: qk.job(id) });
    },
    onSettled: () => invalidateJobData(qc),
  });
}

export function useResolveReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ReviewAction }) =>
      api.emails.resolve(id, action),
    onSettled: () => invalidateJobData(qc),
  });
}

export function useRecheckReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.emails.recheck,
    onSettled: () => invalidateJobData(qc),
  });
}

export function useCheckInbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.inbox.check,
    onSettled: () =>
      Promise.all([invalidateJobData(qc), qc.invalidateQueries({ queryKey: qk.settings })]),
  });
}

/**
 * Disconnect the mailbox. Linked emails stay, so only Settings changes. The answer's `revoked`
 * says whether Google confirmed the revocation (disconnectResultToast in inbox-copy.ts).
 */
export function useDisconnectInbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.inbox.disconnect,
    onSettled: () => qc.invalidateQueries({ queryKey: qk.settings }),
  });
}

export function useScanAgain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.inbox.scanAgain,
    // Settings then sees the scan and polls until it ends (isInboxBusy).
    onSettled: () => qc.invalidateQueries({ queryKey: qk.settings }),
  });
}

export function useClassify() {
  return useMutation({ mutationFn: api.classify });
}

export function useAddRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.rules.add,
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.rules }),
        qc.invalidateQueries({ queryKey: qk.settings }),
      ]),
  });
}

export function useUpdateDefaultRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.rules.updateDefaults,
    onSuccess: (result) => qc.setQueryData(qk.rules, result.rules),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.rules }),
        qc.invalidateQueries({ queryKey: qk.settings }),
      ]),
  });
}

export function useDeleteRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.rules.remove,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk.rules });
      const prev = qc.getQueryData<KeywordRule[]>(qk.rules);
      if (prev) qc.setQueryData(qk.rules, prev.filter((r) => r.id !== id));
      return { prev };
    },
    onError: (_e, _id, ctx) => ctx?.prev && qc.setQueryData(qk.rules, ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.rules }),
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.settings.update,
    onSuccess: (data) => qc.setQueryData(qk.settings, data),
  });
}

/**
 * Makes a key for the extension (the connect page). The token never enters the mutation's state:
 * `handOver` gets the answer as soon as it arrives, passes the token on and drops it, and the
 * mutation resolves to the key alone.
 */
export function useCreateExtensionKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      label,
      handOver,
    }: {
      label: string;
      handOver: (created: ExtensionKeyCreated) => void;
    }): Promise<ExtensionKey> => {
      const created = await api.extension.createKey(label);
      handOver(created);
      return created.key;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.extension }),
  });
}

/**
 * Revokes a connected browser. The row leaves the list as soon as the server confirms; a 404
 * (revoked elsewhere already) refreshes the list as well.
 */
export function useRevokeExtensionKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.extension.revokeKey,
    onSuccess: (_d, id) => {
      const prev = qc.getQueryData<ExtensionOverview>(qk.extension);
      if (prev) qc.setQueryData<ExtensionOverview>(qk.extension, { ...prev, keys: prev.keys.filter((k) => k.id !== id) });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.extension }),
  });
}
