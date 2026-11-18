import { describe, expect, it } from "vitest";
import { classifyEmail, classifyMail } from "@/lib/inbox/pipeline/classify";
import type { MailInput } from "@/lib/inbox/pipeline/types";
import type { Job, Status } from "@/lib/types";
import { buildSeed } from "../../../db/seed/fixtures";
import { daysAgo, FIXTURE_JOBS, RULES_NOW } from "../../fixtures/rules/jobs";
import { RULE_FIXTURES } from "../../fixtures/rules/mail";
import { classify, context, effectOf, RULES } from "./support";

// Step 2.1: each rule that replaced a mock behaviour (docs/plan/2-gmail-ingest.md, "The rules"),
// in its own block. The fixtures are in tests/fixtures/rules.

const fixture = (key: string) => {
  const found = RULE_FIXTURES.find((f) => f.key === key);
  if (!found) throw new Error(`no fixture ${key}`);
  return found;
};
const run = (key: string) => classify(fixture(key).mail, fixture(key).context);

const mail = (m: Partial<MailInput>): MailInput => ({
  fromName: "",
  fromAddress: "someone@gmail.example",
  subject: "",
  body: "",
  receivedAt: RULES_NOW,
  ...m,
});

const jobById = (id: string) => FIXTURE_JOBS.find((j) => j.id === id)!;

/** A copy of a fixture job with other fields. */
const withJob = (id: string, patch: Partial<Job>) => FIXTURE_JOBS.map((j) => (j.id === id ? { ...j, ...patch } : j));

