import { describe, expect, it } from "vitest";
import { classifyMail } from "@/lib/inbox/pipeline/classify";
import { guessCompany, guessTitle, platformOf, urlCore } from "@/lib/inbox/pipeline/extract";
import type { MailInput, PipelineContext } from "@/lib/inbox/pipeline/types";
import type { Job, Status } from "@/lib/types";
import { RULES_NOW } from "../../fixtures/rules/jobs";
import { effectOf, RULES } from "./support";

// Findings of the review of step 2.1, one block each, with the reviewer's input. Each input
// misled the rules before the fix: the comment above it says what happened.

const DAY = 86_400_000;
const ago = (days: number) => new Date(RULES_NOW.getTime() - days * DAY).toISOString();

/** A job added 30 days ago (by the extension), now in `status`. */
function job(id: string, company: string, title: string, status: Status, patch: Partial<Job> = {}): Job {
  return {
    id,
    company,
    title,
    location: "",
    url: null,
    description: "",
    status,
    statusSource: "extension",
    statusLocked: false,
    captureMethod: "extension",
    createdAt: ago(30),
    appliedAt: ago(30),
    updatedAt: ago(30),
    lastActivityAt: ago(30),
    history: [{ id: `${id}_ev0`, from: null, to: status, at: ago(30), source: "extension" }],
    emailCount: 0,
    nextInterview: null,
    offerDeadline: null,
    ...patch,
  };
}

const ctx = (jobs: Job[], extra: Partial<PipelineContext> = {}): PipelineContext => ({
  jobs,
  rules: RULES,
  createFromConfirmation: true,
  languages: ["en", "de"],
  threadJobId: null,
  senderJobIds: [],
  now: RULES_NOW,
  ...extra,
});

/** Received an hour before the fixtures' clock. */
const mail = (m: Partial<MailInput>): MailInput => ({
  fromName: "",
  fromAddress: "",
  subject: "",
  body: "",
  receivedAt: new Date(RULES_NOW.getTime() - 3_600_000),
  ...m,
});

const run = (m: MailInput, jobs: Job[], extra: Partial<PipelineContext> = {}) => {
  const result = classifyMail(m, ctx(jobs, extra));
  return { result, effect: effectOf(result, jobs) };
};

const BULK = { listUnsubscribe: true, listId: null, precedence: "bulk" };

describe("review 1: sender history from a shared platform address", () => {
  // Every employer on Lever writes from no-reply@hire.lever.co: the old rules linked Beta's mail
  // to Acme (history), and Beta's rejection moved Acme to Rejected.
  const acme = job("acme", "Acme", "Backend Engineer", "applied");
  const history = { senderJobIds: ["acme"] };

  it("does not link another employer's confirmation to the job the address was linked to", () => {
    const { result, effect } = run(
      mail({
        fromName: "Beta Careers",
        fromAddress: "no-reply@hire.lever.co",
        subject: "Thank you for applying to Beta – Data Analyst",
        body: "Thank you for applying for the Data Analyst position at Beta.",
      }),
      [acme],
      history,
    );
    expect(result.evidence).not.toContain("sender_history");
    // Beta's own job: the platform sender's name, named in the text too (owner, D3).
    expect(effect).toBe("create Beta | Data Analyst");
  });

  it("does not move that job on another employer's rejection", () => {
    const { result, effect } = run(
      mail({
        fromName: "Beta",
        fromAddress: "no-reply@hire.lever.co",
        subject: "Your application",
        body: "Unfortunately we have decided not to move forward with your application.",
      }),
      [acme],
      history,
    );
    expect(result.evidence).toEqual(["ats_sender", "keyword", "hint"]);
    expect(effect).toBe("review unknown_job [] rejected");
  });

  it("still counts the history of an address that is not a platform's", () => {
    const m = mail({ fromAddress: "sam.ortiz@gmail.example", subject: "Next steps", body: "Your availability?" });
    expect(run(m, [acme], history).effect).toBe("link Acme | Backend Engineer: applied -> interview");
    expect(run({ ...m, fromAddress: "alex.morgan@talentbridge.example" }, [acme], history).effect).toBe(
      "link Acme | Backend Engineer: applied -> interview",
    );
  });
});

