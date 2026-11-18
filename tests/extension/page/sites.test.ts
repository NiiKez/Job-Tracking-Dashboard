// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { SiteFields } from "@/lib/types";
import { readPage } from "../../../extension/src/page/read-page";
import { generic, readerFor } from "../../../extension/src/page/sites";
import { mainCandidates } from "../../../extension/src/page/sites/generic";
import { fixture, page } from "./load";

// Each site reader on a fixture that copies the site's markup with invented content. The
// expected fields are what the popup would show; the noise around them (buttons, similar jobs,
// cookie dialogs) must never get in.

function site(doc: Document, url: string) {
  return readPage(doc, new URL(url), "").site;
}

interface Case {
  fixture: string;
  url: string;
  reader: string;
  fields: SiteFields;
}

const CASES: Case[] = [
  {
    fixture: "linkedin-view.html",
    url: "https://www.linkedin.com/jobs/view/4012345678/?refId=abc&trackingId=def",
    reader: "linkedin",
    fields: {
      url: "https://www.linkedin.com/jobs/view/4012345678/",
      title: "Senior Platform Engineer",
      company: "Brightmoor Analytics GmbH",
      location: "Berlin, Germany",
      description: [
        "Brightmoor builds the forecasting platform that regional energy suppliers use to plan the grid a day ahead. Our platform team keeps 40 services running for 30 engineers.",
        "",
        "What you will do",
        "",
        "• Run our Kubernetes clusters and the tooling around them",
        "• Make deploys boring: one pipeline, fast rollbacks",
        "• Pair with product teams on observability",
        "",
        "What you bring",
        "",
        "• 5+ years running production systems",
        "• Terraform and one of Go or Rust",
        "",
        "Questions? Write to jobs@example.com.",
      ].join("\n"),
    },
  },
  {
    fixture: "stepstone.html",
    url: "https://www.stepstone.de/stellenangebote--Data-Engineer-m-w-d-Hamburg-Kestrel-Freight-AG--11223344-inline.html?rltr=1",
    reader: "stepstone",
    fields: {
      title: "Data Engineer (m/w/d)",
      company: "Kestrel Freight AG",
      location: "Hamburg",
      description: [
        "Kestrel Freight bewegt jeden Tag 4.000 Container zwischen Hamburg und dem Hinterland. Unser Datenteam macht daraus Fahrpläne.",
        "",
        "Ihre Aufgaben",
        "",
        "• Datenpipelines in Python und SQL bauen und betreiben",
        "• Ein Data Warehouse für die Disposition modellieren",
        "",
        "Ihr Profil",
        "",
        "• Erfahrung mit dbt oder Airflow",
        "• Sehr gute Deutschkenntnisse",
        "",
        "Wir bieten",
        "",
        "• 30 Tage Urlaub",
        "• Deutschlandticket",
      ].join("\n"),
    },
  },
  {
    fixture: "indeed-view.html",
    url: "https://de.indeed.com/viewjob?jk=a1b2c3d4e5f60718&from=serp&tk=1abc",
    reader: "indeed",
    fields: {
      url: "https://de.indeed.com/viewjob?jk=a1b2c3d4e5f60718",
      title: "Backend-Entwickler (m/w/d)",
      company: "Saltmarsh Energy GmbH",
      location: "10115 Berlin",
      description: [
        "Über uns",
        "",
        "Saltmarsh Energy plant Batteriespeicher für Stadtwerke. Wir sind 60 Leute in Berlin-Mitte.",
        "",
        "Deine Aufgaben",
        "",
        "• APIs für unsere Speicherplanung in Kotlin entwickeln",
        "• Messdaten aus 200 Anlagen verarbeiten",
        "",
        "Das bringst du mit",
        "",
        "• Erfahrung mit JVM-Sprachen",
        "• Interesse an der Energiewende",
      ].join("\n"),
    },
  },
  {
    fixture: "xing.html",
    url: "https://www.xing.com/jobs/muenchen-product-designer-ux-ui-131415161",
    reader: "xing",
    fields: {
      title: "Product Designer UX/UI (m/w/d)",
      company: "Vellum Health GmbH",
      location: "München",
      description:
        "Vellum Health baut eine App für die Nachsorge nach Operationen. Du gestaltest sie mit uns.\n\nDeine Aufgaben\n\n• Nutzerinterviews mit Patientinnen und Ärzten\n• Prototypen in Figma",
    },
  },
  {
    fixture: "glassdoor.html",
    url: "https://www.glassdoor.de/Job/hamburg-data-analyst-jobs-SRCH_IL.0,7_IC2632180_KO8,20.htm?jl=1009876543210",
    reader: "glassdoor",
    fields: {
      url: "https://www.glassdoor.de/Job/hamburg-data-analyst-jobs-SRCH_IL.0,7_IC2632180_KO8,20.htm?jl=1009876543210",
      title: "Data Analyst (m/w/d)",
      company: "Cobaltwave",
      location: "Hamburg",
      description:
        "Cobaltwave baut Software für Windparks. Im Team Analytics wertest du Turbinendaten aus.\n\nDeine Aufgaben:\n\n• Auswertungen in Python und SQL\n• Berichte für unsere Kunden",
    },
  },
  {
    fixture: "arbeitsagentur.html",
    url: "https://www.arbeitsagentur.de/jobsuche/jobdetail/10000-1198765432-S",
    reader: "arbeitsagentur",
    fields: {
      title: "Fachinformatiker Anwendungsentwicklung (m/w/d)",
      company: "Marlowe & Finch Consulting GmbH",
      location: "04109 Leipzig, Sachsen",
      description: [
        "Wir entwickeln Fachanwendungen für Behörden in Sachsen.",
        "",
        "Ihre Aufgaben:",
        "- Weiterentwicklung unserer Java-Anwendungen",
        "- Abstimmung mit unseren Kunden",
        "",
        "Ihr Profil:",
        "- Abgeschlossene Ausbildung als Fachinformatiker/in",
      ].join("\n"),
    },
  },
  {
    fixture: "personio.html",
    url: "https://tannenhof-software.jobs.personio.de/job/1543210?language=de&display=de",
    reader: "personio",
    fields: {
      title: "Werkstudent Softwareentwicklung (m/w/d)",
      location: "Freiburg im Breisgau",
      description:
        "Über uns\n\nTannenhof Software entwickelt Planungssoftware für Forstbetriebe.\n\nDeine Aufgaben\n\n• Neue Funktionen in unserer Web-App umsetzen\n• Tests schreiben\n\nWas wir bieten\n\n• Flexible Arbeitszeiten",
    },
  },
  {
    fixture: "greenhouse.html",
    url: "https://job-boards.greenhouse.io/lumenfieldlabs/jobs/4567890005",
    reader: "greenhouse",
    fields: {
      title: "Staff Frontend Engineer",
      company: "Lumenfield Labs",
      location: "Remote, Europe",
      description:
        "Lumenfield Labs makes lab notebooks that run in the browser. We are 25 people across Europe.\n\nWhat you'll do\n\n• Own our editor's performance\n• Mentor two frontend engineers\n\nAbout you\n\n• Deep TypeScript and React experience\n\nSalary range\n€90,000—€115,000 EUR",
    },
  },
  {
    fixture: "greenhouse-classic.html",
    url: "https://boards.greenhouse.io/okapirobotics/jobs/4012345005",
    reader: "greenhouse",
    fields: {
      title: "Customer Success Manager (DACH)",
      company: "Okapi Robotics",
      location: "Munich, Germany",
      description:
        "Okapi Robotics builds picking robots for mid-sized warehouses.\n\nResponsibilities\n\n• Onboard new customers in Germany, Austria and Switzerland\n• Run quarterly reviews",
    },
  },
  {
    fixture: "lever.html",
    url: "https://jobs.lever.co/fernhillgames/3f6c1d2e-0000-4000-8000-00000000abcd",
    reader: "lever",
    fields: {
      title: "Senior Gameplay Programmer",
      company: "Fernhill Games",
      location: "Hamburg, Germany",
      description: [
        "Fernhill Games makes cozy strategy games for PC and consoles.",
        "",
        "We are looking for a gameplay programmer to build the systems of our next title.",
        "",
        "What you'll do",
        "",
        "• Build gameplay systems in C#",
        "• Work closely with design",
        "",
        "What you bring",
        "",
        "• Shipped at least one game",
        "",
        "Fernhill Games is an equal opportunity employer.",
      ].join("\n"),
    },
  },
  {
    fixture: "workday.html",
    url: "https://saltmarsh.wd3.myworkdayjobs.com/en-US/External/job/Leipzig/Senior-Payroll-Specialist--m-w-d-_R-104233",
    reader: "workday",
    fields: {
      title: "Senior Payroll Specialist (m/w/d)",
      location: "Leipzig; Hamburg",
      description:
        "Your role\n\nYou run the monthly payroll for 900 employees in Germany together with two colleagues.\n\nYour profile\n\n• Training as a payroll accountant\n• Experience with DATEV",
    },
  },
  {
    fixture: "smartrecruiters.html",
    url: "https://jobs.smartrecruiters.com/JuniperRidge/744000000000001-lagerlogistiker-m-w-d-",
    reader: "smartrecruiters",
    fields: {
      title: "Lagerlogistiker (m/w/d)",
      company: "Juniper Ridge Logistics",
      location: "Bremen, Bremen, Germany",
      description: [
        "Unternehmensbeschreibung",
        "",
        "Juniper Ridge betreibt Lager in Bremen und Hamburg.",
        "",
        "Stellenbeschreibung",
        "",
        "• Wareneingang und Kommissionierung",
        "• Staplerfahren",
        "",
        "Qualifikationen",
        "",
        "• Ausbildung als Fachkraft für Lagerlogistik",
        "",
        "Zusätzliche Informationen",
        "",
        "Schichtzulagen und ein Jobrad.",
      ].join("\n"),
    },
  },
  {
    fixture: "join.html",
    url: "https://join.com/companies/polderdata/10203040-junior-marketing-manager-m-w-d",
    reader: "join",
    fields: {
      title: "Junior Marketing Manager (m/w/d)",
      company: "Polder Data GmbH",
      location: "Köln, Deutschland",
      description:
        "Über uns\n\nPolder Data hilft Gemeinden, ihre Hochwasserdaten zu verstehen.\n\nDeine Aufgaben\n\n• Newsletter und Social Media\n• Messeauftritte planen",
    },
  },
];