describe("relatedness: strong evidence, or two kinds of weak evidence", () => {
  it("takes any one strong item", () => {
    // Each mail carries exactly one piece of evidence.
    expect(classify(mail({ subject: "Hello" }), { threadJobId: "job_lindenhof" }).evidence).toEqual(["thread"]);
    expect(classify(mail({ subject: "Hello" }), { senderJobIds: ["job_lindenhof"] }).evidence).toEqual([
      "sender_history",
    ]);
    expect(classify(mail({ fromAddress: "hello@lindenhof-logistics.example", subject: "Hello" })).evidence).toEqual([
      "sender_domain",
    ]);
    expect(classify(mail({ fromAddress: "no-reply@hire.lever.example", subject: "Hello" })).evidence).toEqual([
      "ats_sender",
    ]);
    // An "applied" phrase is strong next to a hint word, which most carry in themselves.
    expect(classify(mail({ subject: "Vielen Dank für Ihre Bewerbung" })).evidence).toEqual(["applied_phrase", "hint"]);
    // Alone ("Eingangsbestätigung" is what an insurer writes too) it is one weak keyword.
    expect(classify(mail({ subject: "Eingangsbestätigung" }))).toMatchObject({ related: false, evidence: ["keyword"] });
    expect(classify(mail({ subject: "Eingangsbestätigung", body: "Ihre Anfrage ist bei uns eingegangen." })).related).toBe(false);
    expect(classify(mail({ subject: "Eingangsbestätigung Ihrer Bewerbung" })).evidence).toEqual(["applied_phrase", "hint"]);
    expect(classify(mail({ subject: "Hello" }), { threadJobId: "job_lindenhof" }).related).toBe(true);
  });

  it("needs two kinds of weak items: one, or two of the same kind, are not enough", () => {
    const one = [
      mail({ subject: "Wir können deine Bestellung nicht berücksichtigen" }), // keyword
      mail({ subject: "Eingangsbestätigung" }), // an "applied" keyword without a hint word
      mail({ subject: "Your position in the queue" }), // hint
      mail({ subject: "Lindenhof Logistics opens a new warehouse" }), // company named
      mail({ fromAddress: "news@linkedin.example", subject: "Your weekly digest" }), // job board
      mail({ subject: "Check our availability", body: "Unfortunately the beta is full." }), // two keywords
    ];
    for (const m of one) expect(classify(m)).toMatchObject({ related: false, outcome: "ignored" });

    const two = classify(mail({ subject: "Lindenhof Logistics", body: "Please share your availability." }));
    expect(two).toMatchObject({ related: true, evidence: ["keyword", "company_named"] });
    expect(run("en-two-kinds-of-weak")).toMatchObject({ related: true, evidence: ["keyword", "hint"] });
  });

  it("drops the mock's false positives: single words in unrelated mail", () => {
    const noise = [
      "en-noise-availability",
      "en-noise-substring-hint",
      "de-noise-leider",
      "de-noise-substring-hint",
      "de-noise-newsletter",
    ];
    for (const key of noise) {
      expect(run(key), key).toMatchObject({ related: false, outcome: "ignored", candidates: [] });
    }
  });

  it("counts hints only as whole words", () => {
    expect(classify(mail({ subject: "Your composition", body: "Check our availability" })).related).toBe(false);
    expect(classify(mail({ subject: "Your position", body: "Check our availability" }))).toMatchObject({
      related: true,
      evidence: ["keyword", "hint"],
    });
  });

  it("lets bulk-mail headers cancel one weak item, never a strong one", () => {
    // The alert itself is a job board's advertising (noise.ts): ignored whatever its headers.
    const advert = fixture("en-board-alert").mail;
    expect(classify(advert)).toMatchObject({ related: false, evidence: ["hint", "board_sender", "bulk", "job_advert"] });
    expect(classify({ ...advert, bulk: undefined })).toMatchObject({ related: false, outcome: "ignored" });
    // The same sender without advertising phrases: the bulk headers decide.
    const alert = { ...advert, subject: "Frontend Engineer", body: "A position matches your profile: Frontend Engineer at Bluefin Studio." };
    expect(classify(alert)).toMatchObject({ related: false, evidence: ["hint", "board_sender", "bulk"] });
    expect(classify({ ...alert, bulk: undefined })).toMatchObject({ related: true, evidence: ["hint", "board_sender"] });
    for (const bulk of [
      { listUnsubscribe: true, listId: null, precedence: null },
      { listUnsubscribe: false, listId: "<jobs.list.example>", precedence: null },
      { listUnsubscribe: false, listId: null, precedence: " Bulk " },
    ]) {
      expect(classify({ ...alert, bulk }).related).toBe(false);
    }
    expect(classify({ ...alert, bulk: { listUnsubscribe: false, listId: " ", precedence: "first-class" } }).related).toBe(
      true,
    );
    const confirmation = fixture("en-confirm-new-via-ats").mail;
    const bulkConfirmation = classify({ ...confirmation, bulk: fixture("en-board-alert").mail.bulk });
    expect(bulkConfirmation).toMatchObject({ related: true, evidence: ["ats_sender", "applied_phrase", "hint", "bulk"] });
    expect(bulkConfirmation.effect).toEqual(classify(confirmation).effect);
  });
});