describe("review 2: domains match by whole name, not by substring", () => {
  // "meta" is inside "metabase", "ring" inside "spring": both newsletters moved the job.
  it("does not take metabase.com for Meta", () => {
    const meta = job("meta", "Meta", "Software Engineer", "applied");
    const { result } = run(
      mail({
        fromName: "Metabase",
        fromAddress: "hello@metabase.com",
        subject: "Interview with our CEO",
        body: "Read the interview.",
        bulk: BULK,
      }),
      [meta],
    );
    expect(result).toMatchObject({ related: false, outcome: "ignored", candidates: [] });
  });

  it("does not take spring.io for Ring", () => {
    const ring = job("ring", "Ring", "Firmware Engineer", "applied");
    const { result } = run(
      mail({
        fromName: "Spring",
        fromAddress: "news@spring.io",
        subject: "Spring news",
        body: "Unfortunately the event is cancelled.",
        bulk: BULK,
      }),
      [ring],
    );
    expect(result).toMatchObject({ related: false, outcome: "ignored", candidates: [] });
  });

  it("matches the whole label, or the start of its hyphenated parts", () => {
    const invite = (fromAddress: string) => mail({ fromAddress, subject: "Interview", body: "Your availability?" });
    const halcyon = [job("h", "Halcyon", "Engineer", "applied")];
    expect(run(invite("talent@halcyon-robotics.example"), halcyon).effect).toBe("link Halcyon | Engineer: applied -> interview");
    expect(run(invite("talent@halcyon.example"), halcyon).effect).toBe("link Halcyon | Engineer: applied -> interview");
    // Not the end of the label, and not a run that starts inside a part.
    expect(run(invite("talent@robotics-halcyon.example"), halcyon).result.candidates).toEqual([]);
    expect(run(invite("talent@halcyonics.example"), halcyon).result.candidates).toEqual([]);
    // "acme" is the start of "acmelabs", but not a hyphenated part of it.
    expect(run(invite("jobs@acmelabs.example"), [job("a", "Acme", "Engineer", "applied")]).result.candidates).toEqual([]);
  });
});

describe("review 3: a posting's host is not the employer unless the name says so", () => {
  // Jobs saved from Google's job search or arbeitnow: every mail from those sites matched.
  it("does not take google.com for an employer whose job was found on Google", () => {
    const j = job("j", "Nordlicht GmbH", "Data Analyst", "applied", {
      url: "https://www.google.com/search?q=data+analyst&ibp=htl;jobs#htivrt=jobs",
    });
    const { result } = run(
      mail({
        fromName: "Google",
        fromAddress: "no-reply@accounts.google.com",
        subject: "Security alert",
        body: "Unfortunately we could not verify a sign-in.",
      }),
      [j],
    );
    expect(result).toMatchObject({ related: false, outcome: "ignored", candidates: [] });
  });

  it("does not take arbeitnow.com for an employer whose job was found there", () => {
    const k = job("k", "Nordlicht GmbH", "Data Analyst", "applied", {
      url: "https://www.arbeitnow.com/jobs/companies/nordlicht/data-analyst",
    });
    const { result } = run(
      mail({
        fromName: "Arbeitnow",
        fromAddress: "hello@arbeitnow.com",
        subject: "Your weekly jobs",
        body: "Interview tips inside.",
        bulk: { listUnsubscribe: true, listId: null, precedence: null },
      }),
      [k],
    );
    expect(result).toMatchObject({ related: false, outcome: "ignored", candidates: [] });
  });

  it("counts the posting's host when the company's name starts with it", () => {
    const invite = mail({ fromAddress: "jobs@fjordvik-energy.example", subject: "Interview", body: "Your availability?" });
    const url = "https://careers.fjordvik-energy.example/jobs/1";
    // "Fjordvik Energy Solutions" is not "fjordvik-energy"; the posting on that host says it is the company's.
    const group = job("g", "Fjordvik Energy Solutions", "Analyst", "applied", { url });
    expect(run(invite, [group]).effect).toBe("link Fjordvik Energy Solutions | Analyst: applied -> interview");
    expect(run(invite, [{ ...group, url: null }]).result.candidates).toEqual([]);
    // A name that does not start with the host: the host is not counted.
    const acronym = job("l", "LHL", "Analyst", "applied", { url: "https://lindenhof-logistics.example/jobs/1" });
    expect(run(mail({ ...invite, fromAddress: "jobs@lindenhof-logistics.example" }), [acronym]).result.candidates).toEqual([]);
  });
});

