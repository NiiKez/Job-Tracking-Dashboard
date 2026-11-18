"use client";

import { FlaskConical, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { HighlightedText, KeywordChips } from "@/components/email/highlighted-text";
import { CompanyAvatar } from "@/components/jobs/company-avatar";
import { StatusBadge } from "@/components/jobs/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useClassify, useRules } from "@/lib/api/hooks";
import { OUTCOME_META, REVIEW_REASON_META, STATUS_META } from "@/lib/status";
import type { ClassifyInput, ClassifyResult, Status } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RULE_STATUSES, langName } from "./rule-utils";
import { EXAMPLES } from "./sandbox-examples";
import { CONTROL_H, SELECT_H, SettingsCard } from "./settings-layout";

const EMPTY: ClassifyInput = { fromAddress: "", subject: "", body: "" };

export function EmailSandbox() {
  const [form, setForm] = useState<ClassifyInput>(EMPTY);
  const [example, setExample] = useState<string>("");
  const [tested, setTested] = useState<ClassifyInput | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const classify = useClassify();
  const { mutate } = classify;
  const { dataUpdatedAt: rulesUpdatedAt } = useRules();

  const canTest = !!(form.subject.trim() || form.body.trim());

  const run = (input: ClassifyInput) => {
    setTested(input);
    mutate(input, {
      onError: (err) => toast.error("Couldn’t test the email", { description: err.message }),
    });
  };

  // Re-run the last test when the keyword rules change, so the result is never stale.
  const testedRef = useRef<ClassifyInput | null>(null);
  useEffect(() => {
    testedRef.current = tested;
  }, [tested]);
  useEffect(() => {
    if (testedRef.current) mutate(testedRef.current);
  }, [rulesUpdatedAt, mutate]);

  const set = (key: keyof ClassifyInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setExample("");
  };

  const pickExample = (id: string) => {
    const ex = EXAMPLES.find((x) => x.id === id);
    if (!ex) return;
    setExample(id);
    setForm(ex.input);
    run(ex.input);
  };

  const result = classify.data;
  const stale =
    !!tested &&
    (tested.fromAddress !== form.fromAddress || tested.subject !== form.subject || tested.body !== form.body);

  return (
    <SettingsCard className="@container">
      <form
        ref={formRef}
        noValidate
        aria-label="Test an email"
        onSubmit={(e) => {
          e.preventDefault();
          if (canTest) run({ ...form });
        }}
        className="flex flex-col gap-4 px-4 py-4"
      >
        <div className="grid gap-4 @lg:grid-cols-2">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="sandbox-example">Try an example</FieldLabel>
            <Select value={example} onValueChange={pickExample}>
              <SelectTrigger id="sandbox-example" className={cn(SELECT_H, "w-full")}>
                <SelectValue placeholder="Pick a sample email" />
              </SelectTrigger>
              <SelectContent>
                {EXAMPLES.map((ex) => (
                  <SelectItem key={ex.id} value={ex.id}>
                    {ex.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="sandbox-from">
              From address <span className="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Input
              id="sandbox-from"
              type="email"
              inputMode="email"
              autoComplete="off"
              placeholder="jobs@company.example"
              value={form.fromAddress}
              onChange={set("fromAddress")}
              className={CONTROL_H}
            />
          </Field>
        </div>

        <Field className="gap-1.5">
          <FieldLabel htmlFor="sandbox-subject">Subject</FieldLabel>
          <Input
            id="sandbox-subject"
            autoComplete="off"
            value={form.subject}
            onChange={set("subject")}
            className={CONTROL_H}
          />
        </Field>

        <Field className="gap-1.5">
          <FieldLabel htmlFor="sandbox-body">Body</FieldLabel>
          <Textarea
            id="sandbox-body"
            value={form.body}
            onChange={set("body")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
            className="max-h-72 min-h-32"
          />
          <FieldDescription className="text-xs">
            Paste a real reply to see what a rule would do. Nothing is changed by a test.
          </FieldDescription>
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" className={cn(CONTROL_H, "gap-1.5")} disabled={!canTest || classify.isPending}>
            {classify.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <FlaskConical aria-hidden />}
            {classify.isPending ? "Testing…" : "Test"}
          </Button>
          <span className="hidden text-xs text-muted-foreground md:inline">
            <Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd> in the body
          </span>
          {!canTest && <span className="text-xs text-muted-foreground">Add a subject or body first.</span>}
        </div>
      </form>

      <div aria-live="polite">
        {result && tested ? (
          <SandboxResult result={result} input={tested} stale={stale} />
        ) : (
          <div className="bg-surface-sunken px-4 py-6 text-center text-xs text-muted-foreground">
            The result appears here: which status the keywords point to, which job it matches and
            what would change.
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

function SandboxResult({
  result,
  input,
  stale,
}: {
  result: ClassifyResult;
  input: ClassifyInput;
  stale: boolean;
}) {
  const outcome = OUTCOME_META[result.outcome];
  const OutcomeIcon = outcome.icon;
  const phrases = result.matchedKeywords.map((k) => k.phrase);
  const reason = result.reviewReason ? REVIEW_REASON_META[result.reviewReason] : null;
  const byStatus = RULE_STATUSES.map((s) => ({
    status: s,
    phrases: result.matchedKeywords.filter((k) => k.status === s).map((k) => k.phrase),
  })).filter((g) => g.phrases.length);

  return (
    <div className={cn("flex flex-col gap-5 bg-surface-sunken px-4 py-5 transition-opacity duration-200", stale && "opacity-60")}>
      {/* Outcome */}
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", outcome.className)}
        >
          <OutcomeIcon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold tracking-tight">{outcome.label}</p>
          <p className="text-sm text-muted-foreground">{summary(result)}</p>
          {stale && (
            <p className="mt-1 text-xs text-muted-foreground">You edited the email. Test again to update.</p>
          )}
        </div>
      </div>

      <dl className="flex flex-col gap-4 text-sm">
        <ResultRow term="Detected status">
          <div className="flex flex-wrap items-center gap-2">
            {result.status ? (
              <StatusBadge status={result.status} size="md" />
            ) : (
              <span className="text-muted-foreground">No status</span>
            )}
            {result.language && (
              <span className="text-xs text-muted-foreground">Language: {langName(result.language)}</span>
            )}
          </div>
        </ResultRow>

        {reason && (
          <ResultRow term="Review reason">
            <p className="font-medium">{reason.label}</p>
            <p className="text-xs text-muted-foreground">{reason.explain}</p>
          </ResultRow>
        )}

        <ResultRow term="Matched keywords">
          {byStatus.length ? (
            <ul className="flex flex-col gap-1.5">
              {byStatus.map((g) => (
                <li key={g.status} className="flex flex-wrap items-center gap-2">
                  <span className={cn("w-16 shrink-0 text-xs font-medium", STATUS_META[g.status].textClass)}>
                    {STATUS_META[g.status].label}
                  </span>
                  <KeywordChips keywords={g.phrases} />
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">None. Add a phrase above if this email should count.</span>
          )}
        </ResultRow>

        <ResultRow term="Candidate jobs">
          {result.candidates.length ? (
            <ol className="-ml-1 flex flex-col gap-0.5">
              {result.candidates.slice(0, 4).map((job, i) => (
                <li key={job.id}>
                  <Link
                    href={`/?job=${job.id}`}
                    className="flex min-h-9 min-w-0 items-center gap-2.5 rounded-md py-1 pr-2 pl-1 transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <CompanyAvatar company={job.company} size="sm" />
                    <span className="min-w-0 flex-1 text-pretty">
                      <span className="font-medium">{job.company}</span>
                      <span className="text-muted-foreground"> · {job.title}</span>
                    </span>
                    {i === 0 && (
                      <span className="shrink-0 text-xs font-medium text-primary">Best match</span>
                    )}
                    <StatusBadge status={job.status} className="hidden @md:inline-flex" />
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <span className="text-muted-foreground">No application matches the sender or wording.</span>
          )}
        </ResultRow>
      </dl>

      {/* The email with matches highlighted */}
      <figure className="rounded-lg border bg-card">
        <figcaption className="border-b px-3 py-2 text-xs">
          {input.fromAddress && <p className="truncate text-muted-foreground">{input.fromAddress}</p>}
          <HighlightedText text={input.subject || "(no subject)"} keywords={phrases} className="font-medium" />
        </figcaption>
        <HighlightedText
          text={input.body || "(empty body)"}
          keywords={phrases}
          className="max-h-64 overflow-y-auto px-3 py-3 text-sm leading-relaxed"
        />
      </figure>
    </div>
  );
}

function ResultRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 @lg:grid-cols-[9rem_minmax(0,1fr)] @lg:gap-6">
      <dt className="text-xs font-medium text-muted-foreground @lg:pt-1">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** One sentence: what the pipeline would do with this email. */
function summary(result: ClassifyResult) {
  const label = (s: Status) => STATUS_META[s].label;
  const effect = result.effect;
  switch (effect.kind) {
    case "link": {
      const job = result.candidates.find((j) => j.id === effect.jobId);
      if (!job) return OUTCOME_META.matched.description;
      return effect.from === effect.to
        ? `Would link it to ${job.company} · ${job.title}. The status stays ${label(effect.from)}.`
        : `Would move ${job.company} · ${job.title} from ${label(effect.from)} to ${label(effect.to)}.`;
    }
    case "create":
      return `Would add ${effect.company} · ${effect.title} as a new application marked ${label(effect.status)}, because no job in the dashboard matches.`;
    case "review":
      return "Would go to Needs review, so you decide what it means.";
    case "ignore":
      return "Would be ignored: not enough in it points to a job application.";
  }
}
