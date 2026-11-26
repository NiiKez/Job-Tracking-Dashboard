import { describe, expect, it } from "vitest";
import { EXAMPLES } from "@/components/settings/sandbox-examples";
import { DEFAULT_RULES, DEFAULT_USER_SETTINGS } from "@/lib/domain/defaults";
import { classifyEmail } from "@/lib/inbox/pipeline/classify";
import { buildSeed, EMAILS } from "../../db/seed/fixtures";
import { loadIncoming } from "../helpers/demo-mail";
import type { ClassifyInput, ClassifyResult, Job, KeywordRule, Status } from "@/lib/types";

// Baseline for the email pipeline: what it returns for every demo email, as the rule tester runs
// it (received now, no thread, no sender history). Step 1.1 pinned the mock's behaviour here;
// step 2.1 changed the rules for real mail, and every row that changed says which rule changed
// it ("2.1: …"). Each rule has its own tests in tests/unit/pipeline/. Update a row only when a
// change is intended.

// Fixed clock: job states come from the seed's event order, so results must not depend on it.
// The mail arrives a day later than the seed's "now", after every seeded event in any time zone.
const FIXED_NOW = Date.UTC(2026, 0, 15, 12);
const RECEIVED = new Date(FIXED_NOW + 86_400_000);
const seed = buildSeed(FIXED_NOW);
const rules: KeywordRule[] = DEFAULT_RULES.map((r, i) => ({ ...r, id: `rule_${i}` }));

interface Row {
  related: ClassifyResult["related"];
  outcome: ClassifyResult["outcome"];
  status: ClassifyResult["status"];
  reviewReason: ClassifyResult["reviewReason"];
  language: string | null;
  keywords: string[];
  /** "Company | Title" of every candidate job, best first: the first is the job the email goes to. */
  candidates: string[];
}

function summarize(r: ClassifyResult): Row {
  return {
    related: r.related,
    outcome: r.outcome,
    status: r.status,
    reviewReason: r.reviewReason,
    language: r.language,
    keywords: r.matchedKeywords.map((k) => k.phrase),
    candidates: r.candidates.map((j) => `${j.company} | ${j.title}`),
  };
}

const classify = (input: ClassifyInput, ruleSet = rules, createFromConfirmation = true, jobs = seed.jobs) =>
  classifyEmail(input, jobs, ruleSet, createFromConfirmation, { now: RECEIVED });

/** The mock's queued demo emails, now fixtures/mail/ read through the Gmail parser. */
const INCOMING = await loadIncoming();

const run = (input: ClassifyInput, ruleSet = rules, createFromConfirmation = true, jobs = seed.jobs) =>
  summarize(classify(input, ruleSet, createFromConfirmation, jobs));

/** The effect in one line, jobs by company: what the inbox sync would write. */
function effectOf(r: ClassifyResult, jobs: readonly Job[] = seed.jobs) {
  const company = (id: string) => jobs.find((j) => j.id === id)?.company ?? id;
  const e = r.effect;
  switch (e.kind) {
    case "ignore":
      return "ignore";
    case "link":
      return `link ${company(e.jobId)}: ${e.from} -> ${e.to}`;
    case "create":
      return `create ${e.company} | ${e.title}`;
    case "review":
      return `review ${e.reason} [${e.suggestedJobIds.map(company).join(", ")}] ${e.suggestedStatus}`;
  }
}

/*
 * Seed emails, classified against the seed's final job state as if they arrived now. That
 * differs from the state when the email "arrived", so some rows differ from the outcome
 * recorded in the seed (e.g. the rejection of a job that is now rejected is linked only, and an
 * interview invitation for a job that is now closed goes to review). tests/unit/pipeline/
 * replays them at their own received time, as a first scan would.
 */
