"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatWhen, plural } from "@/lib/format";
import { buildOverview, type Overview, type Rate } from "@/lib/overview";
import { daysWaiting, isFollowUpDue } from "@/lib/stages";
import type { Job } from "@/lib/types";
import { cn } from "@/lib/utils";

/*
 * The KPI row at the top of the Applications page: what is waiting for a
 * reply (the lead tile, a filled dark surface), how many applications went
 * out per week, how many were answered, and how far they got.
 *
 * Neutral ink everywhere; the accent only marks applications that have gone
 * long enough without news to want a follow-up.
 */

/* Four tiles side by side need about 1024px; below that the row folds to two columns. */
const ROW = "grid grid-cols-1 gap-3 @xl:grid-cols-2 @5xl:grid-cols-[1.6fr_1.7fr_1fr_1.5fr]";
const STACK = "grid grid-cols-2 gap-3 @xl:grid-cols-1";
const TILE = "flex min-w-0 flex-col rounded-xl border bg-card p-4";
const LABEL = "text-meta";
/* Proportional figures: a standalone number looks loose with tabular digits. */
const FIGURE = "text-[1.625rem] leading-8 font-semibold tracking-tight";
const CAPTION = "text-xs text-muted-foreground";

/** How many waiting applications the lead tile lists. */
const CLOSEST = 3;

export function KpiRow({
  jobs,
  noResponseDays,
  onOpen,
}: {
  /** All jobs, unfiltered; undefined while loading. */
  jobs: Job[] | undefined;
  /** Days without a reply before a job moves to No response (Settings). */
  noResponseDays: number;
  onOpen: (id: string) => void;
}) {
  const data = useMemo(() => (jobs ? buildOverview(jobs) : undefined), [jobs]);
  if (!jobs || !data) return <KpiRowSkeleton />;

  return (
    <section aria-label="Overview" className={ROW}>
      <WaitingTile jobs={jobs} limit={noResponseDays} onOpen={onOpen} />
      <SentTile data={data} />
      <div className={STACK}>
        <StatTile
          label="Reply rate"
          value={percent(data.answered)}
          caption={
            data.sent === 0 ? "Nothing sent yet" : `${data.answered.part} of ${data.sent} answered`
          }
        />
        <StatTile
          label="Interviews in progress"
          value={String(data.interviewsInProgress)}
          caption={
            data.nextInterviewAt
              ? `Next: ${formatWhen(data.nextInterviewAt)}`
              : data.interviewsInProgress > 0
                ? "No date set yet"
                : "None right now"
          }
        />
      </div>
      <FunnelTile data={data} />
    </section>
  );
}

/* ------------------------------------------------------- waiting (lead) */