describe("matching: registrable domains", () => {
  const invite = (fromAddress: string, extra: Partial<MailInput> = {}) =>
    mail({ fromAddress, subject: "Interview", body: "Please share your availability.", ...extra });

  it("compares the domain under its public suffix, so subdomains match", () => {
    expect(effectOf(classify(invite("hr@mail.lindenhof-logistics.example")))).toBe(
      "link Lindenhof Logistics | Frontend Engineer: applied -> interview",
    );
  });

  it("never matches a personal mail host, even when a company has its name", () => {
    // The mock read "live" in "Live Arena" and matched.
    const jobs = [...FIXTURE_JOBS, { ...jobById("job_lindenhof"), id: "job_live", company: "Live Arena", url: null }];
    const result = classify(invite("someone@live.example"), { jobs });
    expect(result).toMatchObject({ related: false, candidates: [] });
  });

  it("never matches a recruiting platform's domain to the job posted on it", () => {
    // Quokka's posting is on Greenhouse; mail from Greenhouse says nothing about which employer.
    const result = classify(invite("no-reply@greenhouse.example"));
    expect(result.evidence).toEqual(["ats_sender", "keyword"]);
    expect(result.candidates).toEqual([]);
  });

  it("drops legal forms, and reads German letters as domains spell them", () => {
    expect(effectOf(classify(invite("jobs@sternwarte-software.example")))).toBe(
      "link Sternwarte Software GmbH | Softwareentwickler Backend: applied -> interview",
    );
    const jobs = withJob("job_brueckenwerk", { url: null });
    expect(effectOf(classify(invite("jobs@brueckenwerk.example"), { jobs }), jobs)).toBe(
      "link Brückenwerk AG | Werkstudent Frontend: interview -> interview",
    );
  });

  it("matches the domain of the job's posting when the company's name starts with it", () => {
    // Not "Group": that is a group word, matched without the posting (owner, D2).
    const jobs = withJob("job_lindenhof", { company: "Lindenhof Logistics Partners" });
    expect(effectOf(classify(invite("talent@lindenhof-logistics.example"), { jobs }), jobs)).toBe(
      "link Lindenhof Logistics Partners | Frontend Engineer: applied -> interview",
    );
    const noPosting = jobs.map((j) => (j.id === "job_lindenhof" ? { ...j, url: null } : j));
    expect(classify(invite("talent@lindenhof-logistics.example"), { jobs: noPosting }).related).toBe(false);
    // Not otherwise, even for an acronym: the host may be an aggregator's (review of 2.1, finding 3).
    const acronym = withJob("job_lindenhof", { company: "LHL" });
    expect(classify(invite("talent@lindenhof-logistics.example"), { jobs: acronym }).related).toBe(false);
  });

  it("matches the Reply-To domain as well", () => {
    const viaPlatform = invite("no-reply@greenhouse-mail.example", { replyToAddress: "talent@quokkalabs.example" });
    expect(classify(viaPlatform)).toMatchObject({ evidence: ["sender_domain", "ats_sender", "keyword"] });
    expect(effectOf(classify(viaPlatform))).toBe("link Quokka Labs | Platform Engineer: interview -> interview");
  });

  it("calls a lead of exactly 15 points a match, and less a tie", () => {
    const template = jobById("job_lindenhof");
    const jobs = [
      { ...template, id: "job_a", company: "Acme", title: "Data Engineer", url: null },
      { ...template, id: "job_b", company: "Birchwood", title: "Platform Engineer", url: null },
    ];
    // Acme: domain 60 + title 25 = 85. Birchwood: sender history 35 + company named 35 = 70.
    const m = invite("jobs@acme.example", { body: "About the Data Engineer opening (Birchwood sent us your profile)." });
    expect(effectOf(classify(m, { jobs, senderJobIds: ["job_b"] }), jobs)).toBe("link Acme | Data Engineer: applied -> interview");
    // Birchwood's title too: 95 against 85.
    const both = { ...m, body: `${m.body} You applied as Platform Engineer there.` };
    expect(classify(both, { jobs, senderJobIds: ["job_b"] }).reviewReason).toBe("ambiguous_job");
  });

  it("does not match on a title alone", () => {
    // The mock moved Tidewater Games (Saved) to Interview on "Web Developer".
    const result = run("en-title-only");
    expect(result.candidates.map((j) => j.id)).toEqual(["job_tidewater"]);
    expect(effectOf(result)).toBe("review unknown_job [] interview");
    // Two jobs with the same title still tie, and go to review as such.
    const both = classify(
      mail({
        fromAddress: "x@brightpath-staffing.example",
        subject: "Frontend Engineer interview",
        body: "A new role for you? Your availability?",
      }),
    );
    expect(effectOf(both)).toBe(
      "review ambiguous_job [Lindenhof Logistics | Frontend Engineer, Orchard Bank | Frontend Engineer] interview",
    );
  });
});