const SEED_EXPECTED: Record<string, Row> = {
  "northwind-confirm": {
    related: true,
    outcome: "matched",
    status: "applied",
    reviewReason: null,
    language: "en",
    keywords: ["thank you for applying", "we received your application"],
    candidates: ["Northwind Labs | Senior Frontend Engineer"],
  },
  "northwind-invite": {
    related: true,
    outcome: "matched",
    status: "interview",
    reviewReason: null,
    language: "en",
    keywords: ["interview", "availability"],
    candidates: ["Northwind Labs | Senior Frontend Engineer"],
  },
  // Nimbus Docs' title "Product Engineer" is in Lumen's "Product Engineer (React)": a far second.
  "lumen-confirm": {
    related: true,
    outcome: "matched",
    status: "applied",
    reviewReason: null,
    language: "en",
    keywords: ["we received your application"],
    candidates: ["Lumen Health | Product Engineer (React)", "Nimbus Docs | Product Engineer"],
  },
  "fernweh-invite": {
    related: true,
    outcome: "matched",
    status: "interview",
    reviewReason: null,
    language: "de",
    keywords: ["dank für ihre bewerbung", "vorstellungsgespräch", "einladung zum", "terminvorschlag"],
    candidates: ["Fernweh Mobility | Full-Stack Developer"],
  },
  // 2.1: closed jobs are candidates. Kelpie is already rejected: linked only (see EFFECTS).
  "kelpie-reject": {
    related: true,
    outcome: "matched",
    status: "rejected",
    reviewReason: null,
    language: "en",
    keywords: ["unfortunately", "other candidates"],
    candidates: ["Kelpie Analytics | Data Visualization Engineer"],
  },
  // 2.1: closed jobs are candidates, so Halcyon (Offer) is found by its domain. An interview
  // would change a closed job: review. (The mock matched Ember Finance on "Software Engineer"
  // alone; a title alone no longer matches.)
  "halcyon-invite": {
    related: true,
    outcome: "review",
    status: "interview",
    reviewReason: "status_mismatch",
    language: "en",
    keywords: ["interview", "schedule a call"],
    candidates: ["Halcyon Robotics | Software Engineer, Web Platform", "Ember Finance | Software Engineer"],
  },
  // 2.1: closed jobs are candidates; Halcyon already has the offer: linked only.
  "halcyon-offer": {
    related: true,
    outcome: "matched",
    status: "offer",
    reviewReason: null,
    language: "en",
    keywords: ["pleased to offer", "offer letter"],
    candidates: ["Halcyon Robotics | Software Engineer, Web Platform", "Ember Finance | Software Engineer"],
  },
  "tessellate-invite": {
    related: true,
    outcome: "matched",
    status: "interview",
    reviewReason: null,
    language: "en",
    keywords: ["interview", "availability"],
    candidates: ["Tessellate | Design Engineer"],
  },
  // 2.1: closed jobs are candidates (this one and the next); already rejected: linked only.
  "parcelwerk-reject": {
    related: true,
    outcome: "matched",
    status: "rejected",
    reviewReason: null,
    language: "de",
    keywords: ["andere kandidaten"],
    candidates: ["Parcelwerk GmbH | Werkstudent Softwareentwicklung"],
  },
  "cobalt-reject": {
    related: true,
    outcome: "matched",
    status: "rejected",
    reviewReason: null,
    language: "en",
    keywords: ["not moving forward"],
    candidates: ["Cobalt Insurance | Frontend Engineer (Angular)"],
  },
  "brightline-confirm": {
    related: true,
    outcome: "matched",
    status: "applied",
    reviewReason: null,
    language: "de",
    keywords: ["dank für ihre bewerbung", "bei uns eingegangen", "eingangsbestätigung"],
    candidates: ["Brightline Energy | Softwareentwickler:in Web"],
  },
  // 2.1: language order (no keyword hits: the stopwords say English).
  "nimbus-invite": {
    related: true,
    outcome: "review",
    status: null,
    reviewReason: "no_keyword",
    language: "en",
    keywords: [],
    candidates: ["Nimbus Docs | Product Engineer"],
  },
  "atlas-confirm": {
    related: true,
    outcome: "matched",
    status: "applied",
    reviewReason: null,
    language: "en",
    keywords: ["thank you for applying", "we received your application"],
    candidates: ["Atlas Freight | Full-Stack Engineer"],
  },
  // 2.1: closed jobs are candidates. Kinfolk is rejected; an interview would change it: review.
  "kinfolk-invite": {
    related: true,
    outcome: "review",
    status: "interview",
    reviewReason: "status_mismatch",
    language: "en",
    keywords: ["interview", "availability"],
    candidates: ["Kinfolk Games | Web Engineer, Tools"],
  },
  // 2.1: closed jobs are candidates, so Kinfolk is found and the reason is the keywords: interview
  // ("interviewing") and rejection phrases conflict. Three rejection phrases against one interview
  // phrase suggest "rejected" (2026-11-17; until then the earlier stage was suggested).
  "kinfolk-reject": {
    related: true,
    outcome: "review",
    status: "rejected",
    reviewReason: "conflicting_keywords",
    language: "en",
    keywords: ["interview", "unfortunately", "other candidates", "decided to pursue"],
    candidates: ["Kinfolk Games | Web Engineer, Tools"],
  },
  "ember-confirm": {
    related: true,
    outcome: "matched",
    status: "applied",
    reviewReason: null,
    language: "en",
    keywords: ["thanks for applying", "your application has been received"],
    candidates: ["Ember Finance | Software Engineer"],
  },
  // 2.1: language order, here and below wherever a row has no keyword hits.
  "newsletter-1": {
    related: false,
    outcome: "ignored",
    status: null,
    reviewReason: null,
    language: "en",
    keywords: [],
    candidates: [],
  },
  "newsletter-2": {
    related: false,
    outcome: "ignored",
    status: null,
    reviewReason: null,
    language: "de",
    keywords: [],
    candidates: [],
  },
  "review-ambiguous": {
    related: true,
    outcome: "review",
    status: null,
    reviewReason: "ambiguous_job",
    language: "en",
    keywords: [],
    candidates: ["Bramble & Co | Frontend Developer", "Juniper Learning | Frontend Developer"],
  },
  "review-unknown": {
    related: true,
    outcome: "review",
    status: "interview",
    reviewReason: "unknown_job",
    language: "de",
    keywords: ["einladung zum"],
    candidates: [],
  },
  "review-nokeyword": {
    related: true,
    outcome: "review",
    status: null,
    reviewReason: "no_keyword",
    language: "en",
    keywords: [],
    candidates: ["Lumen Health | Product Engineer (React)"],
  },
  "review-conflict": {
    related: true,
    outcome: "review",
    status: "interview",
    reviewReason: "conflicting_keywords",
    language: "en",
    keywords: ["interview", "availability", "unfortunately"],
    candidates: ["Fernweh Mobility | Full-Stack Developer"],
  },
};