describe("review 4: a confirmation for another role at the same company", () => {
  // The confirmation for a second application was linked to the first job, whatever its status.
  // Second review: it goes to review instead of creating a job, because the role is a guess
  // (see "second review, finding 1" below).
  const confirmation = mail({
    fromName: "Acme Careers",
    fromAddress: "careers@acme.com",
    subject: "Thank you for applying – Data Engineer",
    body: "Thank you for applying for the Data Engineer role at Acme.",
  });

  it.each<Status>(["interview", "rejected", "applied", "offer", "saved"])("sends it to review next to a job in %s", (status) => {
    const fe = job("fe", "Acme", "Frontend Engineer", status);
    expect(run(confirmation, [fe]).effect).toBe("review unknown_job [] applied");
  });

  it("creates the job when Acme has none, and sends it to review when the setting is off", () => {
    expect(run(confirmation, []).effect).toBe("create Acme | Data Engineer");
    const fe = job("fe", "Acme", "Frontend Engineer", "applied");
    expect(run(confirmation, [fe], { createFromConfirmation: false }).effect).toBe("review unknown_job [] applied");
  });

  it("links a confirmation that names the job's role, or no other role", () => {
    const fe = job("fe", "Acme", "Frontend Engineer (m/w/d)", "saved");
    const linked = "link Acme | Frontend Engineer (m/w/d): saved -> applied";
    const named = { ...confirmation, subject: "Thank you for applying – Frontend Engineer", body: "Thank you for applying." };
    expect(run(named, [fe]).effect).toBe(linked);
    for (const role of ["Senior Frontend Engineer", "Front-End Engineer", "Frontend-Engineer (all genders)"]) {
      expect(run({ ...named, subject: `Thank you for applying – ${role}` }, [fe]).effect, role).toBe(linked);
    }
    // Subject tails that are not roles.
    for (const subject of ["Ihre Bewerbung – Eingangsbestätigung", "Application received – Thank you", "Thanks for applying – Acme"]) {
      const m = { ...confirmation, subject, body: "We received your application." };
      expect(run(m, [fe]).effect, subject).toBe(linked);
    }
    // No role named at all.
    expect(run({ ...confirmation, subject: "", body: "Thank you for applying." }, [fe]).effect).toBe(linked);
  });

  it("leaves interview mail that names another role to the job", () => {
    const fe = job("fe", "Acme", "Frontend Engineer", "applied");
    const invite = { ...confirmation, subject: "Interview – Data Engineer", body: "Your availability?" };
    expect(run(invite, [fe]).effect).toBe("link Acme | Frontend Engineer: applied -> interview");
  });
});

