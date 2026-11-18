// Shared by the pipeline tests: the fixtures' default context, and the effect in one line.
import { DEFAULT_RULES, DEFAULT_USER_SETTINGS } from "@/lib/domain/defaults";
import { classifyMail } from "@/lib/inbox/pipeline/classify";
import type { MailInput, PipelineContext } from "@/lib/inbox/pipeline/types";
import type { ClassifyResult, Job, KeywordRule } from "@/lib/types";
import { FIXTURE_JOBS, RULES_NOW } from "../../fixtures/rules/jobs";

export const RULES: KeywordRule[] = DEFAULT_RULES.map((r, i) => ({ ...r, id: `rule_${i}` }));

/** A new user's settings, the default rules and the fixture jobs: no thread, no sender history. */
export function context(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    jobs: FIXTURE_JOBS,
    rules: RULES,
    createFromConfirmation: DEFAULT_USER_SETTINGS.createFromConfirmation,
    languages: DEFAULT_USER_SETTINGS.languages,
    threadJobId: null,
    senderJobIds: [],
    now: RULES_NOW,
    ...overrides,
  };
}

export function classify(mail: MailInput, overrides: Partial<PipelineContext> = {}): ClassifyResult {
  return classifyMail(mail, context(overrides));
}

/** "link Company | Title: from -> to", "create Company | Title", "review reason [jobs] status", "ignore". */
export function effectOf(result: ClassifyResult, jobs: readonly Job[] = FIXTURE_JOBS): string {
  const name = (id: string) => {
    const job = jobs.find((j) => j.id === id);
    return job ? `${job.company} | ${job.title}` : id;
  };
  const e = result.effect;
  switch (e.kind) {
    case "ignore":
      return "ignore";
    case "link":
      return `link ${name(e.jobId)}: ${e.from} -> ${e.to}`;
    case "create":
      return `create ${e.company} | ${e.title}`;
    case "review":
      return `review ${e.reason} [${e.suggestedJobIds.map(name).join(", ")}] ${e.suggestedStatus}`;
  }
}