describe("matching: this sender was linked to the job before", () => {
  it("matches a job through the sender's address", () => {
    expect(run("en-sender-history")).toMatchObject({ evidence: ["sender_history", "keyword"], outcome: "matched" });
    expect(effectOf(run("en-sender-history"))).toBe("link Orchard Bank | Frontend Engineer: applied -> interview");
  });

  it("breaks a tie between two jobs at one company", () => {
    const m = fixture("en-two-jobs-one-company").mail;
    expect(classify(m).reviewReason).toBe("ambiguous_job");
    expect(effectOf(classify(m, { senderJobIds: ["job_orchard_mobile"] }))).toBe(
      "link Orchard Bank | Mobile Engineer: applied -> interview",
    );
  });

  it("ties when the sender writes about another job at the same company, naming its title", () => {
    const m = { ...fixture("en-two-jobs-title-named").mail };
    expect(classify(m, { senderJobIds: ["job_orchard_web"] }).reviewReason).toBe("ambiguous_job");
  });

  it("ties when the sender's old job and a newly named company are close", () => {
    // History (40) against a company named in the text (35): review, not a guess.
    const m = mail({ subject: "Interview at Kestrel Analytics?", body: "Your availability?" });
    expect(classify(m, { senderJobIds: ["job_orchard_web"] }).reviewReason).toBe("ambiguous_job");
  });

  it("ignores jobs that are gone", () => {
    expect(classify(mail({ subject: "Hello" }), { senderJobIds: ["job_deleted"] }).related).toBe(false);
  });
});

describe("matching: a reply in a linked thread goes to that job", () => {
  it("links to the thread's job, whatever scores higher", () => {
    // The sender's domain is another job's company.
    const m = mail({
      fromAddress: "talent@orchardbank.example",
      subject: "Re: Next steps",
      body: "Unfortunately we decided to pursue other candidates.",
    });
    const result = classify(m, { threadJobId: "job_lindenhof" });
    expect(result.candidates[0].id).toBe("job_lindenhof");
    expect(effectOf(result)).toBe("link Lindenhof Logistics | Frontend Engineer: applied -> rejected");
  });

  it("links a reply without keywords and keeps the status", () => {
    expect(effectOf(run("en-thread-reply-no-keyword"))).toBe("link Quokka Labs | Platform Engineer: interview -> interview");
    // Without the thread, the same mail is not even job related.
    expect(classify(fixture("en-thread-reply-no-keyword").mail).outcome).toBe("ignored");
  });

  it("applies the reply's keywords to the thread's job", () => {
    expect(effectOf(run("en-thread-reply-offer"))).toBe("link Quokka Labs | Platform Engineer: interview -> offer");
  });

  it("still sends conflicting keywords to review", () => {
    const m = mail({ subject: "Re: Next steps", body: "Unfortunately the interview has to move." });
    expect(classify(m, { threadJobId: "job_quokka" })).toMatchObject({
      reviewReason: "conflicting_keywords",
      candidates: [expect.objectContaining({ id: "job_quokka" })],
    });
  });

  it("suggests the side with more phrases, and the earlier stage on a tie", () => {
    // Found in the owner's inbox on 2026-11-17: a rejection that, politely, cannot "kennenlernen"
    // every applicant was suggested as an interview ("leider", "absage" and "kennenlernen" were
    // keywords then). The phrases are narrower now; the rule is the same.
    const rejection = mail({
      subject: "Re: Ihre Bewerbung",
      body: "Wir müssen Ihnen eine Absage erteilen und haben uns für andere Kandidaten entschieden. Ein Vorstellungsgespräch können wir nicht anbieten.",
    });
    expect(classify(rejection, { threadJobId: "job_quokka" })).toMatchObject({
      status: "rejected",
      reviewReason: "conflicting_keywords",
      effect: { kind: "review", suggestedStatus: "rejected" },
    });
    const tie = mail({ subject: "Re: Next steps", body: "Keine Sorge, das ist keine Absage: Ihr Vorstellungsgespräch findet statt." });
    expect(classify(tie, { threadJobId: "job_quokka" })).toMatchObject({
      status: "interview",
      reviewReason: "conflicting_keywords",
      effect: { kind: "review", suggestedStatus: "interview" },
    });
  });

  it("ignores a thread whose job is gone", () => {
    expect(classify(mail({ subject: "Re: Next steps" }), { threadJobId: "job_deleted" }).related).toBe(false);
  });
});