describe("review 5: the employer's own bulk mail (owner, D1: review, never a change by itself)", () => {
  // A shop's "sold out" mail from the employer's domain moved the job to Rejected ("leider" was a
  // keyword then; any keyword in such mail does the same).
  // The first fix ignored it, and with it an offer sent with List-Unsubscribe. Bulk mail that only
  // the sender's domain or history ties to a job now goes to review when a keyword hits.
  const zalando = job("z", "Zalando", "Data Engineer", "interview");
  const shop = mail({
    fromName: "Zalando",
    fromAddress: "info@service-mail.zalando.de",
    subject: "Leider ausverkauft",
    body: "Leider ist dein Wunschartikel ausverkauft. Wir können deine Bestellung nicht berücksichtigen.",
    bulk: BULK,
  });

  it("sends the shop's mail with a keyword to review instead of rejecting the job", () => {
    const { result, effect } = run(shop, [zalando]);
    expect(result).toMatchObject({
      related: true,
      outcome: "review",
      reviewReason: "bulk_mail",
      evidence: ["sender_domain", "keyword", "company_named", "bulk"],
    });
    expect(effect).toBe("review bulk_mail [Zalando | Data Engineer] rejected");
  });

  it("ignores the employer's bulk mail without a keyword, even with three kinds of weak evidence", () => {
    // Hint, company named and a job board's Reply-To: related by the weak rule, but no keyword.
    const news = {
      ...shop,
      replyToAddress: "jobs@stepstone.de",
      subject: "Neu: Jobs und Stellen bei Zalando",
      body: "Deine Bewerbung für die Stelle? Hier entlang.",
    };
    expect(run(news, [zalando]).result.evidence).toEqual(["sender_domain", "hint", "company_named", "board_sender", "bulk"]);
    expect(run(news, [zalando]).result).toMatchObject({ related: false, outcome: "ignored" });
    expect(run(news, [zalando], { senderJobIds: ["z"] }).result).toMatchObject({ related: false, outcome: "ignored" });
  });

  it("sends an offer or a rejection the employer sends with List-Unsubscribe to review", () => {
    const listUnsubscribe = { listUnsubscribe: true, listId: null, precedence: null };
    const offer = mail({
      fromName: "Zalando",
      fromAddress: "talent@zalando.de",
      subject: "Offer",
      body: "We are pleased to offer you the job.",
      bulk: listUnsubscribe,
    });
    const { result, effect } = run(offer, [zalando]);
    expect(result).toMatchObject({ related: true, evidence: ["sender_domain", "keyword", "company_named", "bulk"] });
    expect(effect).toBe("review bulk_mail [Zalando | Data Engineer] offer");
    const rejection = {
      ...offer,
      fromName: "Zalando Recruiting",
      subject: "Ihre Bewerbung bei Zalando",
      body: "Leider haben wir uns für andere Kandidaten entschieden.",
    };
    expect(run(rejection, [zalando]).effect).toBe("review bulk_mail [Zalando | Data Engineer] rejected");
    // A locked job, or no change: still review, suggesting the status the job keeps.
    expect(run(rejection, [{ ...zalando, statusLocked: true }]).effect).toBe("review bulk_mail [Zalando | Data Engineer] interview");
  });

  it("sends a recruiter's newsletter from an address linked to the job to review", () => {
    const newsletter = mail({
      fromName: "Alex Morgan",
      fromAddress: "alex.morgan@talentbridge.example",
      subject: "Our monthly newsletter",
      body: "Five interview tips for the new year.",
      bulk: BULK,
    });
    const { result, effect } = run(newsletter, [zalando], { senderJobIds: ["z"] });
    expect(result.evidence).toEqual(["sender_history", "keyword", "bulk"]);
    expect(effect).toBe("review bulk_mail [Zalando | Data Engineer] interview");
  });

  it("keeps a review reason the mail already has", () => {
    const rejected = job("z", "Zalando", "Data Engineer", "rejected");
    const invite = { ...shop, subject: "Interview", body: "Your availability?" };
    expect(run(invite, [rejected]).effect).toBe("review status_mismatch [Zalando | Data Engineer] interview");
  });

  it("keeps the domain strong without bulk headers, and the thread, ATS and applied phrase with them", () => {
    const hello = mail({ fromAddress: "info@service-mail.zalando.de", subject: "Hello", body: "Your availability?" });
    expect(run(hello, [zalando]).result.evidence).toEqual(["sender_domain", "keyword"]);
    expect(run(hello, [{ ...zalando, status: "applied" }]).effect).toBe("link Zalando | Data Engineer: applied -> interview");
    const bulk = { ...hello, bulk: BULK };
    const applied = { ...zalando, status: "applied" as const };
    expect(run(bulk, [applied]).effect).toBe("review bulk_mail [Zalando | Data Engineer] interview");
    expect(run(bulk, [applied], { threadJobId: "z" }).effect).toBe("link Zalando | Data Engineer: applied -> interview");
    const viaAts = { ...bulk, fromAddress: "no-reply@zalando.greenhouse-mail.io", fromName: "Zalando" };
    expect(run(viaAts, [applied]).effect).toBe("link Zalando | Data Engineer: applied -> interview");
    const confirmation = { ...bulk, subject: "Eingangsbestätigung Ihrer Bewerbung", body: "Wir melden uns." };
    expect(run(confirmation, [{ ...zalando, status: "saved" }]).effect).toBe("link Zalando | Data Engineer: saved -> applied");
  });
});