/* Emails that arrive on "Check inbox now", keyed by sender name. */
const INCOMING_EXPECTED: Record<string, Row> = {
  "Ember Finance Talent": {
    related: true,
    outcome: "matched",
    status: "interview",
    reviewReason: null,
    language: "en",
    keywords: ["thanks for applying", "interview", "schedule a call", "availability"],
    candidates: ["Ember Finance | Software Engineer"],
  },
  "Brightline Energy": {
    related: true,
    outcome: "matched",
    status: "rejected",
    reviewReason: null,
    language: "de",
    keywords: ["nicht weiter berücksichtigen", "andere kandidaten"],
    candidates: ["Brightline Energy | Softwareentwickler:in Web"],
  },
  "Driftwood Audio Careers": {
    related: true,
    outcome: "created",
    status: "applied",
    reviewReason: null,
    language: "en",
    keywords: ["thank you for applying", "we received your application"],
    candidates: [],
  },
  "JobRadar": {
    related: false,
    outcome: "ignored",
    status: null,
    reviewReason: null,
    language: "en",
    keywords: [],
    candidates: [],
  },
};

/* Rule tester examples on the seed's jobs, with the rules and settings a new user starts with. */
const EXAMPLES_EXPECTED: Record<string, Row> = {
  "interview-en": {
    related: true,
    outcome: "matched",
    status: "interview",
    reviewReason: null,
    language: "en",
    keywords: ["interview", "availability"],
    candidates: ["Northwind Labs | Senior Frontend Engineer"],
  },
  "rejection-de": {
    related: true,
    outcome: "matched",
    status: "rejected",
    reviewReason: null,
    language: "de",
    keywords: ["anderen kandidaten"],
    candidates: ["Fernweh Mobility | Full-Stack Developer"],
  },
  "newsletter": {
    related: false,
    outcome: "ignored",
    status: null,
    reviewReason: null,
    language: "en",
    keywords: [],
    candidates: [],
  },
};