// Text from buttons, job lists, dialogs and footers in the fixtures; none is part of a posting.
const NOISE = [
  "About the job",
  "See more",
  "Easy Apply",
  "Similar jobs",
  "Staff Data Engineer",
  "Alle akzeptieren",
  "Ich bin interessiert",
  "Mehr anzeigen",
  "Ähnliche Jobs",
  "Senior Data Engineer",
  "job post",
  "Jetzt bewerben",
  "Job melden",
  "Java Developer",
  "Junior Data Analyst",
  "Schnellbewerbung",
  "Merken",
  "Bewerbung senden",
  "Weitere Stellen",
  "Apply for this job",
  "Submit application",
  "Apply Now",
  "Similar Jobs",
  "HR Generalist",
  "Disponent",
  "Weitere Jobs",
  "Impressum",
  "Powered by",
];

describe("site readers on saved pages", () => {
  it.each(CASES)("$reader reads $fixture", ({ fixture: name, url, reader, fields }) => {
    expect(site(fixture(name), url)).toEqual({ reader, fields });
  });

  it.each(CASES)("$reader leaves the page's noise out of $fixture", ({ fixture: name, url }) => {
    const all = Object.values(site(fixture(name), url)?.fields ?? {}).join("\n");
    for (const noise of NOISE) expect(all).not.toContain(noise);
  });
});