describe("review 7 (owner, D3): a company from a platform sender's name only when the text names it", () => {
  // "Sarah Miller | Talent Acquisition" lost its mailbox words and became the company "Sarah Miller |".
  const confirmation = (fromName: string, body: string) =>
    mail({ fromName, fromAddress: "no-reply@ashbyhq.com", subject: "Thank you for applying – Backend Engineer", body });

  it.each(["Sarah Miller | Talent Acquisition", "Sarah from Acme Recruiting"])("sends %j via an ATS to review", (fromName) => {
    expect(run(confirmation(fromName, "Thank you for applying."), []).effect).toBe("review unknown_job [] applied");
  });

  it("creates the job when the subject or body names the sender's company too", () => {
    const body = "Thank you for applying to Fennel & Finch.";
    expect(run(confirmation("Fennel & Finch Hiring Team", body), []).effect).toBe("create Fennel & Finch | Backend Engineer");
    // As whole words after normalize(): "Fennel & Finches" does not name it, accents do not matter.
    expect(run(confirmation("Fennel & Finch Hiring Team", "Thanks from Fennel & Finches."), []).effect).toBe(
      "review unknown_job [] applied",
    );
    expect(run(confirmation("Café Ödland Careers", "Willkommen bei CAFE ODLAND."), []).effect).toBe(
      "create Café Ödland | Backend Engineer",
    );
  });

  it("does not take a person's name for the company, even when a signature repeats it", () => {
    for (const fromName of ["Sarah Miller | Talent Acquisition", "Sarah Miller, Recruiting", "Sarah Miller - Recruiting"]) {
      const m = confirmation(fromName, "Thank you for applying.\n\nBest,\nSarah Miller\nTalent Acquisition");
      expect(run(m, []).effect, fromName).toBe("review unknown_job [] applied");
    }
    // No mailbox words: a bare name may be a person's.
    expect(run(confirmation("Sarah Miller", "Best, Sarah Miller"), []).effect).toBe("review unknown_job [] applied");
  });

  it("does not take the platform's own name, or a name from a sender that is no platform", () => {
    const workday = mail({
      fromName: "Workday Careers",
      fromAddress: "acme@myworkday.com",
      subject: "Thank you for applying – Backend Engineer",
      body: "Thank you for applying. Powered by Workday.",
    });
    expect(run(workday, []).effect).toBe("review unknown_job [] applied");
    const gmail = { ...confirmation("Fennel & Finch Hiring Team", "Thank you for applying to Fennel & Finch."), fromAddress: "fennel.finch@gmail.example" };
    expect(run(gmail, []).effect).toBe("review unknown_job [] applied");
  });

  it("still prefills the review form from the sender's name", () => {
    const m = mail({ fromName: "Fennel & Finch Hiring Team", fromAddress: "no-reply@us.greenhouse-mail.io", subject: "Thanks" });
    expect(guessCompany(m)).toBe("Fennel & Finch");
  });
});

