// Invented jobs for the email-rule fixtures (tests/fixtures/rules/mail.ts). Companies, people and
// addresses are made up; domains are *.example. Times are relative to RULES_NOW.
import type { ChangeSource, Job, Status } from "@/lib/types";

const DAY = 86_400_000;

/** The fixtures' clock: 2026-11-10 12:00 UTC. */
export const RULES_NOW = new Date(Date.UTC(2026, 10, 10, 12));

export const daysAgo = (days: number) => new Date(RULES_NOW.getTime() - days * DAY);

function job(opts: {
  id: string;
  company: string;
  title: string;
  url?: string;
  locked?: boolean;
  /** [status, days ago, source], oldest first: the first one created the job. */
  events: Array<[Status, number, ChangeSource]>;
}): Job {
  let from: Status | null = null;
  const history = opts.events.map(([to, days, source], i) => {
    const event = { id: `${opts.id}_ev${i}`, from, to, at: daysAgo(days).toISOString(), source };
    from = to;
    return event;
  });
  const first = history[0];
  const last = history[history.length - 1];
  return {
    id: opts.id,
    title: opts.title,
    company: opts.company,
    location: "",
    url: opts.url ?? null,
    description: "",
    status: last.to,
    priority: "medium",
    statusSource: last.source,
    statusLocked: opts.locked ?? false,
    captureMethod: "extension",
    createdAt: first.at,
    appliedAt: history.find((e) => e.to === "applied")?.at ?? null,
    updatedAt: last.at,
    lastActivityAt: last.at,
    history,
    emailCount: 0,
    nextInterview: null,
    offerDeadline: null,
  };
}

export const FIXTURE_JOBS: Job[] = [
  job({
    id: "job_lindenhof",
    company: "Lindenhof Logistics",
    title: "Frontend Engineer",
    url: "https://lindenhof-logistics.example/careers/frontend-engineer",
    events: [["applied", 20, "extension"]],
  }),
  job({
    id: "job_quokka",
    company: "Quokka Labs",
    title: "Platform Engineer",
    url: "https://boards.greenhouse.example/quokkalabs/jobs/1182",
    events: [
      ["applied", 30, "extension"],
      ["interview", 10, "email"],
    ],
  }),
  job({
    id: "job_sternwarte",
    company: "Sternwarte Software GmbH",
    title: "Softwareentwickler Backend",
    url: "https://sternwarte.jobs.personio.example/job/5512",
    events: [["applied", 15, "extension"]],
  }),
  job({
    id: "job_brueckenwerk",
    company: "Brückenwerk AG",
    title: "Werkstudent Frontend",
    url: "https://brueckenwerk.example/karriere/werkstudent-frontend",
    events: [
      ["applied", 28, "paste"],
      ["interview", 14, "email"],
    ],
  }),
  // Closed: an offer.
  job({
    id: "job_marigold",
    company: "Marigold Health",
    title: "Product Designer",
    url: "https://marigoldhealth.example/jobs/product-designer",
    events: [
      ["applied", 40, "extension"],
      ["interview", 25, "email"],
      ["offer", 5, "email"],
    ],
  }),
  // Closed: rejected.
  job({
    id: "job_kestrel",
    company: "Kestrel Analytics",
    title: "Data Engineer",
    url: "https://kestrel-analytics.example/careers/data-engineer",
    events: [
      ["applied", 35, "extension"],
      ["rejected", 12, "email"],
    ],
  }),
  // Changed by hand, so locked against email.
  job({
    id: "job_pinecone",
    company: "Pinecone Robotics",
    title: "Embedded Engineer",
    url: "https://pinecone-robotics.example/jobs/embedded-engineer",
    locked: true,
    events: [
      ["applied", 22, "extension"],
      ["interview", 8, "manual"],
    ],
  }),
  job({
    id: "job_tidewater",
    company: "Tidewater Games",
    title: "Web Developer",
    url: "https://tidewatergames.example/careers/web-developer",
    events: [["saved", 3, "extension"]],
  }),
  // Added two days ago.
  job({
    id: "job_halvard",
    company: "Halvard Systems",
    title: "Backend Engineer",
    url: "https://halvard-systems.example/jobs/backend-engineer",
    events: [["applied", 2, "paste"]],
  }),
  // Two jobs at one company.
  job({
    id: "job_orchard_web",
    company: "Orchard Bank",
    title: "Frontend Engineer",
    url: "https://orchardbank.example/careers/frontend-engineer",
    events: [["applied", 18, "extension"]],
  }),
  job({
    id: "job_orchard_mobile",
    company: "Orchard Bank",
    title: "Mobile Engineer",
    url: "https://orchardbank.example/careers/mobile-engineer",
    events: [["applied", 17, "extension"]],
  }),
  job({
    id: "job_copperleaf",
    company: "Copperleaf",
    title: "UI Developer",
    url: "https://copperleaf.example/jobs/ui-developer",
    events: [
      ["applied", 50, "extension"],
      ["no_response", 20, "time"],
    ],
  }),
];