/*
 * New in 2.1: what the inbox sync would write for each of the emails above (jobs by company,
 * review suggestions best first, then the suggested status).
 */
const EFFECTS: Record<string, string> = {
  // 2.1: "applied" never moves a job backwards (the mock moved Interview back to Applied).
  "northwind-confirm": "link Northwind Labs: interview -> interview",
  "northwind-invite": "link Northwind Labs: interview -> interview",
  "lumen-confirm": "link Lumen Health: applied -> applied",
  "fernweh-invite": "link Fernweh Mobility: interview -> interview",
  "kelpie-reject": "link Kelpie Analytics: rejected -> rejected",
  "halcyon-invite": "review status_mismatch [Halcyon Robotics, Ember Finance] interview",
  "halcyon-offer": "link Halcyon Robotics: offer -> offer",
  "tessellate-invite": "link Tessellate: interview -> interview",
  "parcelwerk-reject": "link Parcelwerk GmbH: rejected -> rejected",
  "cobalt-reject": "link Cobalt Insurance: rejected -> rejected",
  "brightline-confirm": "link Brightline Energy: applied -> applied",
  "nimbus-invite": "review no_keyword [Nimbus Docs] null",
  "atlas-confirm": "link Atlas Freight: applied -> applied",
  "kinfolk-invite": "review status_mismatch [Kinfolk Games] interview",
  "kinfolk-reject": "review conflicting_keywords [Kinfolk Games] rejected",
  "ember-confirm": "link Ember Finance: applied -> applied",
  "newsletter-1": "ignore",
  "newsletter-2": "ignore",
  "review-ambiguous": "review ambiguous_job [Bramble & Co, Juniper Learning] null",
  "review-unknown": "review unknown_job [] interview",
  "review-nokeyword": "review no_keyword [Lumen Health] null",
  "review-conflict": "review conflicting_keywords [Fernweh Mobility] interview",
  "Ember Finance Talent": "link Ember Finance: applied -> interview",
  "Brightline Energy": "link Brightline Energy: applied -> rejected",
  "Driftwood Audio Careers": "create Driftwood Audio | Frontend Engineer",
  JobRadar: "ignore",
  "interview-en": "link Northwind Labs: interview -> interview",
  "rejection-de": "link Fernweh Mobility: interview -> rejected",
  newsletter: "ignore",
};

describe("classifyEmail on seed emails", () => {
  it("covers every seed email", () => {
    expect(Object.keys(SEED_EXPECTED)).toEqual(EMAILS.map((e) => e.key));
  });

  it.each(EMAILS.map((e) => [e.key, e] as const))("%s", (key, email) => {
    expect(run(email)).toEqual(SEED_EXPECTED[key]);
  });
});

describe("classifyEmail on incoming emails", () => {
  it("covers every incoming email", () => {
    expect(Object.keys(INCOMING_EXPECTED)).toEqual(INCOMING.map((e) => e.fromName));
  });

  it.each(INCOMING.map((e) => [e.fromName, e] as const))("%s", (key, email) => {
    expect(run(email)).toEqual(INCOMING_EXPECTED[key]);
  });

  it("sends a confirmation for an unknown job to review when auto-create is off", () => {
    const driftwood = INCOMING.find((e) => e.fromName === "Driftwood Audio Careers")!;
    expect(run(driftwood, rules, false)).toMatchObject({ outcome: "review", reviewReason: "unknown_job" });
  });
});

describe("rule tester examples", () => {
  it("covers every example", () => {
    expect(Object.keys(EXAMPLES_EXPECTED)).toEqual(EXAMPLES.map((e) => e.id));
  });

  // The rule tester uses the user's rules and createFromConfirmation setting: after the first
  // sign-in, the defaults (the seed leaves both as they are).
  it.each(EXAMPLES.map((e) => [e.id, e] as const))("%s", (id, example) => {
    expect(run(example.input, rules, DEFAULT_USER_SETTINGS.createFromConfirmation)).toEqual(
      EXAMPLES_EXPECTED[id],
    );
  });
});