describe("owner, D2: a company named with its region or group", () => {
  const invite = (fromAddress: string) => mail({ fromAddress, subject: "Interview", body: "Your availability?" });

  it.each([
    ["careers@microsoft.example.com", "Microsoft Deutschland GmbH"],
    ["jobs@spotify.example.com", "Spotify Technology"],
    ["talent@mercedes-benz.example", "Mercedes-Benz Group AG"],
    ["jobs@ottogroup.example", "Otto Group"],
    ["jobs@acme.example", "Acme Holding International Europe"],
  ])("matches %s to %s", (fromAddress, company) => {
    const j = job("j", company, "Engineer", "applied");
    expect(run(invite(fromAddress), [j]).effect).toBe(`link ${company} | Engineer: applied -> interview`);
  });

  it("keeps whole names apart, and names of region or group words alone", () => {
    const none = (fromAddress: string, company: string) =>
      expect(run(invite(fromAddress), [job("j", company, "Engineer", "applied")]).result.candidates, company).toEqual([]);
    none("hello@metabase.example", "Meta Group");
    none("news@spring.example", "Ring Technologies");
    none("jobs@bosch.example", "Robert Bosch GmbH");
    none("jobs@europe.example", "Europe Group");
    none("jobs@group.example", "Group Holding");
    none("someone@web.example", "Web Technologies");
    none("someone@gmail.example", "Gmail International");
  });
});

describe("review 9b: recruiting platforms by their whole registrable domain", () => {
  // join.me (meetings) was taken for JOIN (join.com), an applicant-tracking system: strong evidence.
  it("does not take join.me for an applicant-tracking system", () => {
    const { result } = run(
      mail({ fromName: "join.me", fromAddress: "noreply@join.me", subject: "Meeting reminder", body: "Your meeting starts soon." }),
      [],
    );
    expect(result).toMatchObject({ related: false, outcome: "ignored", evidence: [] });
  });

  it("knows the platforms' own domains, in every country where the name is distinctive", () => {
    expect(platformOf("noreply@join.com")).toBe("ats");
    expect(platformOf("noreply@join.me")).toBeNull();
    expect(platformOf("alerts@dice.com")).toBe("board");
    expect(platformOf("tickets@dice.fm")).toBeNull();
    expect(platformOf("noreply@indeed.de")).toBe("board");
    expect(platformOf("jobs@reed.co.uk")).toBe("board");
    expect(platformOf("no-reply@acme.recruitee.com")).toBe("ats");
    expect(urlCore("https://acme.jobs.personio.com/job/1")).toBeNull();
    // Invented fixture domains (.example) match by name.
    expect(platformOf("no-reply@hire.lever.example")).toBe("ats");
  });
});

