import "server-only";
import { DEFAULT_PRIORITY } from "@/lib/types";
import type { ChangeSource, Email, EmailOutcome, Job, Priority, ReviewReason, Status } from "@/lib/types";

/**
 * The demo jobs and emails: what seedUser (seed.ts) writes into the public demo's workspaces and
 * `npm run db:seed` into a development database, and what the classifier tests run on
 * (tests/unit/classify.test.ts). It was the mock store's seed. The mail the mock delivered on
 * "Check inbox now" is now Gmail-shaped fixtures in fixtures/mail/.
 *
 *   buildSeed(now)  the jobs (with their history) and emails as the API returns them, with
 *                   fixture ids ("job_0001", "eml_0012") and times relative to `now`. Today's
 *                   items sit at fixed clock times up to 10:00; earlier in the day the whole
 *                   past moves back one day (as the fixture mail does), so nothing that has
 *                   happened is dated in the future and the gaps between items stay as they are
 *   EMAILS          the emails by key, before they are dated
 *
 * Plain data with imports from lib/types only (types and DEFAULT_PRIORITY): no database, no
 * I/O, nothing done at import time but building these constants. Times are set with the
 * server's local clock (Date#setHours).
 */

/* All companies, people and addresses below are fictional demo data. */

const DAY = 86_400_000;