function WaitingTile({
  jobs,
  limit,
  onOpen,
}: {
  jobs: Job[];
  limit: number;
  onOpen: (id: string) => void;
}) {
  const waiting = useMemo(
    () =>
      jobs
        .filter((j) => j.status === "applied")
        .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? -1 : 1)),
    [jobs],
  );

  return (
    <section
      aria-labelledby="kpi-waiting"
      className="flex min-w-0 flex-col rounded-xl bg-lead p-4 text-lead-foreground"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 id="kpi-waiting" className={cn(LABEL, "shrink-0")}>
          Waiting for a reply
        </h2>
        <p className="max-w-40 min-w-0 text-right text-xs text-balance text-lead-foreground/75">
          Jobs move to No response after {plural(limit, "day")}
        </p>
      </div>
      {/* The one hero figure on the page. */}
      <p className="mt-1 text-5xl leading-none font-semibold tracking-tight">{waiting.length}</p>

      <div className="mt-4 flex flex-1 flex-col border-t border-lead-foreground/20 pt-3">
        {waiting.length === 0 ? (
          <p className="text-xs text-lead-foreground/75">
            Nothing is waiting. Applications you send show up here until the company answers.
          </p>
        ) : (
          <>
            <p className="text-xs text-lead-foreground/75">Closest to {plural(limit, "day")}</p>
            <ul className="-mx-2 mt-1.5 flex flex-col">
              {waiting.slice(0, CLOSEST).map((job) => {
                const days = daysWaiting(job);
                return (
                  <li key={job.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(job.id)}
                      className="grid w-full cursor-pointer grid-cols-[minmax(0,2fr)_minmax(1.5rem,1fr)_auto] items-center gap-3 rounded-md px-2 py-1 text-left text-meta outline-none transition-colors duration-150 hover:bg-lead-foreground/10 focus-visible:ring-3 focus-visible:ring-lead-foreground/40"
                    >
                      <span className="truncate">{job.company}</span>
                      <Meter
                        value={days}
                        max={limit}
                        trackClass="bg-lead-foreground/20"
                        fillClass={isFollowUpDue(job) ? "bg-lead-attention" : "bg-lead-foreground"}
                      />
                      <span className="text-right font-semibold whitespace-nowrap tabular">
                        {plural(days, "day")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

/** A thin progress bar. Decorative: the number always sits next to it. */
export function Meter({
  value,
  max,
  trackClass = "bg-muted",
  fillClass = "bg-chart-sent",
  className,
}: {
  value: number;
  max: number;
  trackClass?: string;
  fillClass?: string;
  className?: string;
}) {
  const share = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  return (
    <span aria-hidden className={cn("block h-1 overflow-hidden rounded-full", trackClass, className)}>
      <span
        className={cn("block h-full rounded-full", fillClass)}
        // A non-zero value never disappears: at least a dot.
        style={{ width: share === 0 ? 0 : `max(${(share * 100).toFixed(1)}%, 0.25rem)` }}
      />
    </span>
  );
}

/* ------------------------------------------------------------ sent chart */

const CHART_CONFIG = {
  sent: { label: "Sent", color: "var(--chart-sent)" },
} satisfies ChartConfig;

function SentTile({ data }: { data: Overview }) {
  const { weeks } = data;
  const last = weeks.length - 1;
  // About four date labels, evenly spaced from the first week.
  const tickEvery = Math.max(1, Math.ceil(weeks.length / 4));

  return (
    <section aria-labelledby="kpi-sent" className={TILE}>
      <div className="flex items-start justify-between gap-4">
        <div className="shrink-0">
          <h2 id="kpi-sent" className={LABEL}>
            Applications sent
          </h2>
          <p className={FIGURE}>{data.sent}</p>
        </div>
        <p className={cn(CAPTION, "min-w-0 text-right")}>
          {data.sentThisWeek} this week, {data.sentLastWeek} last week
          <br />
          Per week, last {weeks.length} weeks
        </p>
      </div>

      {/* The chart fills what the row's tallest tile leaves; never under 7rem. */}
      <div className="relative mt-2 min-h-28 flex-1">
        <ChartContainer config={CHART_CONFIG} className="absolute inset-0 aspect-auto h-full w-full">
          <BarChart data={weeks} margin={{ top: 18, right: 0, bottom: 0, left: 0 }} barCategoryGap="25%">
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              interval={0}
              tickFormatter={(label: string, i: number) => (i % tickEvery === 0 ? label : "")}
              className="tabular"
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tickCount={3}
              width={20}
              tickMargin={4}
              className="tabular"
            />
            <ChartTooltip
              cursor={{ fill: "var(--muted)" }}
              content={<ChartTooltipContent labelFormatter={(label) => `Week of ${label}`} />}
            />
            {/* No grow animation: the row is read at a glance, not watched. */}
            <Bar
              dataKey="sent"
              fill="var(--color-sent)"
              radius={[3, 3, 0, 0]}
              maxBarSize={14}
              isAnimationActive={false}
            >
              {/* Only the current week carries its value; the axis and tooltip cover the rest. */}
              <LabelList
                dataKey="sent"
                content={({ x, y, width, value, index }) =>
                  index === last ? (
                    <text
                      x={Number(x) + Number(width) / 2}
                      y={Number(y) - 6}
                      textAnchor="middle"
                      className="fill-foreground text-[11px] font-medium tabular"
                    >
                      {value}
                    </text>
                  ) : null
                }
              />
            </Bar>
          </BarChart>
        </ChartContainer>
      </div>

      {/* The same numbers for screen readers: the chart never gates a value. */}
      <table className="sr-only">
        <caption>Applications sent per week</caption>
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col">Applications sent</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w.weekStart}>
              <th scope="row">{w.label}</th>
              <td>{w.sent}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* ------------------------------------------------------------ stat tiles */

function StatTile({ label, value, caption }: { label: string; value: string; caption: string }) {
  return (
    <dl className={cn(TILE, "justify-center")}>
      <dt className={LABEL}>{label}</dt>
      <dd className={cn(FIGURE, "mt-1")}>{value}</dd>
      <dd className={cn(CAPTION, "mt-1 tabular")}>{caption}</dd>
    </dl>
  );
}

/* ---------------------------------------------------------------- funnel */

function FunnelTile({ data }: { data: Overview }) {
  const steps: Array<{ label: string; rate: Rate; base?: boolean }> = [
    { label: "Sent", rate: { part: data.sent, whole: data.sent, percent: null }, base: true },
    { label: "Answered", rate: data.answered },
    { label: "Reached an interview", rate: data.interviewed },
    { label: "Offer", rate: data.offers },
  ];

  return (
    <section aria-labelledby="kpi-funnel" className={TILE}>
      <h2 id="kpi-funnel" className="text-[15px] leading-5 font-semibold">
        From sent to offer
      </h2>
      <dl className="mt-3 flex flex-1 flex-col justify-between gap-3">
        {steps.map(({ label, rate, base }) => (
          <div key={label} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-meta">
              <dt className="truncate">{label}</dt>
              <dd className="whitespace-nowrap tabular">
                <span className="font-semibold">{rate.part}</span>
                {!base && rate.percent !== null && (
                  <span className="ml-1 text-xs text-muted-foreground">{rate.percent}%</span>
                )}
              </dd>
            </div>
            <Meter value={rate.part} max={rate.whole} />
          </div>
        ))}
      </dl>
    </section>
  );
}

function percent(rate: Rate) {
  return rate.percent === null ? "–" : `${rate.percent}%`;
}

/* -------------------------------------------------------------- skeleton */

export function KpiRowSkeleton() {
  const tile = "animate-pulse rounded-xl bg-muted";
  return (
    <div aria-hidden className={ROW}>
      <span className={cn(tile, "h-56")} />
      <span className={cn(tile, "h-56")} />
      <div className={STACK}>
        <span className={cn(tile, "min-h-24")} />
        <span className={cn(tile, "min-h-24")} />
      </div>
      <span className={cn(tile, "h-56")} />
    </div>
  );
}