describe("closed jobs (offer, rejected) are candidates", () => {
  it("links mail that keeps a closed job's status", () => {
    expect(effectOf(run("en-closed-same-status"))).toBe("link Kestrel Analytics | Data Engineer: rejected -> rejected");
  });

  it("sends mail that would change a closed job to review", () => {
    expect(run("en-closed-offer-rejection")).toMatchObject({ outcome: "review", reviewReason: "status_mismatch" });
    const invite = mail({ fromAddress: "jobs@kestrel-analytics.example", subject: "Interview", body: "Your availability?" });
    expect(effectOf(classify(invite))).toBe("review status_mismatch [Kestrel Analytics | Data Engineer] interview");
  });

  it("counts no_response and saved as open", () => {
    expect(effectOf(run("en-no-response-reply"))).toBe("link Copperleaf | UI Developer: no_response -> interview");
    const invite = mail({ fromAddress: "jobs@tidewatergames.example", subject: "Interview", body: "Your availability?" });
    expect(effectOf(classify(invite))).toBe("link Tidewater Games | Web Developer: saved -> interview");
  });
});

describe('"applied" never moves a job backwards', () => {
  const confirmation = mail({
    fromAddress: "jobs@lindenhof-logistics.example",
    subject: "Thank you for applying",
    body: "We received your application.",
  });
  const expected: Record<Status, Status> = {
    saved: "applied",
    applied: "applied",
    interview: "interview",
    offer: "offer",
    rejected: "rejected",
    no_response: "no_response",
  };

  it.each(Object.entries(expected))("%s -> %s", (from, to) => {
    const jobs = withJob("job_lindenhof", { status: from as Status });
    expect(classify(confirmation, { jobs })).toMatchObject({
      outcome: "matched",
      status: "applied",
      effect: { kind: "link", jobId: "job_lindenhof", from, to },
    });
  });

  it("links the confirmation of a job in Interview without a change", () => {
    expect(effectOf(run("en-confirm-after-interview"))).toBe("link Quokka Labs | Platform Engineer: interview -> interview");
  });
});

describe("received time", () => {
  it("links mail older than the job's latest email-driven change, keeping the status", () => {
    // Marigold moved to Offer by email 5 days ago; this invitation is 20 days old.
    expect(effectOf(run("en-stale-invite"))).toBe("link Marigold Health | Product Designer: offer -> offer");
    // Received after that change, the same mail would reopen a closed job: review.
    const fresh = { ...fixture("en-stale-invite").mail, receivedAt: daysAgo(1) };
    expect(classify(fresh).reviewReason).toBe("status_mismatch");
  });

  it("counts only changes caused by email", () => {
    // Copperleaf became "no response" (source "time") 20 days ago; a 25-day-old invitation still applies.
    const old = { ...fixture("en-no-response-reply").mail, receivedAt: daysAgo(25) };
    expect(effectOf(classify(old))).toBe("link Copperleaf | UI Developer: no_response -> interview");
  });

  it("sends mail older than the job that would change it to review", () => {
    expect(run("en-older-than-job")).toMatchObject({ outcome: "review", reviewReason: "status_mismatch" });
    // Received after the job was added: a normal change.
    const later = { ...fixture("en-older-than-job").mail, receivedAt: daysAgo(1) };
    expect(effectOf(classify(later))).toBe("link Halvard Systems | Backend Engineer: applied -> interview");
  });

  it("links mail older than the job that keeps its status", () => {
    const confirmation = mail({
      fromAddress: "careers@halvard-systems.example",
      subject: "Thank you for applying",
      receivedAt: daysAgo(6),
    });
    expect(effectOf(classify(confirmation))).toBe("link Halvard Systems | Backend Engineer: applied -> applied");
  });

  it("treats a received time after now, or an invalid one, as now", () => {
    const m = fixture("en-older-than-job").mail;
    for (const receivedAt of [new Date(RULES_NOW.getTime() + 86_400_000), new Date(Number.NaN)]) {
      expect(effectOf(classify({ ...m, receivedAt }))).toBe("link Halvard Systems | Backend Engineer: applied -> interview");
    }
  });

  it("replays the seed's mail at its own received time as history (a first scan)", () => {
    // Classified against the seed's final state: older invitations of jobs that have moved on
    // since are linked only, where "received now" (tests/unit/classify.test.ts) sends them to review.
    const now = Date.UTC(2026, 0, 15, 12);
    const seed = buildSeed(now);
    const at = (subject: string) => {
      const email = seed.emails.find((e) => e.subject === subject)!;
      const result = classifyMail(
        { ...email, receivedAt: new Date(email.receivedAt) },
        context({ jobs: seed.jobs, now: new Date(now) }),
      );
      return effectOf(result, seed.jobs);
    };
    expect(at("Interview invitation – Software Engineer, Web Platform")).toBe(
      "link Halcyon Robotics | Software Engineer, Web Platform: offer -> offer",
    );
    expect(at("Interview – Web Engineer, Tools")).toBe("link Kinfolk Games | Web Engineer, Tools: rejected -> rejected");
    expect(at("Thank you for applying to Northwind Labs")).toBe(
      "link Northwind Labs | Senior Frontend Engineer: interview -> interview",
    );
  });
});