describe("postings open next to a list", () => {
  // In each of these fixtures the first job card carries the detail pane's hooks with that
  // card's own job, before the pane. Without its pane, the page reads as that other job, so a
  // reader that looked past the pane would read the wrong posting.
  function withoutPane(name: string, pane: string): Document {
    const doc = fixture(name);
    doc.querySelector(pane)!.remove();
    return doc;
  }

  it("LinkedIn: reads the detail pane and links the posting from currentJobId", () => {
    const url = "https://www.linkedin.com/jobs/search/?currentJobId=4098765432&keywords=platform&origin=JOBS_HOME";
    expect(site(fixture("linkedin-search.html"), url)).toEqual({
      reader: "linkedin",
      fields: {
        url: "https://www.linkedin.com/jobs/view/4098765432/",
        title: "Site Reliability Engineer (m/w/d)",
        company: "Ostwind Mobility GmbH",
        location: "Berlin, Berlin, Germany",
        description:
          "Ostwind runs on-demand shuttles in four cities. You keep the dispatch platform up while the fleet grows.\n\nYour tasks\n\n• On-call with a team of five\n• Capacity planning for the dispatch database",
      },
    });
    expect(site(withoutPane("linkedin-search.html", ".scaffold-layout__detail"), url)?.fields).toMatchObject({
      title: "Backend Engineer (Go)",
      company: "Fernhill Games",
      location: "Berlin, Germany (Hybrid)",
    });
  });

  it("LinkedIn: takes the id from a /jobs/view/ link with a slug", () => {
    const url = "https://de.linkedin.com/jobs/view/senior-platform-engineer-at-brightmoor-4012345678";
    expect(site(fixture("linkedin-view.html"), url)?.fields.url).toBe(
      "https://www.linkedin.com/jobs/view/4012345678/",
    );
  });

  it("LinkedIn: reads a job-alert email's /comm/ link as the posting, linked without the email's tokens", () => {
    const url =
      "https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=Zm9vYmFy%3D%3D&refId=abc&lipi=urn%3Ali%3Apage%3Aemail&midToken=AQHx&midSig=0x1&trk=eml-email_job_alert_digest_01-job_card-0-view_job&trkEmail=eml-x&eid=a1b2-c3&otpToken=MTAwOTE";
    expect(site(fixture("linkedin-view.html"), url)).toEqual({ reader: "linkedin", fields: CASES[0].fields });
  });

  it("Indeed: reads the right pane and links the posting from vjk", () => {
    const url = "https://de.indeed.com/jobs?q=data+analyst&l=Hamburg&vjk=0f1e2d3c4b5a6978";
    expect(site(fixture("indeed-search.html"), url)).toEqual({
      reader: "indeed",
      fields: {
        url: "https://de.indeed.com/viewjob?jk=0f1e2d3c4b5a6978",
        title: "Data Analyst Logistik (m/w/d)",
        company: "Juniper Ridge Logistics",
        location: "Hybrides Arbeiten in 20457 Hamburg",
        description:
          "Juniper Ridge betreibt Lager in Hamburg und Bremen. Du machst unsere Kennzahlen verständlich.\n\nAufgaben\n\n• Berichte für die Lagerleitung\n• SQL-Abfragen auf unserem WMS",
      },
    });
    expect(site(withoutPane("indeed-search.html", ".jobsearch-RightPane"), url)?.fields).toMatchObject({
      title: "Junior Data Analyst (m/w/d)",
      company: "Fernhill Games",
      location: "20095 Hamburg",
    });
  });

  it("Glassdoor: reads the detail column, not the first job card", () => {
    const url = CASES[4].url;
    const fields = site(fixture("glassdoor.html"), url)?.fields;
    expect(fields?.title).toBe("Data Analyst (m/w/d)");
    expect(fields?.company).toBe("Cobaltwave");
    expect(fields?.location).toBe("Hamburg");
    expect(site(withoutPane("glassdoor.html", '[class*="TwoColumnLayout_columnRight__"]'), url)?.fields).toMatchObject({
      title: "Junior Data Analyst",
      company: "Juniper Ridge Logistics",
      location: "Bremen",
    });
  });

  describe("Glassdoor: links the open posting from jl, and keeps nothing else of the address", () => {
    const search = "https://www.glassdoor.de/Job/hamburg-data-analyst-jobs-SRCH_IL.0,7_IC2632180_KO8,20.htm";
    const link = (url: string) => site(fixture("glassdoor.html"), url)?.fields.url;

    it("on a search page, one link per posting", () => {
      const first = link(`${search}?jl=1009876543210&src=GD_JOB_AD&ao=1136043&t=SR#top`);
      const second = link(`${search}?src=GD_JOB_AD&jl=1009111111111`);
      expect(first).toBe(`${search}?jl=1009876543210`);
      expect(second).toBe(`${search}?jl=1009111111111`);
      expect(first).not.toBe(second);
    });

    it("on a posting's own page", () => {
      const listing = "https://www.glassdoor.co.uk/job-listing/data-analyst-cobaltwave-JV_IC2671300_KO0,12_KE13,23.htm";
      expect(link(`${listing}?jl=1009876543210&pos=101&ao=1110586&s=58&guid=00000192&cs=1_abc&cb=1&jrtk=5-yul1`)).toBe(
        `${listing}?jl=1009876543210`,
      );
    });

    it("not when jl is missing or not all digits", () => {
      expect(link(search)).toBeUndefined();
      expect(link(`${search}?jl=`)).toBeUndefined();
      expect(link(`${search}?jl=10098x76543210`)).toBeUndefined();
      expect(link(`${search}?jl=-1009876543210`)).toBeUndefined();
    });
  });
});

