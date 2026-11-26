import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoResults } from "@/components/dashboard/dashboard-states";
import { isMarkedPriority, parsePriorities, PRIORITY_META, priorityNote } from "@/lib/priority";
import { DEFAULT_PRIORITY, PRIORITIES, type Priority, type Status } from "@/lib/types";

// How a priority reads (src/lib/priority.ts): the dashboard's `?priority=` parameter, the labels,
// what a card or row says aloud, and the empty state's wording when the filter finds nothing.
// The sort is tests/unit/stages.test.ts; the dashboard in a browser is tests/e2e/jobs-priority.spec.ts.

describe("parsePriorities", () => {
  it("is empty without a parameter", () => {
    expect(parsePriorities(null)).toEqual([]);
    expect(parsePriorities("")).toEqual([]);
  });

  it("reads a comma list in High, Medium, Low order, once each", () => {
    expect(parsePriorities("high")).toEqual(["high"]);
    expect(parsePriorities("low,high")).toEqual(["high", "low"]);
    expect(parsePriorities("low,medium,high,low")).toEqual(["high", "medium", "low"]);
  });

  it("drops what isn't a priority: an edited or old link never breaks the board", () => {
    expect(parsePriorities("urgent")).toEqual([]);
    expect(parsePriorities("High,LOW")).toEqual([]);
    expect(parsePriorities(" high, low")).toEqual([]);
    expect(parsePriorities("urgent,low,,")).toEqual(["low"]);
  });
});

describe("priority labels", () => {
  it("has a label and bars for each priority, more bars for higher", () => {
    expect(Object.keys(PRIORITY_META).sort()).toEqual([...PRIORITIES].sort());
    for (const p of PRIORITIES) expect(PRIORITY_META[p].value).toBe(p);
    expect(PRIORITY_META.high).toMatchObject({ label: "High", long: "High priority", bars: 3 });
    expect(PRIORITY_META.medium).toMatchObject({ label: "Medium", long: "Medium priority", bars: 2 });
    expect(PRIORITY_META.low).toMatchObject({ label: "Low", long: "Low priority", bars: 1 });
  });

  it("marks and speaks only priorities other than the default (Medium)", () => {
    expect(DEFAULT_PRIORITY).toBe("medium");
    expect(isMarkedPriority("medium")).toBe(false);
    expect(isMarkedPriority("high")).toBe(true);
    expect(isMarkedPriority("low")).toBe(true);
    expect(priorityNote("medium")).toBe("");
    expect(priorityNote("high")).toBe("High priority. ");
    expect(priorityNote("low")).toBe("Low priority. ");
  });
});

describe("the empty state when filters find nothing", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, "|").replaceAll("&quot;", '"');
  function shown(q: string, statuses: Status[], priorities: Priority[]) {
    const html = renderToStaticMarkup(createElement(NoResults, { q, statuses, priorities, onClear: () => {} }));
    return text(html).split("|").filter(Boolean);
  }

  it("names one priority, or several joined with “or”", () => {
    expect(shown("", [], ["low"])).toEqual(["No low-priority jobs", "Nothing has this priority right now.", "Clear filters"]);
    expect(shown("", [], ["high", "low"])).toContain("No high- or low-priority jobs");
    expect(shown("", [], ["high", "medium", "low"])).toContain("No high-, medium- or low-priority jobs");
  });

  it("puts the priority before the status", () => {
    expect(shown("", ["applied", "interview"], ["high"])).toEqual([
      "No high-priority Applied or Interview jobs",
      "Nothing has this status and priority right now.",
      "Clear filters",
    ]);
  });

  it("with a search, names the filters and suggests changing them", () => {
    expect(shown("acme", [], ["high"])).toEqual([
      "No high-priority jobs match “acme”",
      "Try a shorter search or another filter.",
      "Clear filters",
    ]);
    expect(shown("acme", ["saved"], ["low"])).toContain("No low-priority Saved jobs match “acme”");
  });

  it("reads as before when no priority is picked", () => {
    expect(shown("acme", [], [])).toEqual([
      "No jobs match “acme”",
      "Search looks at company names and job titles.",
      "Clear filters",
    ]);
    expect(shown("", ["offer"], [])).toEqual(["No Offer jobs", "Nothing has this status right now.", "Clear filters"]);
  });
});