function at(daysAgo: number, hour = 10, minute = 0, now = Date.now()) {
  const d = new Date(now - daysAgo * DAY);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function describe(opts: {
  company: string;
  about: string;
  role: string;
  tasks: string[];
  needs: string[];
  extras?: string[];
}) {
  return [
    `About ${opts.company}`,
    opts.about,
    "",
    "The role",
    opts.role,
    "",
    "What you'll do",
    ...opts.tasks.map((t) => `• ${t}`),
    "",
    "What we're looking for",
    ...opts.needs.map((t) => `• ${t}`),
    ...(opts.extras?.length ? ["", "What we offer", ...opts.extras.map((t) => `• ${t}`)] : []),
  ].join("\n");
}

const PERKS = [
  "30 days of paid vacation",
  "Flexible hours and hybrid work",
  "€1,500 yearly learning budget",
  "Public transport ticket",
];

interface SeedEvent {
  to: Status;
  daysAgo: number;
  source: ChangeSource;
  email?: string;
  note?: string;
}

interface SeedJob {
  key: string;
  title: string;
  company: string;
  location: string;
  url: string | null;
  captureMethod: Job["captureMethod"];
  /** DEFAULT_PRIORITY (medium) when left out. */
  priority?: Priority;
  locked?: boolean;
  events: SeedEvent[];
  description: string;
  /** Upcoming interview, relative to "now". */
  next?: { inDays: number; hour: number; minute?: number; round: string };
  /** Offer respond-by date, in days from "now". */
  respondInDays?: number;
}

export interface SeedEmail {
  key: string;
  job: string | null;
  fromName: string;
  fromAddress: string;
  subject: string;
  body: string;
  daysAgo: number;
  hour?: number;
  language: string;
  outcome: EmailOutcome;
  detected: Status | null;
  keywords: string[];
  change?: { from: Status | null; to: Status };
  reviewReason?: ReviewReason;
  suggested?: string[];
  suggestedStatus?: Status;
  confidence?: number;
}

const JOBS: SeedJob[] = [
  {
    key: "northwind",
    title: "Senior Frontend Engineer",
    company: "Northwind Labs",
    location: "Berlin · Hybrid",
    url: "https://boards.greenhouse.io/northwindlabs/jobs/4821930",
    captureMethod: "extension",
    events: [
      { to: "applied", daysAgo: 19, source: "extension" },
      { to: "interview", daysAgo: 6, source: "email", email: "northwind-invite" },
    ],
    next: { inDays: 2, hour: 14, round: "Technical interview" },
    description: describe({
      company: "Northwind Labs",
      about:
        "Northwind Labs builds planning software for mid-sized logistics teams. 60 people, profitable, and growing the product team in Berlin.",
      role: "You'll own the web app's front end together with two other engineers and a product designer.",
      tasks: [
        "Ship features end to end in React and TypeScript",
        "Shape our component library and design tokens",
        "Make large data tables fast and accessible",
      ],
      needs: [
        "5+ years building web applications",
        "Deep knowledge of React, TypeScript and CSS",
        "Care for accessibility and performance",
      ],
      extras: PERKS,
    }),
  },
  {
    key: "lumen",
    title: "Product Engineer (React)",
    company: "Lumen Health",
    location: "Remote · EU",
    url: "https://jobs.lever.co/lumenhealth/7f3a2c19-product-engineer",
    captureMethod: "extension",
    events: [{ to: "applied", daysAgo: 12, source: "extension" }],
    description: describe({
      company: "Lumen Health",
      about: "Lumen Health helps clinics run remote follow-up care. Fully remote across the EU.",
      role: "A product-minded engineer who enjoys talking to clinicians as much as writing code.",
      tasks: [
        "Build patient and clinician facing features",
        "Run small experiments and measure their impact",
        "Pair with design on new flows",
      ],
      needs: ["3+ years with React", "Experience with Node.js APIs", "Clear written communication"],
    }),
  },
  {
    key: "fernweh",
    title: "Full-Stack Developer",
    company: "Fernweh Mobility",
    location: "Munich",
    url: "https://fernweh-mobility.jobs.personio.de/job/1183022",
    captureMethod: "paste",
    priority: "high",
    events: [
      { to: "saved", daysAgo: 27, source: "paste" },
      { to: "applied", daysAgo: 21, source: "manual" },
      { to: "interview", daysAgo: 9, source: "email", email: "fernweh-invite" },
    ],
    description: describe({
      company: "Fernweh Mobility",
      about: "Fernweh Mobility runs an app for booking regional train and bus trips in Bavaria.",
      role: "Join the booking team and work across our Next.js front end and Kotlin services.",
      tasks: ["Build booking flows", "Improve checkout conversion", "Own features in production"],
      needs: ["TypeScript and one backend language", "SQL", "German or English"],
      extras: PERKS,
    }),
  },
  {
    key: "kelpie",
    title: "Data Visualization Engineer",
    company: "Kelpie Analytics",
    location: "Hamburg",
    url: "https://kelpie-analytics.example/careers/data-visualization-engineer",
    captureMethod: "extension",
    events: [
      { to: "applied", daysAgo: 34, source: "extension" },
      { to: "rejected", daysAgo: 15, source: "email", email: "kelpie-reject" },
    ],
    description: describe({
      company: "Kelpie Analytics",
      about: "Kelpie Analytics turns sensor data from wind farms into maintenance plans.",
      role: "Design and build the charts our customers look at every morning.",
      tasks: ["Build charts with D3 and Canvas", "Work with data scientists", "Own the chart library"],
      needs: ["D3 or similar", "Strong maths and design sense", "TypeScript"],
    }),
  },
  {
    key: "halcyon",
    title: "Software Engineer, Web Platform",
    company: "Halcyon Robotics",
    location: "Zurich",
    url: "https://halcyon.wd3.myworkdayjobs.com/careers/job/Zurich/software-engineer-web-platform_R-2291",
    captureMethod: "extension",
    priority: "high",
    events: [
      { to: "applied", daysAgo: 45, source: "extension" },
      { to: "interview", daysAgo: 31, source: "email", email: "halcyon-invite" },
      { to: "offer", daysAgo: 3, source: "email", email: "halcyon-offer" },
    ],
    respondInDays: 4,
    description: describe({
      company: "Halcyon Robotics",
      about: "Halcyon builds warehouse robots. The web platform team builds the fleet console.",
      role: "Help operators monitor and control hundreds of robots in real time.",
      tasks: ["Real-time dashboards over WebSockets", "Map and floor-plan views", "Design system work"],
      needs: ["Strong TypeScript", "Experience with real-time UIs", "Curiosity for hardware"],
      extras: ["Relocation support", "Half-fare travel card", "Equity"],
    }),
  },
  {
    key: "bramble",
    title: "Frontend Developer",
    company: "Bramble & Co",
    location: "Berlin",
    url: "https://bramble-co.example/jobs/frontend-developer",
    captureMethod: "extension",
    events: [{ to: "saved", daysAgo: 2, source: "extension" }],
    description: describe({
      company: "Bramble & Co",
      about: "Bramble & Co is a small studio building online shops for independent brands.",
      role: "Build fast, beautiful storefronts with our clients.",
      tasks: ["Build storefronts", "Work closely with designers", "Improve Core Web Vitals"],
      needs: ["HTML, CSS and JavaScript fundamentals", "An eye for detail"],
    }),
  },
  {
    key: "quarry",
    title: "TypeScript Engineer",
    company: "Quarry Systems",
    location: "Remote",
    url: "https://jobs.lever.co/quarry/1c9d-typescript-engineer",
    captureMethod: "paste",
    priority: "high",
    events: [{ to: "saved", daysAgo: 4, source: "paste" }],
    description: describe({
      company: "Quarry Systems",
      about: "Quarry Systems makes developer tools for infrastructure teams.",
      role: "Work on our CLI and web console, both written in TypeScript.",
      tasks: ["Build the web console", "Maintain the CLI", "Write docs you'd want to read"],
      needs: ["Strong TypeScript", "Comfort with the command line"],
    }),
  },
  {
    key: "tessellate",
    title: "Design Engineer",
    company: "Tessellate",
    location: "Amsterdam · Hybrid",
    url: "https://boards.greenhouse.io/tessellate/jobs/5512004",
    captureMethod: "extension",
    events: [
      { to: "applied", daysAgo: 16, source: "extension" },
      { to: "interview", daysAgo: 2, source: "email", email: "tessellate-invite" },
    ],
    next: { inDays: 1, hour: 11, round: "Intro call with the design lead" },
    description: describe({
      company: "Tessellate",
      about: "Tessellate is a whiteboard tool for architecture students.",
      role: "Sit between design and engineering and build the interactions that make the canvas feel good.",
      tasks: ["Prototype interactions", "Build production UI", "Own motion and micro-interactions"],
      needs: ["A portfolio of shipped UI work", "React and CSS", "Some Figma"],
    }),
  },
  {
    key: "orbit",
    title: "Frontend Engineer, Checkout",
    company: "Orbit Payments",
    location: "Berlin",
    url: "https://orbitpayments.example/careers/frontend-engineer-checkout",
    captureMethod: "extension",
    events: [{ to: "applied", daysAgo: 31, source: "extension" }],
    description: describe({
      company: "Orbit Payments",
      about: "Orbit Payments provides checkout for 4,000 online shops across Europe.",
      role: "Own the hosted checkout page that millions of shoppers see every month.",
      tasks: ["Build the checkout UI", "Run A/B tests", "Keep it accessible in 14 languages"],
      needs: ["React and TypeScript", "Experience with forms and validation", "Testing mindset"],
    }),
  },
  {
    key: "moss",
    title: "UI Engineer",
    company: "Moss Studio",
    location: "Vienna",
    url: "https://moss-studio.example/jobs/ui-engineer",
    captureMethod: "paste",
    priority: "low",
    events: [
      { to: "applied", daysAgo: 52, source: "paste" },
      { to: "no_response", daysAgo: 22, source: "time", note: "No reply in 30 days" },
    ],
    description: describe({
      company: "Moss Studio",
      about: "Moss Studio is a product studio working with cultural institutions.",
      role: "Build digital exhibitions and museum guides.",
      tasks: ["Build interactive exhibitions", "Work with curators", "Animate things tastefully"],
      needs: ["JavaScript and CSS", "Experience with animation libraries"],
    }),
  },
  {
    key: "parcelwerk",
    title: "Werkstudent Softwareentwicklung",
    company: "Parcelwerk GmbH",
    location: "Cologne",
    url: "https://parcelwerk.jobs.personio.de/job/994120",
    captureMethod: "extension",
    priority: "low",
    events: [
      { to: "applied", daysAgo: 40, source: "extension" },
      { to: "rejected", daysAgo: 26, source: "email", email: "parcelwerk-reject" },
    ],
    description: describe({
      company: "Parcelwerk GmbH",
      about: "Parcelwerk organisiert die letzte Meile für Paketdienste im Rheinland.",
      role: "Als Werkstudent:in arbeitest du 16–20 Stunden pro Woche in unserem Web-Team.",
      tasks: ["Interne Tools mit React bauen", "Tests schreiben", "Im Team Code reviewen"],
      needs: ["Eingeschriebenes Studium (Informatik o. ä.)", "Erste Erfahrung mit JavaScript"],
    }),
  },
  {
    key: "vantage",
    title: "Junior Web Developer",
    company: "Vantage Bio",
    location: "Frankfurt",
    url: "https://vantagebio.example/careers/junior-web-developer",
    captureMethod: "paste",
    events: [
      { to: "applied", daysAgo: 47, source: "paste" },
      { to: "no_response", daysAgo: 17, source: "time", note: "No reply in 30 days" },
    ],
    description: describe({
      company: "Vantage Bio",
      about: "Vantage Bio develops lab software for biotech research teams.",
      role: "Join a small team maintaining our customer portal.",
      tasks: ["Fix bugs and ship small features", "Learn from senior engineers"],
      needs: ["Basic React", "Willingness to learn"],
    }),
  },
  {
    key: "silt",
    title: "React Native Developer",
    company: "Silt & Stone",
    location: "Remote · Germany",
    url: "https://siltandstone.example/careers/react-native-developer",
    captureMethod: "extension",
    events: [{ to: "saved", daysAgo: 1, source: "extension" }],
    description: describe({
      company: "Silt & Stone",
      about: "Silt & Stone builds a gardening companion app with 400k monthly users.",
      role: "Own features in our React Native app from idea to store release.",
      tasks: ["Build features in React Native", "Improve app performance", "Release weekly"],
      needs: ["React Native experience", "A published app"],
    }),
  },
  {
    key: "cobalt",
    title: "Frontend Engineer (Angular)",
    company: "Cobalt Insurance",
    location: "Munich",
    url: "https://cobalt-insurance.example/karriere/frontend-engineer-angular",
    captureMethod: "extension",
    events: [
      { to: "applied", daysAgo: 29, source: "extension" },
      { to: "rejected", daysAgo: 8, source: "email", email: "cobalt-reject" },
    ],
    description: describe({
      company: "Cobalt Insurance",
      about: "Cobalt is a digital insurer for freelancers.",
      role: "Work on the customer portal built with Angular.",
      tasks: ["Build portal features", "Migrate legacy screens"],
      needs: ["Angular", "RxJS"],
    }),
  },
  {
    key: "brightline",
    title: "Softwareentwickler:in Web",
    company: "Brightline Energy",
    location: "Hamburg",
    url: "https://brightline-energy.example/karriere/softwareentwickler-web",
    captureMethod: "paste",
    events: [
      { to: "applied", daysAgo: 10, source: "paste" },
      { to: "applied", daysAgo: 10, source: "email", email: "brightline-confirm", note: "Confirmation received" },
    ],
    description: describe({
      company: "Brightline Energy",
      about: "Brightline Energy betreibt Solarparks in Norddeutschland.",
      role: "Du entwickelst unser Kundenportal und interne Dashboards weiter.",
      tasks: ["Features im Kundenportal bauen", "Dashboards für Anlagendaten"],
      needs: ["Erfahrung mit TypeScript", "Gute Deutschkenntnisse"],
    }),
  },
  {
    key: "nimbus",
    title: "Product Engineer",
    company: "Nimbus Docs",
    location: "Remote",
    url: "https://jobs.lever.co/nimbusdocs/aa91-product-engineer",
    captureMethod: "extension",
    events: [
      { to: "applied", daysAgo: 14, source: "extension" },
      { to: "interview", daysAgo: 5, source: "review", email: "nimbus-invite", note: "Confirmed from review" },
    ],
    next: { inDays: 6, hour: 15, minute: 30, round: "Final round" },
    description: describe({
      company: "Nimbus Docs",
      about: "Nimbus Docs is a collaborative documentation tool for engineering teams.",
      role: "Ship product improvements across the editor, search and sharing.",
      tasks: ["Build editor features", "Improve search", "Talk to customers"],
      needs: ["Full-stack TypeScript", "Product sense"],
    }),
  },
  {
    key: "atlas",
    title: "Full-Stack Engineer",
    company: "Atlas Freight",
    location: "Rotterdam",
    url: null,
    captureMethod: "email",
    priority: "low",
    events: [
      { to: "applied", daysAgo: 7, source: "email", email: "atlas-confirm", note: "Created from a confirmation email" },
    ],
    description:
      "Created automatically from a confirmation email. Paste the job link to fill in the description.",
  },
  {
    key: "juniper",
    title: "Frontend Developer",
    company: "Juniper Learning",
    location: "Berlin",
    url: "https://boards.greenhouse.io/juniperlearning/jobs/7710223",
    captureMethod: "extension",
    events: [
      { to: "applied", daysAgo: 11, source: "extension" },
    ],
    description: describe({
      company: "Juniper Learning",
      about: "Juniper Learning builds language courses for schools.",
      role: "Build the student app and teacher dashboard.",
      tasks: ["Build learning exercises", "Make everything work on cheap tablets"],
      needs: ["React", "Accessibility knowledge"],
    }),
  },
  {
    key: "kinfolk",
    title: "Web Engineer, Tools",
    company: "Kinfolk Games",
    location: "Stockholm",
    url: "https://kinfolkgames.example/careers/web-engineer-tools",
    captureMethod: "extension",
    priority: "high",
    events: [
      { to: "applied", daysAgo: 38, source: "extension" },
      { to: "interview", daysAgo: 24, source: "email", email: "kinfolk-invite" },
      { to: "rejected", daysAgo: 13, source: "email", email: "kinfolk-reject" },
    ],
    description: describe({
      company: "Kinfolk Games",
      about: "Kinfolk Games makes cosy multiplayer games.",
      role: "Build web-based tools for our level designers.",
      tasks: ["Level editor in the browser", "Asset pipeline dashboards"],
      needs: ["TypeScript", "Canvas or WebGL"],
    }),
  },
  {
    key: "polaris",
    title: "Frontend Engineer, Maps",
    company: "Polaris Maps",
    location: "Berlin",
    url: "https://polarismaps.example/jobs/frontend-engineer-maps",
    captureMethod: "paste",
    events: [
      { to: "applied", daysAgo: 44, source: "paste" },
      { to: "no_response", daysAgo: 14, source: "time", note: "No reply in 30 days" },
    ],
    description: describe({
      company: "Polaris Maps",
      about: "Polaris Maps makes offline-first maps for hikers.",
      role: "Work on our map rendering and route planner.",
      tasks: ["Map rendering with WebGL", "Route planner UI"],
      needs: ["WebGL or MapLibre", "TypeScript"],
    }),
  },
  {
    key: "ember",
    title: "Software Engineer",
    company: "Ember Finance",
    location: "London",
    url: "https://boards.greenhouse.io/emberfinance/jobs/3301877",
    captureMethod: "extension",
    priority: "high",
    events: [{ to: "applied", daysAgo: 6, source: "extension" }],
    description: describe({
      company: "Ember Finance",
      about: "Ember Finance builds accounting software for small businesses in the UK.",
      role: "Join one of our product squads as a generalist engineer.",
      tasks: ["Build features across the stack", "Join the on-call rotation"],
      needs: ["Any modern web stack", "Interest in fintech"],
    }),
  },
  {
    key: "hollow",
    title: "Werkstudent Frontend",
    company: "Hollow Pine",
    location: "Leipzig",
    url: "https://hollowpine.jobs.personio.de/job/552108",
    captureMethod: "extension",
    priority: "low",
    events: [{ to: "saved", daysAgo: 0, source: "extension" }],
    description: describe({
      company: "Hollow Pine",
      about: "Hollow Pine entwickelt Software für Tischlereien.",
      role: "Werkstudent:in im Frontend-Team, 15–20 Stunden pro Woche.",
      tasks: ["UI-Komponenten bauen", "Bugs fixen"],
      needs: ["Studium der Informatik o. ä.", "HTML, CSS, JavaScript"],
    }),
  },
  {
    key: "juniper-saved",
    title: "Senior Product Designer",
    company: "Juniper Learning",
    location: "Berlin",
    url: "https://boards.greenhouse.io/juniperlearning/jobs/7710991",
    captureMethod: "extension",
    priority: "low",
    locked: true,
    events: [
      { to: "applied", daysAgo: 25, source: "extension" },
      { to: "saved", daysAgo: 20, source: "manual", note: "Moved back: wants to apply again later" },
    ],
    description: describe({
      company: "Juniper Learning",
      about: "Juniper Learning builds language courses for schools.",
      role: "Lead design for the teacher dashboard.",
      tasks: ["Own the teacher experience", "Run research with teachers"],
      needs: ["5+ years product design", "Portfolio"],
    }),
  },
];

export const EMAILS: SeedEmail[] = [
  {
    key: "northwind-confirm",
    job: "northwind",
    fromName: "Northwind Labs Recruiting",
    fromAddress: "no-reply@northwindlabs.example",
    subject: "Thank you for applying to Northwind Labs",
    body: "Hi,\n\nThank you for applying for the Senior Frontend Engineer position at Northwind Labs. We received your application and our team will review it in the coming days.\n\nBest,\nNorthwind Labs Talent Team",
    daysAgo: 19,
    hour: 14,
    language: "en",
    outcome: "matched",
    detected: "applied",
    keywords: ["thank you for applying", "we received your application"],
    change: { from: "applied", to: "applied" },
    confidence: 0.95,
  },
  {
    key: "northwind-invite",
    job: "northwind",
    fromName: "Mara Lindqvist",
    fromAddress: "mara.lindqvist@northwindlabs.example",
    subject: "Next steps – Senior Frontend Engineer",
    body: "Hi,\n\nThanks again for your application. We enjoyed reading it and would love to invite you to a first interview with our engineering lead.\n\nCould you share your availability for next week? A 45-minute video call works best.\n\nCheers,\nMara",
    daysAgo: 6,
    hour: 9,
    language: "en",
    outcome: "matched",
    detected: "interview",
    keywords: ["interview", "availability"],
    change: { from: "applied", to: "interview" },
    confidence: 0.97,
  },
  {
    key: "lumen-confirm",
    job: "lumen",
    fromName: "Lumen Health",
    fromAddress: "careers@lumenhealth.example",
    subject: "We received your application",
    body: "Hello,\n\nWe received your application for Product Engineer (React). Our hiring team reviews every application and will get back to you within two weeks.\n\nWarm regards,\nLumen Health People Team",
    daysAgo: 12,
    hour: 16,
    language: "en",
    outcome: "matched",
    detected: "applied",
    keywords: ["we received your application"],
    change: { from: "applied", to: "applied" },
    confidence: 0.94,
  },
  {
    key: "fernweh-invite",
    job: "fernweh",
    fromName: "Jonas Huber",
    fromAddress: "jonas.huber@fernweh-mobility.example",
    subject: "Einladung zum Vorstellungsgespräch",
    body: "Hallo,\n\nvielen Dank für Ihre Bewerbung als Full-Stack Developer. Wir möchten Sie gerne zu einem Vorstellungsgespräch in unser Büro in München einladen.\n\nBitte teilen Sie uns zwei Terminvorschläge für die kommende Woche mit.\n\nViele Grüße\nJonas Huber",
    daysAgo: 9,
    hour: 11,
    language: "de",
    outcome: "matched",
    detected: "interview",
    keywords: ["vielen dank für ihre bewerbung", "vorstellungsgespräch", "terminvorschlag"],
    change: { from: "applied", to: "interview" },
    confidence: 0.96,
  },
  {
    key: "kelpie-reject",
    job: "kelpie",
    fromName: "Kelpie Analytics",
    fromAddress: "jobs@kelpie-analytics.example",
    subject: "Your application for Data Visualization Engineer",
    body: "Dear applicant,\n\nThank you for your interest in Kelpie Analytics. Unfortunately, we have decided to move forward with other candidates whose experience more closely matches our needs.\n\nWe wish you all the best in your search.\n\nKelpie Analytics",
    daysAgo: 15,
    hour: 8,
    language: "en",
    outcome: "matched",
    detected: "rejected",
    keywords: ["unfortunately", "other candidates"],
    change: { from: "applied", to: "rejected" },
    confidence: 0.98,
  },
  {
    key: "halcyon-invite",
    job: "halcyon",
    fromName: "Halcyon Robotics Talent",
    fromAddress: "talent@halcyon-robotics.example",
    subject: "Interview invitation – Software Engineer, Web Platform",
    body: "Hi,\n\nWe'd like to schedule a call with you to talk about the Web Platform role. Please pick a slot that works for you using the link below.\n\nBest regards,\nHalcyon Robotics",
    daysAgo: 31,
    hour: 10,
    language: "en",
    outcome: "matched",
    detected: "interview",
    keywords: ["interview", "schedule a call"],
    change: { from: "applied", to: "interview" },
    confidence: 0.97,
  },
  {
    key: "halcyon-offer",
    job: "halcyon",
    fromName: "Lea Baumann",
    fromAddress: "lea.baumann@halcyon-robotics.example",
    subject: "Your offer from Halcyon Robotics",
    body: "Hi,\n\nAfter our conversations, we are pleased to offer you the position of Software Engineer, Web Platform. You'll find the offer letter attached.\n\nPlease let us know if you have any questions — we're excited to hopefully welcome you to Zurich!\n\nLea",
    daysAgo: 3,
    hour: 15,
    language: "en",
    outcome: "matched",
    detected: "offer",
    keywords: ["pleased to offer", "offer letter"],
    change: { from: "interview", to: "offer" },
    confidence: 0.99,
  },
  {
    key: "tessellate-invite",
    job: "tessellate",
    fromName: "Tessellate Hiring",
    fromAddress: "hiring@tessellate.example",
    subject: "Let's talk! Design Engineer at Tessellate",
    body: "Hi there,\n\nWe loved your portfolio. Would you be up for a 30 minute interview with our design lead? Reply with your availability and we'll send an invite.\n\nThe Tessellate team",
    daysAgo: 2,
    hour: 13,
    language: "en",
    outcome: "matched",
    detected: "interview",
    keywords: ["interview", "availability"],
    change: { from: "applied", to: "interview" },
    confidence: 0.95,
  },
  {
    key: "parcelwerk-reject",
    job: "parcelwerk",
    fromName: "Parcelwerk Recruiting",
    fromAddress: "bewerbung@parcelwerk.example",
    subject: "Ihre Bewerbung als Werkstudent Softwareentwicklung",
    body: "Hallo,\n\nvielen Dank für Ihr Interesse an Parcelwerk. Leider müssen wir Ihnen mitteilen, dass wir uns für andere Kandidaten entschieden haben.\n\nWir wünschen Ihnen für Ihren weiteren Weg alles Gute.\n\nIhr Parcelwerk-Team",
    daysAgo: 26,
    hour: 9,
    language: "de",
    outcome: "matched",
    detected: "rejected",
    keywords: ["leider", "anderen kandidaten"],
    change: { from: "applied", to: "rejected" },
    confidence: 0.97,
  },
  {
    key: "cobalt-reject",
    job: "cobalt",
    fromName: "Cobalt Insurance",
    fromAddress: "karriere@cobalt-insurance.example",
    subject: "Update on your application",
    body: "Hi,\n\nThank you for taking the time to apply. After careful review we are not moving forward with your application at this time.\n\nKind regards,\nCobalt Insurance Recruiting",
    daysAgo: 8,
    hour: 17,
    language: "en",
    outcome: "matched",
    detected: "rejected",
    keywords: ["not moving forward"],
    change: { from: "applied", to: "rejected" },
    confidence: 0.93,
  },
  {
    key: "brightline-confirm",
    job: "brightline",
    fromName: "Brightline Energy",
    fromAddress: "jobs@brightline-energy.example",
    subject: "Eingangsbestätigung Ihrer Bewerbung",
    body: "Guten Tag,\n\nvielen Dank für Ihre Bewerbung. Ihre Bewerbung ist bei uns eingegangen und wird derzeit geprüft. Wir melden uns innerhalb von 14 Tagen bei Ihnen.\n\nMit freundlichen Grüßen\nBrightline Energy",
    daysAgo: 10,
    hour: 12,
    language: "de",
    outcome: "matched",
    detected: "applied",
    keywords: ["vielen dank für ihre bewerbung", "ihre bewerbung ist bei uns eingegangen", "eingangsbestätigung"],
    change: { from: "applied", to: "applied" },
    confidence: 0.96,
  },
  {
    key: "nimbus-invite",
    job: "nimbus",
    fromName: "Priya Raman",
    fromAddress: "priya@greenhouse-mail.example",
    subject: "Chat about the Product Engineer role?",
    body: "Hi!\n\nI'm a recruiter at Nimbus Docs. Your profile looks like a great fit — do you have time for a quick intro chat this week?\n\nPriya",
    daysAgo: 5,
    hour: 10,
    language: "en",
    outcome: "resolved",
    detected: null,
    keywords: [],
    change: { from: "applied", to: "interview" },
    reviewReason: "no_keyword",
    confidence: 0.55,
  },
  {
    key: "atlas-confirm",
    job: "atlas",
    fromName: "Atlas Freight Careers",
    fromAddress: "careers@atlasfreight.example",
    subject: "Thank you for applying – Full-Stack Engineer",
    body: "Hi,\n\nThank you for applying for the Full-Stack Engineer role at Atlas Freight in Rotterdam. We received your application and will be in touch soon.\n\nAtlas Freight",
    daysAgo: 7,
    hour: 18,
    language: "en",
    outcome: "created",
    detected: "applied",
    keywords: ["thank you for applying", "we received your application"],
    change: { from: null, to: "applied" },
    confidence: 0.9,
  },
  {
    key: "kinfolk-invite",
    job: "kinfolk",
    fromName: "Kinfolk Games",
    fromAddress: "jobs@kinfolkgames.example",
    subject: "Interview – Web Engineer, Tools",
    body: "Hej!\n\nWe would like to invite you to an interview with our tools team. Let us know your availability.\n\nKinfolk Games",
    daysAgo: 24,
    hour: 9,
    language: "en",
    outcome: "matched",
    detected: "interview",
    keywords: ["interview", "availability"],
    change: { from: "applied", to: "interview" },
    confidence: 0.96,
  },
  {
    key: "kinfolk-reject",
    job: "kinfolk",
    fromName: "Kinfolk Games",
    fromAddress: "jobs@kinfolkgames.example",
    subject: "Web Engineer, Tools – our decision",
    body: "Hi,\n\nThank you for interviewing with us. Unfortunately we decided to pursue other candidates for this role. It was a close decision.\n\nAll the best,\nKinfolk Games",
    daysAgo: 13,
    hour: 14,
    language: "en",
    outcome: "matched",
    detected: "rejected",
    keywords: ["unfortunately", "other candidates"],
    change: { from: "interview", to: "rejected" },
    confidence: 0.98,
  },
  {
    key: "ember-confirm",
    job: "ember",
    fromName: "Ember Finance",
    fromAddress: "no-reply@emberfinance.co.example",
    subject: "Application received: Software Engineer",
    body: "Thanks for applying to Ember Finance! Your application has been received. We aim to respond within 10 working days.",
    daysAgo: 6,
    hour: 19,
    language: "en",
    outcome: "matched",
    detected: "applied",
    keywords: ["your application has been received"],
    change: { from: "applied", to: "applied" },
    confidence: 0.95,
  },
  // Ignored (not job related)
  {
    key: "newsletter-1",
    job: null,
    fromName: "Design Weekly",
    fromAddress: "hello@designweekly.example",
    subject: "Issue #214: Variable fonts in practice",
    body: "This week: variable fonts, a new colour tool and five portfolios we loved.",
    daysAgo: 1,
    hour: 7,
    language: "en",
    outcome: "ignored",
    detected: null,
    keywords: [],
  },
  {
    key: "newsletter-2",
    job: null,
    fromName: "Deutsche Bahn",
    fromAddress: "buchung@bahn-mail.example",
    subject: "Ihre Reisebestätigung",
    body: "Vielen Dank für Ihre Buchung. Ihre Fahrkarte finden Sie im Anhang.",
    daysAgo: 3,
    hour: 20,
    language: "de",
    outcome: "ignored",
    detected: null,
    keywords: [],
  },
  // Needs review
  {
    key: "review-ambiguous",
    job: null,
    fromName: "Hiring Team",
    fromAddress: "no-reply@greenhouse-mail.example",
    subject: "Update on your Frontend Developer application",
    body: "Hi,\n\nThanks for your patience. The team has finished looking at applications for the Frontend Developer role in Berlin and we'd like to learn more about you. Could you fill out the short questionnaire linked below?\n\nBest,\nThe Hiring Team",
    daysAgo: 1,
    hour: 11,
    language: "en",
    outcome: "review",
    detected: null,
    keywords: [],
    reviewReason: "ambiguous_job",
    suggested: ["juniper", "bramble"],
    suggestedStatus: "interview",
    confidence: 0.45,
  },
  {
    key: "review-unknown",
    job: null,
    fromName: "Sophie Brandt",
    fromAddress: "s.brandt@meridian-consulting.example",
    subject: "Einladung zum Kennenlernen",
    body: "Hallo,\n\nich bin bei Meridian Consulting für das Recruiting zuständig. Wir würden Sie gerne für die Position Frontend Consultant kennenlernen. Hätten Sie nächste Woche Zeit für ein kurzes Telefonat?\n\nBeste Grüße\nSophie Brandt",
    daysAgo: 2,
    hour: 16,
    language: "de",
    outcome: "review",
    detected: "interview",
    keywords: ["kennenlernen"],
    reviewReason: "unknown_job",
    suggestedStatus: "interview",
    confidence: 0.4,
  },
  {
    key: "review-nokeyword",
    job: null,
    fromName: "Lumen Health",
    fromAddress: "careers@lumenhealth.example",
    subject: "Quick question about your application",
    body: "Hi,\n\nBefore we continue, could you share your salary expectations and your notice period?\n\nThanks,\nLumen Health People Team",
    daysAgo: 0,
    hour: 9,
    language: "en",
    outcome: "review",
    detected: null,
    keywords: [],
    reviewReason: "no_keyword",
    suggested: ["lumen"],
    confidence: 0.7,
  },
  {
    key: "review-conflict",
    job: null,
    fromName: "Jonas Huber",
    fromAddress: "jonas.huber@fernweh-mobility.example",
    subject: "Re: Interview next week",
    body: "Hi,\n\nunfortunately Thursday no longer works for our CTO. Could you share your availability for Monday or Tuesday instead? Sorry for the back and forth!\n\nJonas",
    daysAgo: 0,
    hour: 8,
    language: "en",
    outcome: "review",
    detected: "interview",
    keywords: ["unfortunately", "interview", "availability"],
    reviewReason: "conflicting_keywords",
    suggested: ["fernweh"],
    suggestedStatus: "interview",
    confidence: 0.6,
  },
];

/** The demo jobs and emails, as the API returns them, with fixture ids. */
export interface SeedData {
  jobs: Job[];
  emails: Email[];
}

export function buildSeed(now = Date.now()): SeedData {
  const seed = buildSeedAt(now, now);
  return happensAfter(seed, now) ? buildSeedAt(now - DAY, now) : seed;
}

/** True when an email, a job's creation or a status change of `seed` is later than `now`. */
function happensAfter({ jobs, emails }: SeedData, now: number): boolean {
  const times = [
    ...emails.map((e) => e.receivedAt),
    ...jobs.flatMap((j) => [j.createdAt, ...j.history.map((h) => h.at)]),
  ];
  return times.some((t) => Date.parse(t) > now);
}

/**
 * The seed with what has happened dated from `past`, and what is still to come (an interview, an
 * offer's deadline) from `now`.
 */
function buildSeedAt(past: number, now: number): SeedData {
  let n = 0;
  const id = (p: string) => `${p}_${(++n).toString(36).padStart(4, "0")}`;
  const jobIds = new Map<string, string>();
  const emailIds = new Map<string, string>();
  for (const j of JOBS) jobIds.set(j.key, id("job"));
  for (const e of EMAILS) emailIds.set(e.key, id("eml"));

  const emails: Email[] = EMAILS.map((e) => ({
    id: emailIds.get(e.key)!,
    fromName: e.fromName,
    fromAddress: e.fromAddress,
    subject: e.subject,
    body: e.body,
    receivedAt: at(e.daysAgo, e.hour ?? 10, (e.key.length * 7) % 60, past),
    language: e.language,
    outcome: e.outcome,
    jobId: e.job ? jobIds.get(e.job)! : null,
    detectedStatus: e.detected,
    matchedKeywords: e.keywords,
    statusChange: e.change ?? null,
    reviewReason: e.reviewReason ?? null,
    suggestedJobIds: (e.suggested ?? []).map((k) => jobIds.get(k)!),
    suggestedStatus: e.suggestedStatus ?? null,
    confidence: e.confidence ?? 0.9,
  }));

  const jobs: Job[] = JOBS.map((j) => {
    const jobId = jobIds.get(j.key)!;
    let prev: Status | null = null;
    const first = j.events[0];
    const history = j.events.map((ev, i) => {
      const event = {
        id: `${jobId}_ev${i}`,
        from: prev,
        to: ev.to,
        at: at(ev.daysAgo, ev.source === "email" ? 9 + (i % 8) : 10 + i, 15 * i, past),
        source: ev.source,
        emailId: ev.email ? emailIds.get(ev.email) : undefined,
        note: ev.note,
      };
      prev = ev.to;
      return event;
    });
    // Use the email's timestamp when an event was caused by an email.
    for (const ev of history) {
      const mail = ev.emailId && emails.find((m) => m.id === ev.emailId);
      if (mail) ev.at = mail.receivedAt;
    }
    const last = history[history.length - 1];
    const linked = emails.filter((m) => m.jobId === jobId);
    const appliedEvent = history.find((h) => h.to === "applied");
    const activity = [...history.map((h) => h.at), ...linked.map((m) => m.receivedAt)].sort();
    return {
      id: jobId,
      title: j.title,
      company: j.company,
      location: j.location,
      url: j.url,
      description: j.description,
      status: last.to,
      priority: j.priority ?? DEFAULT_PRIORITY,
      statusSource: last.source,
      statusLocked: j.locked ?? false,
      captureMethod: j.captureMethod,
      createdAt: at(first.daysAgo, 9, 30, past),
      appliedAt: appliedEvent?.at ?? null,
      updatedAt: last.at,
      lastActivityAt: activity[activity.length - 1],
      history,
      emailCount: linked.length,
      nextInterview:
        last.to === "interview" && j.next
          ? { at: at(-j.next.inDays, j.next.hour, j.next.minute ?? 0, now), round: j.next.round }
          : null,
      offerDeadline:
        last.to === "offer" && j.respondInDays !== undefined
          ? at(-j.respondInDays, 23, 59, now)
          : null,
    };
  });

  return { jobs, emails };
}