describe("earlier layouts", () => {
  it("LinkedIn's signed-out page", () => {
    const doc = page(`
      <section class="top-card-layout">
        <h1 class="top-card-layout__title topcard__title">Warehouse Planner</h1>
        <h4 class="top-card-layout__second-subline">
          <span class="topcard__flavor"><a class="topcard__org-name-link" href="https://www.linkedin.com/company/x">Kestrel Freight AG</a></span>
          <span class="topcard__flavor topcard__flavor--bullet">Bremen, Bremen, Germany</span>
        </h4>
      </section>
      <div class="show-more-less-html__markup">Plan the warehouse.<br>Every day.</div>
      <button class="show-more-less-html__button">Show more</button>`);
    expect(site(doc, "https://www.linkedin.com/jobs/view/warehouse-planner-at-kestrel-4055555555")).toEqual({
      reader: "linkedin",
      fields: {
        url: "https://www.linkedin.com/jobs/view/4055555555/",
        title: "Warehouse Planner",
        company: "Kestrel Freight AG",
        location: "Bremen, Bremen, Germany",
        description: "Plan the warehouse.\nEvery day.",
      },
    });
  });

  it("Glassdoor's older markup, with the rating inside the employer's name", () => {
    const doc = page(`
      <div id="JDCol">
        <div data-test="employerName">Fernhill Games<span class="rating">4.3 ★</span></div>
        <div data-test="jobTitle">Level Designer</div>
        <div data-test="location">Hamburg</div>
        <div id="JobDescriptionContainer"><div class="jobDescriptionContent">Design levels.</div></div>
      </div>`);
    expect(site(doc, "https://www.glassdoor.co.uk/job-listing/level-designer-JV.htm?jl=1009000000001")).toEqual({
      reader: "glassdoor",
      fields: {
        url: "https://www.glassdoor.co.uk/job-listing/level-designer-JV.htm?jl=1009000000001",
        title: "Level Designer",
        company: "Fernhill Games",
        location: "Hamburg",
        description: "Design levels.",
      },
    });
  });

  it("Glassdoor keeps a number that is part of the employer's name", () => {
    const doc = page('<div data-test="employerName">Studio 3</div>');
    expect(site(doc, "https://www.glassdoor.com/job-listing/x.htm?jl=1")?.fields.company).toBe("Studio 3");
  });
});

