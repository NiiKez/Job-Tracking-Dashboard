// Job pages for the extension to read, served at the addresses they have on the web.
//
// context.route() answers in the browser before any DNS lookup, so a routed address on a real
// host (www.linkedin.com) loads while the project's host-resolver rule ("MAP * ~NOTFOUND,
// EXCLUDE 127.0.0.1", playwright.config.ts) still holds for everything else: a request the test
// didn't route, such as an image on the fixture page, fails at DNS and never leaves the machine.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext } from "@playwright/test";

/** The site readers' saved pages (tests/extension/page/fixtures), shared with their unit tests. */
const SITE_FIXTURES = path.resolve(__dirname, "../../../extension/page/fixtures");

export function siteFixture(name: string): string {
  return readFileSync(path.join(SITE_FIXTURES, name), "utf8");
}

/** Answers requests for exactly `url` with `html`, for the rest of the test. */
export async function servePage(context: BrowserContext, url: string, html: string): Promise<void> {
  const href = new URL(url).href;
  await context.route(
    (requested) => requested.href === href,
    (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        body: html,
      }),
  );
}

/**
 * An invented posting on a company's career site with schema.org JobPosting JSON-LD, which the
 * tracker reads first. The tab's address carries tracking parameters; the canonical link (same
 * host) is the job's link.
 */
export const CAREERS_JOB = {
  url: "https://jobs.example.com/careers/4711-backend-engineer-payments?utm_source=newsletter&utm_medium=email",
  link: "https://jobs.example.com/careers/4711-backend-engineer-payments",
  title: "Backend Engineer, Payments",
  company: "Larkspur Payments GmbH",
  location: "Leipzig, DE",
  /** A line of the description. */
  descriptionLine: "Own the settlement service and its on-call rota",
  html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>We're hiring: Backend Engineer – Larkspur Careers</title>
  <link rel="canonical" href="https://jobs.example.com/careers/4711-backend-engineer-payments">
  <meta property="og:title" content="Join Larkspur as a Backend Engineer">
  <meta property="og:site_name" content="Larkspur Careers">
  <script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Backend Engineer, Payments",
    datePosted: "2026-11-10",
    employmentType: "FULL_TIME",
    hiringOrganization: { "@type": "Organization", name: "Larkspur Payments GmbH", sameAs: "https://www.example.com" },
    jobLocation: {
      "@type": "Place",
      address: { "@type": "PostalAddress", addressLocality: "Leipzig", addressCountry: "DE" },
    },
    description:
      "<p>Larkspur settles card payments for 4,000 independent shops across Germany.</p>" +
      "<p><strong>What you will do</strong></p>" +
      "<ul><li>Own the settlement service and its on-call rota</li>" +
      "<li>Make payouts reconcile without a spreadsheet</li></ul>",
  })}</script>
</head>
<body>
  <header><a href="/">Larkspur</a> <a href="/careers">All jobs</a></header>
  <main>
    <h1>Backend Engineer, Payments</h1>
    <p>Leipzig · Full-time</p>
    <p>Larkspur settles card payments for 4,000 independent shops across Germany.</p>
    <a href="/careers/4711-backend-engineer-payments/apply">Apply</a>
  </main>
</body>
</html>`,
} as const;

/** LinkedIn, a posting's own page (fixture linkedin-view.html), with LinkedIn's tracking parameters. */
export const LINKEDIN_VIEW = {
  url: "https://www.linkedin.com/jobs/view/4012345678/?refId=abc&trackingId=def",
  link: "https://www.linkedin.com/jobs/view/4012345678/",
  title: "Senior Platform Engineer",
  company: "Brightmoor Analytics GmbH",
  location: "Berlin, Germany",
  descriptionLine: "Run our Kubernetes clusters and the tooling around them",
  fixture: "linkedin-view.html",
} as const;

/** LinkedIn, a job search with one posting open beside the list (fixture linkedin-search.html). */
export const LINKEDIN_SEARCH = {
  url: "https://www.linkedin.com/jobs/search/?currentJobId=4098765432&keywords=platform&origin=JOBS_HOME",
  link: "https://www.linkedin.com/jobs/view/4098765432/",
  title: "Site Reliability Engineer (m/w/d)",
  company: "Ostwind Mobility GmbH",
  fixture: "linkedin-search.html",
} as const;