describe("second review, finding 1: a guessed role is not enough to leave the matched job", () => {
  // guessTitle reads a role out of any subject tail and, before this fix, out of any German "als"
  // + noun. Each confirmation below is for the saved job, which stayed "saved", while a job
  // named after the guess was created next to it ("Acme | PDF").
  const saved = job("fe", "Acme GmbH", "Frontend Developer (m/w/d)", "saved");
  const linked = "link Acme GmbH | Frontend Developer (m/w/d): saved -> applied";
  const from = { fromName: "Acme GmbH", fromAddress: "karriere@acme.de" };

  it.each([
    ["an employer named with als", "Vielen Dank für Ihre Bewerbung und Ihr Interesse an der Acme GmbH als Arbeitgeber."],
    ["a file format named with als", "Vielen Dank für Ihre Bewerbung. Bitte senden Sie uns Ihre Zeugnisse als PDF."],
    ["a next step named with als", "Vielen Dank für Ihre Bewerbung. Als Nächstes melden wir uns als Erstes bei Ihnen."],
  ])("links a confirmation with %s", (_name, body) => {
    expect(run(mail({ ...from, subject: "Vielen Dank für Ihre Bewerbung", body }), [saved]).effect).toBe(linked);
  });

  it("links a confirmation that names the job's role in another word order", () => {
    const m = mail({ ...from, subject: "Thank you for applying – Developer, Frontend", body: "Thank you for applying." });
    expect(run(m, [saved]).effect).toBe(linked);
  });

  it("sends a subject tail that is no role to review instead of creating a job by its name", () => {
    for (const subject of ["Application received – Ref 4711", "We received your application: Job ID 12345"]) {
      const m = mail({ ...from, subject, body: "Thank you for applying to Acme." });
      expect(run(m, [saved]).effect, subject).toBe("review unknown_job [] applied");
      // Naming the job's title settles it, also without the gender marker (finding 2).
      const named = { ...m, body: "Thank you for applying for the Frontend Developer role at Acme." };
      expect(run(named, [saved]).effect, subject).toBe(linked);
    }
  });

  it("keeps a reply in a thread linked to the job with that job", () => {
    // The plan: a reply in a thread already linked to a job goes to that job.
    const applied = job("fe", "Acme", "Frontend Engineer", "applied");
    const reply = mail({
      fromName: "Sam Ortiz",
      fromAddress: "sam.ortiz@gmail.example",
      subject: "Re: Next steps: Coding Challenge",
      body: "Thank you for applying. Here is the task.",
    });
    expect(run(reply, [applied], { threadJobId: "fe" }).effect).toBe("link Acme | Frontend Engineer: applied -> applied");
    const domain = { ...reply, fromAddress: "sam.ortiz@acme.example.com" };
    expect(run(domain, [applied], { threadJobId: "fe" }).effect).toBe("link Acme | Frontend Engineer: applied -> applied");
  });

  it("still guesses the role from a German application", () => {
    expect(guessTitle({ subject: "Ihre Bewerbung als Werkstudent Softwareentwicklung", body: "" })).toBe(
      "Werkstudent Softwareentwicklung",
    );
    expect(guessTitle({ subject: "Danke", body: "Sie haben sich als Data Analyst beworben." })).toBe("Data Analyst");
    expect(guessTitle({ subject: "Danke", body: "Ihr Interesse an uns als Arbeitgeber freut uns." })).toBe("");
  });
});

describe("second review, finding 2: a title is named without its gender marker", () => {
  // "Data Engineer (m/w/d)" never counted as named, so a rejection that named it could not tell
  // two jobs at one company apart, and the sender's history picked the other job: the job in
  // Interview was rejected.
  const frontend = job("A", "Acme", "Frontend Engineer", "interview");
  const data = job("B", "Acme", "Data Engineer (m/w/d)", "applied");
  const rejection = mail({
    fromName: "Acme Recruiting",
    fromAddress: "jobs@acme.com",
    subject: "Your application at Acme",
    body: "Unfortunately, we have decided to move forward with other candidates for the Data Engineer position.",
  });

  it("matches the job whose title the mail names", () => {
    expect(run(rejection, [frontend, data]).effect).toBe("link Acme | Data Engineer (m/w/d): applied -> rejected");
  });

  it("does not let the sender's history for the other job decide", () => {
    expect(run(rejection, [frontend, data], { senderJobIds: ["A"] }).effect).toBe(
      "review ambiguous_job [Acme | Frontend Engineer, Acme | Data Engineer (m/w/d)] rejected",
    );
  });

  it("keeps single letters when fewer than two words are left", () => {
    // "C Developer" is not named by every "Developer".
    const c = job("C", "Acme", "C Developer", "applied");
    const m = mail({ fromAddress: "x@gmail.example", subject: "Interview", body: "About the Java Developer role." });
    expect(run(m, [c]).result.candidates).toEqual([]);
  });
});