describe('an "applied" phrase in the subject with "interview" only in the body', () => {
  it("goes to review as conflicting keywords, suggesting applied", () => {
    // The mock moved the job to Interview.
    expect(run("en-confirm-mentions-interview")).toMatchObject({
      outcome: "review",
      status: "applied",
      reviewReason: "conflicting_keywords",
      effect: { suggestedStatus: "applied" },
    });
  });

  it("does not apply when the subject names the interview too, or the applied phrase is only in the body", () => {
    const base = fixture("en-confirm-mentions-interview").mail;
    const inSubject = { ...base, subject: "Thank you for applying – interview invitation" };
    expect(classify(inSubject)).toMatchObject({ outcome: "matched", status: "interview" });
    const inBody = { ...base, subject: "Web Developer", body: `Thank you for applying. ${base.body}` };
    expect(classify(inBody)).toMatchObject({ outcome: "matched", status: "interview" });
  });

  it("leaves a later stage than interview in the body alone", () => {
    const m = { ...fixture("en-confirm-mentions-interview").mail, body: "Unfortunately the role has been filled." };
    expect(classify(m)).toMatchObject({ status: "rejected", reviewReason: null });
  });
});

describe("a job created from a confirmation", () => {
  it("takes the company from the sender's domain (companyFromDomain) and the title from guessTitle", () => {
    expect(run("de-confirm-new").effect).toEqual({
      kind: "create",
      company: "Kranich Kaffee",
      title: "Junior Data Analyst",
      status: "applied",
    });
  });

  it("takes a platform sender's name when the text names it too (companyFromPlatformName)", () => {
    expect(run("en-confirm-new-via-ats").effect).toEqual({
      kind: "create",
      company: "Fennel & Finch",
      title: "Data Analyst",
      status: "applied",
    });
  });

  it("goes to review without a confident company or a title", () => {
    // The mock created "Workday", and "Untitled role".
    expect(effectOf(run("en-confirm-platform-name-only"))).toBe("review unknown_job [] applied");
    expect(effectOf(run("en-confirm-no-title"))).toBe("review unknown_job [] applied");
    // A company only in the sender's name (via an applicant-tracking system) that the text does
    // not name is not confident.
    const unnamed = { ...fixture("en-confirm-new-via-ats").mail, body: "Thank you for applying." };
    expect(effectOf(classify(unnamed))).toBe("review unknown_job [] applied");
    const person = { ...fixture("en-confirm-new-via-ats").mail, fromName: "Priya Raman" };
    expect(classify(person).reviewReason).toBe("unknown_job");
  });

  it("goes to review when the setting is off", () => {
    expect(classify(fixture("en-confirm-new-via-ats").mail, { createFromConfirmation: false })).toMatchObject({
      outcome: "review",
      reviewReason: "unknown_job",
    });
  });

  it("cuts the company to the column limit (200 characters)", () => {
    const long = {
      ...fixture("de-confirm-new").mail,
      fromName: `${"Ü".repeat(250)} Careers`,
      fromAddress: `jobs@${"u".repeat(250)}.example`,
    };
    const effect = classify(long).effect;
    expect(effect.kind).toBe("create");
    if (effect.kind !== "create") return;
    expect(Array.from(effect.company)).toHaveLength(200);
    expect(effect.company).toBe(effect.company.trim());
  });

  it("is not blocked by jobs that share only the title", () => {
    const m = { ...fixture("de-confirm-new").mail, subject: "Eingangsbestätigung – Frontend Engineer" };
    expect(effectOf(classify(m))).toBe("create Kranich Kaffee | Frontend Engineer");
  });
});