describe("which reader a page gets", () => {
  it.each([
    ["https://www.linkedin.com/jobs/view/4012345678/", "linkedin"],
    ["https://de.linkedin.com/jobs/view/some-title-at-acme-4012345678", "linkedin"],
    ["https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4012345678", "linkedin"],
    ["https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc&midToken=AQ&otpToken=MTA&lipi=urn&eid=x", "linkedin"],
    ["https://www.linkedin.com/comm/jobs/view/4012345678", "linkedin"],
    ["https://www.linkedin.com/comm/feed/", "generic"],
    ["https://www.linkedin.com/communities/jobs/view/4012345678/", "generic"],
    ["https://www.linkedin.com/x/comm/jobs/view/4012345678/", "generic"],
    ["https://www.linkedin.com/feed/", "generic"],
    ["https://www.linkedin.com/jobs/search/?keywords=engineer", "generic"],
    ["https://www.linkedin.com/jobs/search/?currentJobId=abc", "generic"],
    ["https://www.stepstone.de/stellenangebote--x--1-inline.html", "stepstone"],
    ["https://www.stepstone.at/stellenangebote--x--1-inline.html", "stepstone"],
    ["https://www.stepstone.be/emplois--x--1-inline.html", "stepstone"],
    ["https://stepstone.nl/vacatures--x--1-inline.html", "stepstone"],
    ["https://de.indeed.com/viewjob?jk=a1b2c3d4e5f60718", "indeed"],
    ["https://www.indeed.com/m/viewjob?jk=a1b2c3d4e5f60718", "indeed"],
    ["https://uk.indeed.com/jobs?q=x&vjk=a1b2c3d4e5f60718", "indeed"],
    ["https://de.indeed.com/jobs?q=x", "generic"],
    ["https://de.indeed.com/viewjob?jk=not%20a%20key", "generic"],
    ["https://www.xing.com/jobs/berlin-backend-engineer-123456789", "xing"],
    ["https://www.xing.com/profile/Someone_Invented", "generic"],
    ["https://www.glassdoor.de/job-listing/x.htm?jl=1", "glassdoor"],
    ["https://www.glassdoor.com.au/job-listing/x.htm?jl=1", "glassdoor"],
    ["https://www.glassdoor.de/Job/hamburg-data-analyst-jobs-SRCH_IL.0,7_IC2632180_KO8,20.htm?jl=1", "glassdoor"],
    ["https://www.arbeitsagentur.de/jobsuche/jobdetail/10000-1198765432-S", "arbeitsagentur"],
    ["https://www.arbeitsagentur.de/jobsuche/suche?was=Java", "generic"],
    ["https://acme.jobs.personio.de/job/123456?language=de", "personio"],
    ["https://acme.jobs.personio.com/job/123456", "personio"],
    ["https://acme.jobs.personio.de/", "generic"],
    ["https://boards.greenhouse.io/acme/jobs/123", "greenhouse"],
    ["https://job-boards.greenhouse.io/acme/jobs/123", "greenhouse"],
    ["https://job-boards.eu.greenhouse.io/acme/jobs/123", "greenhouse"],
    ["https://jobs.lever.co/acme/3f6c1d2e-0000-4000-8000-00000000abcd", "lever"],
    ["https://jobs.eu.lever.co/acme/3f6c1d2e-0000-4000-8000-00000000abcd", "lever"],
    ["https://acme.wd3.myworkdayjobs.com/en-US/External/job/Berlin/X_R-1", "workday"],
    ["https://wd5.myworkdaysite.com/recruiting/acme/External/job/Berlin/X_R-1", "workday"],
    ["https://jobs.smartrecruiters.com/Acme/744000000000001-x", "smartrecruiters"],
    ["https://join.com/companies/acme/10203040-junior-engineer", "join"],
    ["https://join.com/companies/acme", "generic"],
    ["https://careers.example.com/jobs/123", "generic"],
  ])("%s -> %s", (url, reader) => {
    expect(readerFor(new URL(url)).name).toBe(reader);
  });

  it.each([
    "https://evil-linkedin.com/jobs/view/4012345678/",
    "https://linkedin.com.evil.example/jobs/view/4012345678/",
    "https://linkedin.com.evil.example/comm/jobs/view/4012345678/",
    "https://www.linkedin.com.evil.example/jobs/search/?currentJobId=4012345678",
    "https://notstepstone.de/stellenangebote--x--1-inline.html",
    "https://stepstone.de.evil.example/stellenangebote--x--1-inline.html",
    "https://evil-indeed.com/viewjob?jk=a1b2c3d4e5f60718",
    "https://de.indeed.com.evil.example/viewjob?jk=a1b2c3d4e5f60718",
    "https://xing.com.evil.example/jobs/berlin-x-123456789",
    "https://fakeglassdoor.com/job-listing/x.htm?jl=1",
    "https://arbeitsagentur.de.evil.example/jobsuche/jobdetail/1",
    "https://acme.jobs.personio.de.evil.example/job/123456",
    "https://evil-greenhouse.io/acme/jobs/123",
    "https://boards.greenhouse.io.evil.example/acme/jobs/123",
    "https://jobs.lever.co.evil.example/acme/x",
    "https://fakejobs.lever.co/acme/x",
    "https://acme.myworkdayjobs.com.evil.example/job/x",
    "https://evilmyworkdayjobs.com/job/x",
    "https://jobs.smartrecruiters.com.evil.example/Acme/1-x",
    "https://notjoin.com/companies/acme/10203040-x",
    "https://join.com.evil.example/companies/acme/10203040-x",
  ])("a look-alike host gets no site reader: %s", (url) => {
    expect(readerFor(new URL(url)).name).toBe("generic");
  });
});