describe("effects of the demo emails", () => {
  const all: Array<[string, ClassifyInput, boolean]> = [
    ...EMAILS.map((e): [string, ClassifyInput, boolean] => [e.key, e, true]),
    ...INCOMING.map((e): [string, ClassifyInput, boolean] => [e.fromName, e, true]),
    ...EXAMPLES.map((e): [string, ClassifyInput, boolean] => [e.id, e.input, DEFAULT_USER_SETTINGS.createFromConfirmation]),
  ];

  it("covers every demo email", () => {
    expect(Object.keys(EFFECTS)).toEqual(all.map(([key]) => key));
  });

  it.each(all)("%s", (key, input, createFromConfirmation) => {
    const result = classify(input, rules, createFromConfirmation);
    expect(effectOf(result)).toBe(EFFECTS[key]);
    // The outcome, reason and confidence follow from the effect.
    const outcome = { ignore: "ignored", link: "matched", create: "created", review: "review" }[result.effect.kind];
    expect(result.outcome).toBe(outcome);
    expect(result.reviewReason).toBe(result.effect.kind === "review" ? result.effect.reason : null);
    expect(result.confidence).toBe({ ignored: 0.85, matched: 0.92, created: 0.85, review: 0.5 }[result.outcome]);
  });
});

/* ----------------------------------------------------------- targeted cases */

/** A job with only what the classifier reads set meaningfully. */
function job(company: string, title: string, status: Status = "applied"): Job {
  const at = new Date(FIXED_NOW).toISOString();
  return {
    id: `job_${company}_${title}`,
    title,
    company,
    location: "",
    url: null,
    description: "",
    status,
    priority: "medium",
    statusSource: "manual",
    statusLocked: false,
    captureMethod: "paste",
    createdAt: at,
    appliedAt: null,
    updatedAt: at,
    lastActivityAt: at,
    history: [],
    emailCount: 0,
    nextInterview: null,
    offerDeadline: null,
  };
}