describe("language: hits' majority, Content-Language, stopwords, first in settings", () => {
  const de = mail({ subject: "Ihre Unterlagen", body: "Wir haben Ihre Unterlagen erhalten und melden uns bei Ihnen." });

  it("takes the majority language of the keyword hits", () => {
    const m = mail({ subject: "Vielen Dank für Ihre Bewerbung", body: "Interview? Please send your availability." });
    expect(classify(m, { languages: ["de", "en"] }).language).toBe("en");
  });

  it("breaks a tie among the tied languages only", () => {
    const tie = mail({ subject: "Interview", body: "Unser Terminvorschlag folgt, wir melden uns." });
    expect(classify(tie).matchedKeywords.map((k) => k.language)).toEqual(["en", "de"]);
    expect(classify({ ...tie, contentLanguage: "fr" }).language).toBe("de"); // not "fr": stopwords decide
    expect(classify({ ...tie, contentLanguage: "en" }).language).toBe("en");
  });

  it("uses Content-Language when there are no hits", () => {
    expect(classify({ ...de, contentLanguage: "fr" }).language).toBe("fr");
    expect(run("fr-reject-known").language).toBe("fr");
  });

  it("scores stopwords over the languages in settings", () => {
    expect(classify(de).language).toBe("de");
    expect(run("nl-invite-ats").language).toBe("nl");
    expect(classify(fixture("nl-invite-ats").mail).language).toBe("en"); // Dutch not in settings
  });

  it("falls back to the first language in settings, or none", () => {
    expect(run("es-unknown").language).toBe("en");
    expect(classify(mail({ subject: "Hallo" }), { languages: ["de", "en"] }).language).toBe("de");
    expect(classify(mail({ subject: "Hallo" }), { languages: [] }).language).toBeNull();
  });
});

describe("the lock rule (unchanged)", () => {
  it("links mail to a locked job and keeps its status", () => {
    expect(run("en-locked")).toMatchObject({ outcome: "matched", status: "rejected" });
    expect(effectOf(run("en-locked"))).toBe("link Pinecone Robotics | Embedded Engineer: interview -> interview");
  });
});

describe("the rule tester (classifyEmail)", () => {
  it("is classifyMail received now, outside any thread, from a new address", () => {
    const m = fixture("en-stale-invite").mail;
    const tester = classifyEmail(m, FIXTURE_JOBS, RULES, true, { now: RULES_NOW });
    expect(tester).toEqual(classify({ ...m, receivedAt: RULES_NOW }));
    expect(tester.reviewReason).toBe("status_mismatch");
  });

  it("defaults to a new user's languages", () => {
    const m = mail({ subject: "Hallo", body: "Bitte melden Sie sich bei uns." });
    expect(classifyEmail(m, [], RULES, true).language).toBe("de");
    expect(classifyEmail(m, [], RULES, true, { languages: ["en"] }).language).toBe("en");
  });
});