describe("a site reader that finds nothing", () => {
  it("leaves site empty and does not fall back to the generic reader", () => {
    const doc = page(`<main>${"A StepStone search page, with no ad on it. ".repeat(10)}</main>`);
    const snapshot = readPage(doc, new URL("https://www.stepstone.de/jobs/developer"), "");
    expect(snapshot.site).toBeNull();
  });

  it("keeps the clean link when the page has not rendered yet", () => {
    const doc = page("<div id='app'></div>");
    expect(site(doc, "https://www.linkedin.com/jobs/view/4012345678/")).toEqual({
      reader: "linkedin",
      fields: { url: "https://www.linkedin.com/jobs/view/4012345678/" },
    });
  });
});

describe("the generic reader", () => {
  const url = "https://careers.example.com/jobs/clinical-data-manager";
  const text = (n: number) => "x".repeat(n);
  const read = (body: string) => generic.read(page(body), new URL(url));

  it("reads a career site's main content as the description, without its header and footer", () => {
    expect(site(fixture("generic.html"), url)).toEqual({
      reader: "generic",
      fields: {
        description: [
          "Clinical Data Manager",
          "",
          "Munich · Full-time",
          "",
          "Vellum Health builds an app that helps patients recover after surgery. Our clinical team runs studies with eight hospitals, and we need someone to keep their data clean and on time.",
          "",
          "What you will do",
          "",
          "• Set up data capture for new studies",
          "• Check incoming data and chase queries with study sites",
          "",
          "What you bring",
          "",
          "• Three years in clinical data management",
        ].join("\n"),
      },
    });
  });

  it("takes 200 to 100,000 characters, and nothing shorter or longer", () => {
    expect(read(`<main>${text(199)}</main>`)).toBeNull();
    expect(read(`<main>${text(200)}</main>`)).toEqual({ description: text(200) });
    expect(read(`<main>${text(100_000)}</main>`)).toEqual({ description: text(100_000) });
    expect(read(`<main>${text(100_001)}</main>`)).toBeNull();
  });

  it("falls back to [role=main], then to the page's one article", () => {
    expect(read(`<div role="main">${text(300)}</div>`)).toEqual({ description: text(300) });
    expect(read(`<nav>Menu</nav><article>${text(300)}</article>`)).toEqual({ description: text(300) });
    expect(read(`<main>short</main><article>${text(300)}</article>`)).toEqual({
      description: text(300),
    });
  });

  it("reads nothing from several articles or a page without main content", () => {
    expect(read(`<article>${text(300)}</article><article>${text(300)}</article>`)).toBeNull();
    expect(read(`<div>${text(300)}</div>`)).toBeNull();
  });

  it("tries each element once, even when it is both <main> and [role=main]", () => {
    const doc = page(`<main role="main"><article>${text(50)}</article></main>`);
    expect(mainCandidates(doc).map((el) => el.localName)).toEqual(["main", "article"]);
    expect(mainCandidates(page(`<main role="main">${text(50)}</main>`))).toHaveLength(1);
  });

  it("reads a long page quickly, and stops at the cap on a huge one", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `<div>line ${i}</div>`).join("");
    const long = page(`<main role="main">${lines(9_000)}</main>`);
    let start = performance.now();
    expect(generic.read(long, new URL(url))?.description?.startsWith("line 0\nline 1\n")).toBe(true);
    const longMs = performance.now() - start;

    const huge = page(`<main role="main">${lines(100_000)}</main>`);
    start = performance.now();
    expect(generic.read(huge, new URL(url))).toBeNull(); // over 100,000 characters
    const hugeMs = performance.now() - start;
    console.info(`generic: 9,000 lines ${longMs.toFixed(1)} ms, 100,000 lines ${hugeMs.toFixed(1)} ms`);
    expect(longMs).toBeLessThan(1_000);
    expect(hugeMs).toBeLessThan(1_000);
  });

  it("fills nothing but the description", () => {
    const fields = site(fixture("generic.html"), url)?.fields;
    expect(Object.keys(fields ?? {})).toEqual(["description"]);
  });
});