describe("classifyEmail rules", () => {
  const invite: ClassifyInput = {
    fromName: "Talent Team",
    fromAddress: "talent@fjordline.example.com",
    subject: "Interview – UI Engineer",
    body: "We would like to meet you. Please send us your availability.",
  };

  // 2.1: a closed job is a candidate now; tests/unit/pipeline/ covers what happens to it.
  it("still moves a job in no_response; a closed one is matched and goes to review", () => {
    expect(run(invite, rules, true, [job("Fjordline", "UI Engineer", "no_response")])).toEqual({
      related: true,
      outcome: "matched",
      status: "interview",
      reviewReason: null,
      language: "en",
      keywords: ["interview", "availability"],
      candidates: ["Fjordline | UI Engineer"],
    });
    for (const closed of ["offer", "rejected"] as const) {
      expect(run(invite, rules, true, [job("Fjordline", "UI Engineer", closed)])).toMatchObject({
        outcome: "review",
        reviewReason: "status_mismatch",
        candidates: ["Fjordline | UI Engineer"],
      });
    }
  });

  it("sends offer and rejection phrases to review, suggesting the earlier stage (rejected)", () => {
    const email: ClassifyInput = {
      fromAddress: "talent@fjordline.example.com",
      subject: "Your application",
      body: "We were pleased to offer the role internally. Unfortunately, it is no longer open.",
    };
    expect(run(email, rules, true, [job("Fjordline", "UI Engineer", "interview")])).toEqual({
      related: true,
      outcome: "review",
      status: "rejected",
      reviewReason: "conflicting_keywords",
      language: "en",
      keywords: ["pleased to offer", "unfortunately"],
      candidates: ["Fjordline | UI Engineer"],
    });
  });

  // 2.1: language order. The mock took the language of the first hit in rule order.
  it("takes the majority language of the hits, not the first hit in rule order or the text order", () => {
    const jobs = [job("Fjordline", "UI Engineer", "applied")];
    const mostlyEnglish: ClassifyInput = {
      fromAddress: "talent@fjordline.example.com",
      subject: "Next steps",
      body: "Vielen Dank für Ihre Bewerbung! We would like to invite you to an interview. Please share your availability.",
    };
    expect(run(mostlyEnglish, rules, true, jobs)).toMatchObject({
      status: "interview",
      language: "en",
      keywords: ["dank für ihre bewerbung", "interview", "availability"],
    });
    const germanFirst: ClassifyInput = {
      fromAddress: "talent@fjordline.example.com",
      subject: "Ihre Bewerbung",
      body: "Leider müssen wir Ihnen eine Absage erteilen. Unfortunately the role is filled.",
    };
    expect(run(germanFirst, rules, true, jobs)).toMatchObject({
      status: "rejected",
      language: "de",
      keywords: ["unfortunately", "eine absage"],
    });
  });

  describe("tie threshold (0.15)", () => {
    // Scores: sender domain 0.6, company name in the text 0.35, title in the text 0.25 (match.ts
    // counts points: 60, 35, 25). 2.1: no longer capped at 1.
    it("calls candidates 0.1 apart a tie (company 0.35 vs title 0.25)", () => {
      const email: ClassifyInput = {
        fromAddress: "jobs@mail.example.com",
        subject: "Interview",
        body: "Thanks for your application at Acme for the Platform Engineer position.",
      };
      const jobs = [job("Birchwood", "Platform Engineer"), job("Acme", "Data Engineer")];
      expect(run(email, rules, true, jobs)).toEqual({
        related: true,
        outcome: "review",
        status: "interview",
        reviewReason: "ambiguous_job",
        language: "en",
        keywords: ["interview"],
        candidates: ["Acme | Data Engineer", "Birchwood | Platform Engineer"],
      });
    });

    it("matches the top candidate 0.25 ahead (domain 0.6 vs company 0.35)", () => {
      const email: ClassifyInput = {
        fromAddress: "jobs@acme.example.com",
        subject: "Interview",
        body: "Birchwood passed your profile on to us. Can we schedule a call?",
      };
      const jobs = [job("Birchwood", "Platform Engineer"), job("Acme", "Data Engineer")];
      expect(run(email, rules, true, jobs)).toEqual({
        related: true,
        outcome: "matched",
        status: "interview",
        reviewReason: null,
        language: "en",
        keywords: ["interview", "schedule a call"],
        candidates: ["Acme | Data Engineer", "Birchwood | Platform Engineer"],
      });
    });

    // 2.1: the mock capped the score at 1 and called this a tie (1 vs 0.95), so a named title
    // could never tell two jobs at one company apart.
    // review: domain keys are compared whole, so "acmelabs" no longer stands for Acme; "acme-labs"
    // stands for both (Acme, Acme Labs), which keeps this case.
    it("matches a full match ahead of a domain + company match (1.2 vs 0.95)", () => {
      const email: ClassifyInput = {
        fromAddress: "jobs@acme-labs.example.com",
        subject: "Interview",
        body: "We would like to talk about the Frontend Engineer role at Acme Labs.",
      };
      const jobs = [job("Acme", "Data Engineer"), job("Acme Labs", "Frontend Engineer")];
      expect(run(email, rules, true, jobs)).toMatchObject({
        outcome: "matched",
        reviewReason: null,
        candidates: ["Acme Labs | Frontend Engineer", "Acme | Data Engineer"],
      });
    });

    // 2.1: without the cap this is 1.2 vs 0.85, no longer the boundary; tests/unit/pipeline/rules.test.ts
    // has a lead of exactly 15 points. The mock used "Acme GmbH", which is named now ("Acme").
    // review: 1.2 vs 0.25: "acmelabs" no longer contains Acme Lab's domain (keys are compared
    // whole), so only Acme Lab's title counts.
    it("matches the top candidate when only it is named (1.2 vs 0.25)", () => {
      // Only "Acme Labs" is in the sender domain and named in the text, as whole words.
      const email: ClassifyInput = {
        fromAddress: "jobs@acmelabs.example.com",
        subject: "Interview",
        body: "We would like to talk about the Frontend Engineer role at Acme Labs.",
      };
      const jobs = [job("Acme Lab", "Engineer"), job("Acme Labs", "Frontend Engineer")];
      expect(run(email, rules, true, jobs)).toMatchObject({
        outcome: "matched",
        reviewReason: null,
        candidates: ["Acme Labs | Frontend Engineer", "Acme Lab | Engineer"],
      });
    });
  });
});
