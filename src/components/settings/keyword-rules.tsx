"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Info, Loader2, Plus, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { StatusBadge, StatusDot } from "@/components/jobs/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { qk, useAddRule, useDeleteRule, useRules, useUpdateDefaultRules } from "@/lib/api/hooks";
import { DEFAULT_RULES, RETIRED_DEFAULT_RULES } from "@/lib/domain/defaults";
import { LANGUAGE_LABEL, STATUS_META } from "@/lib/status";
import type { KeywordRule, Settings } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  RULE_STATUSES,
  langCode,
  langName,
  normalizePhrase,
  overlapHint,
  uniqueLanguages,
  type RuleStatus,
} from "./rule-utils";
import { CONTROL_H, SELECT_H, SettingsCard, SettingsNote } from "./settings-layout";
import { useHydrated } from "@/hooks/use-hydrated";

const ALL = "all";
const MIN_LEN = 2;
const MAX_LEN = 120;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function KeywordRules({ settings }: { settings: Settings | undefined }) {
  const qc = useQueryClient();
  const rulesQuery = useRules();
  const addRule = useAddRule();
  const deleteRule = useDeleteRule();
  const updateDefaults = useUpdateDefaultRules();
  const hydrated = useHydrated();
  const rules = hydrated ? rulesQuery.data : undefined;

  const [filter, setFilter] = useState<string>(ALL);
  const [phrase, setPhrase] = useState("");
  const [status, setStatus] = useState<RuleStatus>("interview");
  const [language, setLanguage] = useState("en");
  const [submitted, setSubmitted] = useState(false);
  const [recentId, setRecentId] = useState<string | null>(null);
  const phraseRef = useRef<HTMLInputElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  if (hydrated && rulesQuery.isError) {
    return (
      <SettingsCard>
        <div className="flex flex-col items-start gap-3 px-4 py-6">
          <p className="text-sm">Couldn’t load the keyword rules.</p>
          <p className="text-xs text-muted-foreground">{rulesQuery.error.message}</p>
          <Button variant="outline" className={CONTROL_H} onClick={() => rulesQuery.refetch()}>
            <RotateCw aria-hidden />
            Try again
          </Button>
        </div>
      </SettingsCard>
    );
  }
  if (!rules) return <KeywordRulesSkeleton />;

  const languages = uniqueLanguages(settings?.languages ?? [], rules.map((r) => r.language));
  const addLanguages = uniqueLanguages(languages, Object.keys(LANGUAGE_LABEL));
  const activeFilter = filter === ALL || languages.includes(filter) ? filter : ALL;
  const visible = activeFilter === ALL ? rules : rules.filter((r) => r.language === activeFilter);

  /* ------------------------------------------------------------ defaults */
  // Shown while the rules still hold a default phrase that was retired: the list predates the
  // current defaults. A default the user deleted on purpose does not bring it back.
  const has = (rule: Pick<KeywordRule, "status" | "phrase">) =>
    rules.some((r) => r.status === rule.status && normalizePhrase(r.phrase) === normalizePhrase(rule.phrase));
  const retired = RETIRED_DEFAULT_RULES.filter(has).length;
  const missing = retired ? DEFAULT_RULES.filter((r) => !has(r)).length : 0;

  const onUpdateDefaults = async () => {
    try {
      const result = await updateDefaults.mutateAsync();
      toast.success("Default keywords updated", {
        description: `${plural(result.added, "phrase")} added, ${plural(result.removed, "outdated phrase")} removed. Your own keywords are unchanged.`,
      });
    } catch (err) {
      toast.error("Couldn’t update the default keywords", { description: (err as Error).message });
    }
  };

  /* ---------------------------------------------------------- validation */
  const cleaned = phrase.trim().replace(/\s+/g, " ");
  const key = normalizePhrase(cleaned);
  const tooShort = cleaned.length < MIN_LEN;
  const tooLong = cleaned.length > MAX_LEN;
  const duplicate = key ? rules.find((r) => r.status === status && normalizePhrase(r.phrase) === key) : undefined;
  const overlaps =
    key && !tooShort
      ? rules.filter((r) => r.status !== status && normalizePhrase(r.phrase) === key)
      : [];
  const error =
    submitted && tooShort
      ? cleaned.length === 0
        ? "Type a phrase from the email, e.g. “wir freuen uns”."
        : `Use at least ${MIN_LEN} characters.`
      : tooLong
        ? `Keep it under ${MAX_LEN} characters.`
        : null;

  /* ------------------------------------------------------------- actions */
  const flash = (id: string) => {
    setRecentId(id);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setRecentId(null), 2400);
  };

  const insertInCache = (rule: KeywordRule) =>
    qc.setQueryData<KeywordRule[]>(qk.rules, (prev) =>
      prev && !prev.some((r) => r.id === rule.id) ? [...prev, rule] : prev,
    );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (tooShort || tooLong || duplicate) {
      if (duplicate) flash(duplicate.id);
      phraseRef.current?.focus();
      return;
    }
    try {
      const rule = await addRule.mutateAsync({ phrase: cleaned, status, language });
      insertInCache(rule);
      setPhrase("");
      setSubmitted(false);
      if (activeFilter !== ALL && activeFilter !== rule.language) setFilter(rule.language);
      flash(rule.id);
      toast.success("Keyword added", {
        description: `“${rule.phrase}” → ${STATUS_META[rule.status].label} · ${langCode(rule.language)}`,
      });
      phraseRef.current?.focus();
    } catch (err) {
      toast.error("Couldn’t add the keyword", { description: (err as Error).message });
    }
  };

  const restore = (rule: KeywordRule) =>
    addRule
      .mutateAsync({ phrase: rule.phrase, status: rule.status, language: rule.language })
      .then((restored) => {
        insertInCache(restored);
        flash(restored.id);
        toast.success("Keyword restored", { description: `“${restored.phrase}”` });
      })
      .catch((err: Error) => toast.error("Couldn’t restore the keyword", { description: err.message }));

  const remove = (rule: KeywordRule) =>
    deleteRule
      .mutateAsync(rule.id)
      .then(() =>
        toast(`Removed “${rule.phrase}”`, {
          description: `${STATUS_META[rule.status].label} · ${langName(rule.language)}`,
          action: { label: "Undo", onClick: () => restore(rule) },
        }),
      )
      .catch((err: Error) => toast.error("Couldn’t remove the keyword", { description: err.message }));

  const addHere = (s: RuleStatus) => {
    setStatus(s);
    if (activeFilter !== ALL) setLanguage(activeFilter);
    setSubmitted(false);
    phraseRef.current?.focus();
  };

  return (
    <SettingsCard className="@container">
      {/* Newer defaults */}
      {retired > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b bg-surface-sunken px-4 py-3">
          <p className="flex min-w-0 flex-1 items-start gap-1.5 text-xs text-foreground">
            <Info aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
            <span>
              The default keywords have improved: {plural(missing, "new phrase")}, and {plural(retired, "phrase")} here{" "}
              {retired === 1 ? "is" : "are"} too broad now. Keywords you added stay.
            </span>
          </p>
          <Button
            type="button"
            variant="outline"
            className={cn(CONTROL_H, "gap-1.5 bg-background px-3")}
            onClick={onUpdateDefaults}
            disabled={updateDefaults.isPending}
            aria-busy={updateDefaults.isPending || undefined}
          >
            {updateDefaults.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCw aria-hidden />}
            {updateDefaults.isPending ? "Updating…" : "Update defaults"}
          </Button>
        </div>
      )}

      {/* Language filter */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={activeFilter}
          onValueChange={(v) => v && setFilter(v)}
          aria-label="Show phrases for language"
          className="max-w-full flex-wrap"
        >
          <ToggleGroupItem value={ALL} className="h-10 gap-1.5 px-3 md:h-8 data-[state=on]:bg-primary/10 data-[state=on]:text-primary" aria-label={`All languages, ${plural(rules.length, "phrase")}`}>
            All
            <span className="text-xs text-muted-foreground tabular">{rules.length}</span>
          </ToggleGroupItem>
          {languages.map((l) => {
            const n = rules.filter((r) => r.language === l).length;
            return (
              <ToggleGroupItem
                key={l}
                value={l}
                className="h-10 gap-1.5 px-3 md:h-8 data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
                aria-label={`${langName(l)}, ${plural(n, "phrase")}`}
                title={langName(l)}
              >
                {langCode(l)}
                <span className="text-xs text-muted-foreground tabular">{n}</span>
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <p className="text-xs text-muted-foreground tabular">
          {plural(rules.length, "phrase")} · {plural(languages.length, "language")}
        </p>
      </div>

      {/* Add keyword */}
      <form
        onSubmit={onSubmit}
        noValidate
        aria-label="Add a keyword"
        className="grid grid-cols-2 gap-3 bg-surface-sunken px-4 py-4 @md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] @2xl:grid-cols-[minmax(0,1fr)_10rem_9rem_auto]"
      >
        <Field data-invalid={!!error || undefined} className="col-span-2 gap-1.5 @md:col-span-3 @2xl:col-span-1">
          <FieldLabel htmlFor="rule-phrase">Phrase</FieldLabel>
          <Input
            ref={phraseRef}
            id="rule-phrase"
            value={phrase}
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. wir freuen uns"
            maxLength={MAX_LEN + 20}
            onChange={(e) => setPhrase(e.target.value)}
            aria-invalid={!!error || undefined}
            aria-describedby="rule-phrase-help"
            className={cn(CONTROL_H, "bg-background font-mono text-sm")}
          />
          <div id="rule-phrase-help" aria-live="polite" className="min-h-4">
            {error ? (
              <FieldError className="text-xs">{error}</FieldError>
            ) : duplicate ? (
              <p className="flex items-start gap-1.5 text-xs text-foreground">
                <Info aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
                <span>
                  “{duplicate.phrase}” is already a {STATUS_META[duplicate.status].label} keyword (
                  {langCode(duplicate.language)}).
                </span>
              </p>
            ) : overlaps.length ? (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info aria-hidden className="mt-px size-3.5 shrink-0" />
                <span>{overlapHint(status, overlaps[0].status)}</span>
              </p>
            ) : (
              <FieldDescription className="text-xs">
                Matches anywhere in the subject or body. Case doesn’t matter.
              </FieldDescription>
            )}
          </div>
        </Field>

        <Field className="gap-1.5">
          <FieldLabel htmlFor="rule-status">Status</FieldLabel>
          <Select value={status} onValueChange={(v) => setStatus(v as RuleStatus)}>
            <SelectTrigger id="rule-status" className={cn(SELECT_H, "w-full bg-background")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RULE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  <StatusDot status={s} />
                  {STATUS_META[s].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field className="gap-1.5">
          <FieldLabel htmlFor="rule-language">Language</FieldLabel>
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger id="rule-language" className={cn(SELECT_H, "w-full bg-background")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {addLanguages.map((l) => (
                <SelectItem key={l} value={l}>
                  <span className="w-6 font-mono text-xs text-muted-foreground">{langCode(l)}</span>
                  {langName(l)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field className="col-span-2 gap-1.5 @md:col-span-1">
          {/* Invisible label keeps the button aligned with the inputs. */}
          <span aria-hidden className="invisible hidden text-sm leading-snug @md:block">
            Add
          </span>
          <Button type="submit" className={cn(CONTROL_H, "w-full gap-1.5 px-3")} disabled={addRule.isPending}>
            {addRule.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <Plus aria-hidden />}
            {addRule.isPending ? "Adding…" : "Add"}
          </Button>
        </Field>
      </form>

      {/* Groups */}
      {RULE_STATUSES.map((s) => (
        <RuleGroup
          key={s}
          status={s}
          all={rules.filter((r) => r.status === s)}
          shown={visible.filter((r) => r.status === s)}
          languages={languages}
          filter={activeFilter}
          recentId={recentId}
          onRemove={remove}
          onAddHere={() => addHere(s)}
        />
      ))}

      <SettingsNote>
        <Info aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>
          Phrases match anywhere in the subject or body, case-insensitive. Later stages win over
          confirmations.
        </span>
      </SettingsNote>
    </SettingsCard>
  );
}

function RuleGroup({
  status,
  all,
  shown,
  languages,
  filter,
  recentId,
  onRemove,
  onAddHere,
}: {
  status: RuleStatus;
  all: KeywordRule[];
  shown: KeywordRule[];
  languages: string[];
  filter: string;
  recentId: string | null;
  onRemove: (rule: KeywordRule) => void;
  onAddHere: () => void;
}) {
  const meta = STATUS_META[status];
  const headingId = `rules-${status}`;
  const filtered = filter !== ALL;

  return (
    <section aria-labelledby={headingId} className="px-4 py-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id={headingId} className="flex">
          <StatusBadge status={status} size="md" />
        </h3>
        <span className="text-xs font-medium tabular">
          {filtered ? `${shown.length} of ${all.length}` : all.length}
        </span>
        <span className="text-xs text-muted-foreground">· {meta.description}</span>
        {!filtered && languages.length > 1 && (
          <span className="text-xs text-muted-foreground tabular @md:ml-auto">
            {languages.map((l, i) => {
              const n = all.filter((r) => r.language === l).length;
              return (
                <span key={l}>
                  {i > 0 && <span aria-hidden> · </span>}
                  <span
                    title={n ? `${plural(n, "phrase")} in ${langName(l)}` : `No ${langName(l)} phrases yet`}
                    className={cn(!n && "text-foreground underline decoration-dashed underline-offset-2")}
                  >
                    {langCode(l)} {n}
                  </span>
                </span>
              );
            })}
          </span>
        )}
      </div>

      {shown.length ? (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label={`${meta.label} phrases`}>
          {shown.map((rule) => (
            <RuleChip key={rule.id} rule={rule} recent={rule.id === recentId} onRemove={onRemove} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
          {filtered ? `No ${langName(filter)} phrases for ${meta.label} yet.` : "No phrases yet."}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={onAddHere}
          >
            Add one
          </Button>
        </p>
      )}
    </section>
  );
}

function RuleChip({
  rule,
  recent,
  onRemove,
}: {
  rule: KeywordRule;
  recent: boolean;
  onRemove: (rule: KeywordRule) => void;
}) {
  return (
    <li
      className={cn(
        "inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-md border bg-background py-1 pr-1 pl-2.5 transition-colors duration-200",
        recent && "border-primary/50 bg-primary/10",
      )}
    >
      <span className="min-w-0 font-mono text-xs break-words">{rule.phrase}</span>
      <span
        className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[11px] leading-none font-medium text-muted-foreground"
        title={langName(rule.language)}
      >
        <span aria-hidden>{langCode(rule.language)}</span>
        <span className="sr-only">{langName(rule.language)}</span>
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Remove “${rule.phrase}”`}
            onClick={() => onRemove(rule)}
            className="relative flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors duration-150 after:absolute after:-inset-2 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:after:-inset-1"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Remove</TooltipContent>
      </Tooltip>
    </li>
  );
}

function KeywordRulesSkeleton() {
  return (
    <SettingsCard aria-busy aria-label="Loading keyword rules">
      <div className="flex items-center justify-between px-4 py-3">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="bg-surface-sunken px-4 py-4">
        <Skeleton className="h-[62px] w-full" />
      </div>
      {RULE_STATUSES.map((s) => (
        <div key={s} className="px-4 py-4">
          <Skeleton className="h-6 w-40" />
          <div className="mt-3 flex flex-wrap gap-2">
            {[28, 36, 22, 30, 26].map((w, i) => (
              <Skeleton key={i} className="h-8" style={{ width: `${w * 4}px` }} />
            ))}
          </div>
        </div>
      ))}
    </SettingsCard>
  );
}
