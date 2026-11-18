import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@/lib/domain/defaults";
import { normalize } from "@/lib/domain/normalize";
import { classifyMail, findKeywords } from "@/lib/inbox/pipeline/classify";
import { companyFromDomain, companyFromPlatformName, guessCompany, guessTitle, guessTitleDetail } from "@/lib/inbox/pipeline/extract";
import { noiseKind } from "@/lib/inbox/pipeline/noise";
import type { MailInput, PipelineContext } from "@/lib/inbox/pipeline/types";
import type { Job, Status } from "@/lib/types";
import { RULES_NOW } from "../../fixtures/rules/jobs";
import { effectOf, RULES } from "./support";

// The rules behind tests/unit/pipeline/german-mailbox.test.ts, one at a time: the default
// phrases, the role and the employer read out of German mail, and the three kinds of noise.

const DAY = 86_400_000;
const ago = (days: number) => new Date(RULES_NOW.getTime() - days * DAY).toISOString();

function job(id: string, company: string, title: string, status: Status, patch: Partial<Job> = {}): Job {
  return {
    id,
    company,
    title,
    location: "",
    url: null,
    description: "",
    status,
    statusSource: "email",
    statusLocked: false,
    captureMethod: "email",
    createdAt: ago(30),
    appliedAt: ago(30),
    updatedAt: ago(30),
    lastActivityAt: ago(30),
    history: [{ id: `${id}_ev0`, from: null, to: status, at: ago(30), source: "email" }],
    emailCount: 0,
    nextInterview: null,
    offerDeadline: null,
    ...patch,
  };
}

const mail = (m: Partial<MailInput>): MailInput => ({
  fromName: "",
  fromAddress: "someone@nowhere.example",
  subject: "",
  body: "",
  receivedAt: RULES_NOW,
  ...m,
});

function run(m: Partial<MailInput>, jobs: Job[] = [], extra: Partial<PipelineContext> = {}) {
  const result = classifyMail(mail(m), {
    jobs,
    rules: RULES,
    createFromConfirmation: true,
    languages: ["en", "de"],
    threadJobId: null,
    senderJobIds: [],
    now: RULES_NOW,
    ...extra,
  });
  const e = result.effect;
  return { result, effect: e.kind === "create" ? `create ${e.company} | ${e.title} [${e.status}]` : effectOf(result, jobs) };
}

const statusOf = (text: string) => [...new Set(findKeywords(text, RULES).map((h) => h.status))];

describe("the default phrases", () => {
  it("are unique per status after normalize(), as the database requires", () => {
    const keys = DEFAULT_RULES.map((r) => `${r.status}:${normalize(r.phrase)}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of DEFAULT_RULES) expect(r.phrase.trim().length, r.phrase).toBeGreaterThanOrEqual(2);
  });

  it.each([
    "Vielen Dank für Ihre Bewerbung als Entwickler.",
    "vielen Dank für deine Bewerbung auf die Stelle Entwickler",
    "herzlichen Dank für Deine Bewerbung und Dein Interesse",
    "danke für deine Bewerbung auf die Position Entwickler",
    "Wir haben deine Bewerbung erhalten",
    "Wir haben Deine Bewerbung für die Position Entwickler am 23.07. erhalten.",
    "Ihre Bewerbung ist erfolgreich bei uns eingegangen.",
    "hiermit bestätigen wir den Eingang Ihrer Bewerbung",
    "Ihre Bewerbung wurde weitergeleitet. Viel Erfolg!",
    "wie schön, dass du dich bei uns beworben hast!",
  ])("applied: %s", (text) => {
    expect(statusOf(text)).toEqual(["applied"]);
  });

  it.each([
    "Leider haben wir uns dazu entschieden, den Prozess mit Ihnen nicht fortzuführen.",
    "können wir dich bedauerlicherweise nicht in die engere Wahl nehmen",
    "müssen wir Dir leider mitteilen, dass wir uns auf andere Kandidat:innen konzentrieren",
    "dass für diese Position andere Kandidaten etwas mehr überzeugt haben",
    "dass andere Bewerber (m/w/d) das Anforderungsprofil besser erfüllen",
    "Wir können dich dieses Mal leider nicht berücksichtigen.",
    "Leider konnte Ihre Bewerbung dieses Mal nicht berücksichtigt werden.",
    "Daher können wir Deine Bewerbung nicht weiter berücksichtigen.",
    "Zurzeit können wir Dir leider keine passende Position anbieten.",
    "dass wir dir die Position leider nicht anbieten können. Bitte verstehe unsere Absage nicht als Abwertung",
    "müssen wir Ihnen heute leider eine Absage erteilen",
    "Wir wünschen Ihnen für Ihren weiteren beruflichen Werdegang alles Gute.",
    "Die Stelle ist inzwischen anderweitig besetzt.",
    "your application was not selected at this time",
  ])("rejected: %s", (text) => {
    expect(statusOf(text)).toEqual(["rejected"]);
  });

  it.each([
    "hat Sie zu einem Videovorstellungsgespräch eingeladen",
    "weshalb wir Sie gerne persönlich kennenlernen möchten",
    "Einladung zum Teamsmeeting",
    "wir laden Sie zu einem Erstgespräch ein",
    "anbei unser Terminvorschlag",
  ])("interview: %s", (text) => {
    expect(statusOf(text)).toEqual(["interview"]);
  });

  it.each([
    "Leider ist der Termin nicht mehr verfügbar. Wie passt Ihnen Dienstag?", // "leider" about a time slot
    "Zusagen\nAbsagen oder verschieben", // the buttons of an interview reminder
    "Lerne uns in der Zwischenzeit noch besser kennen.", // a confirmation
    "Wir freuen uns darauf, dich kennenzulernen!",
    "Wir freuen uns, dass Sie Ihre berufliche Zukunft mit uns gestalten möchten.", // a confirmation
    "Leider ist dein Wunschartikel ausverkauft.", // a shop
  ])("no status: %s", (text) => {
    expect(statusOf(text)).toEqual([]);
  });

  it("reads a rejection that regrets not meeting everyone as a rejection, not a conflict", () => {
    const text = "Wir können leider nicht alle Bewerber persönlich kennenlernen und haben uns für andere Kandidaten entschieden.";
    expect(statusOf(text)).toEqual(["rejected"]);
  });
});

describe("the role, read out of German mail", () => {
  it.each([
    ["Deine Bewerbung als IT-Operations Engineer (m/w/d) (40021)", "", "IT-Operations Engineer"],
    ["Halden Group - Ihre Bewerbung als Cloud Platform Engineer (m/w/d)", "", "Cloud Platform Engineer"],
    ["Ihre Bewerbung als Software Engineer (m/w/d) 30455", "", "Software Engineer"],
    ["Deine Bewerbung als (Junior) Automation Specialist befristet (m/w/d)", "", "(Junior) Automation Specialist befristet"],
    ["Acme: Deine Bewerbung auf die Stelle Fullstack Developer (m/w/d) KI-Fokus, Logistik", "", "Fullstack Developer"],
    ["Ihre Bewerbung: Software - Engineer (m/w/d) in Hanau & Mobiles Arbeiten", "", "Software - Engineer"],
    ["Bewerbung über Indeed: Full-Stack Software Engineer | Cloud Native | (m/w/d)", "", "Full-Stack Software Engineer | Cloud Native"],
    ["Bewerbung über Indeed: DevOps Engineer (m/w/d) - Plattformbetrieb", "", "DevOps Engineer"],
    ["Ihre Bewerbung", "vielen Dank für Ihre Bewerbung als Data Engineer (w/m/d) (JR-1) !", "Data Engineer"],
    ["Deine Bewerbung", "dein Interesse an der Stelle Software Engineer (w/m/d).", "Software Engineer"],
    ["Deine Bewerbung", "deine Bewerbung für die Position Frontend-Developer - Logistics (w/m/d) .", "Frontend-Developer - Logistics"],
    ["Deine Bewerbung", "Bewerbung für die Stelle (Junior) Frontend Developer - AI-Anwendungen (w/m/d) investiert", "(Junior) Frontend Developer - AI-Anwendungen"],
    ["Ihre Bewerbung", "für den Einstieg als KI-Softwareentwickler (m/w/d) – 100 % Remote", "KI-Softwareentwickler"],
    ["Einladung", "für die Stelle als Backend Entwickler / Backend Developer (m/f/x).", "Backend Entwickler / Backend Developer"],
    ["News", "Thank you for applying to the Backend Developer (m/w/d) position at Acme GmbH.", "Backend Developer"],
    ["Ihre Bewerbung", "Ihre Bewerbung als Data Analyst [all genders] ist eingegangen", "Data Analyst"],
    // Without a gender marker: the patterns, which stay on their line and in their sentence.
    ["Deine Bewerbung", "Bewerbung für die Position Cloud Frontend/Fullstack Developer. Über dein Interesse freuen wir uns.", "Cloud Frontend/Fullstack Developer"],
    ["Ihre Bewerbung als Werkstudent Softwareentwicklung", "Hallo Robin, wir melden uns.", "Werkstudent Softwareentwicklung"],
  ])("%s / %s", (subject, body, title) => {
    expect(guessTitleDetail({ subject, body })).toEqual({ title, anchored: true });
  });

  it("takes no status line or sentence for a role", () => {
    for (const subject of [
      "Ihre Bewerbung - Eingangsbestätigung",
      "Acme - Eingangsbestätigung deiner Bewerbung",
      "Acme – Wir haben Ihre Bewerbung erhalten!",
      "Ihre Bewerbung – Einladung zum Teamsmeeting",
      "Acme - Rückmeldung zu deinem Bewerbungsprozess",
      "Deine Bewerbung bei Acme: Eingangsbestätigung // Your Acme application: Receipt confirmation",
      "Web Developer role", // the body's greeting is no part of it
    ]) {
      expect(guessTitle({ subject, body: "Hi Robin, I am writing about your documents." }), subject).toBe("");
    }
    // A marker without a lead-in, or the end of a subject: a guess for the form, not anchored.
    expect(guessTitleDetail({ subject: "Data Engineer (m/w/d) – Standort Köln", body: "" })).toEqual({
      title: "Data Engineer",
      anchored: false,
    });
    expect(guessTitleDetail({ subject: "Thank you for applying – Frontend Engineer", body: "" })).toEqual({
      title: "Frontend Engineer",
      anchored: false,
    });
    // Applicants are no role: "andere Bewerber (m/w/d)" has no lead-in.
    expect(guessTitle({ subject: "Deine Bewerbung", body: "dass andere Bewerber (m/w/d) das Profil besser erfüllen" })).toBe("");
  });
});

describe("the employer, read out of German mail", () => {
  const text = { subject: "Ihre Bewerbung", body: "Mit freundlichen Grüßen\nHalden Group Recruiting Team" };

  it("drops the career word of a career site's domain, and spells the name as the mail does", () => {
    const m = { fromName: "Ihre Bewerbung", fromAddress: "bewerbung@jobs.orbis-karriere.example", subject: "Ihre Bewerbung", body: "bei der ORBIS Group" };
    expect(companyFromDomain(m)).toBe("ORBIS");
    expect(companyFromDomain({ ...m, body: "" })).toBe("Orbis");
    // A lower-case brand is spelled lower-case; a capitalised spelling wins when both occur.
    const lower = { fromName: "", fromAddress: "jobs@lumora.example", subject: "Deine Bewerbung bei lumora", body: "" };
    expect(companyFromDomain(lower)).toBe("lumora");
    expect(companyFromDomain({ ...lower, body: "Dein Lumora Team" })).toBe("Lumora");
    expect(companyFromDomain({ ...lower, fromAddress: "jobs@lumora-group.example", fromName: "lumora Group" })).toBe("lumora Group");
  });

  it("takes a platform sender's name without the platform's own", () => {
    const via = (fromName: string, fromAddress: string, t = text) => companyFromPlatformName({ fromName, fromAddress, ...t });
    expect(via("Halden Group Workday", "halden@myworkday.example")).toBe("Halden Group");
    const indeed = { subject: "Gute Neuigkeiten", body: "ein Gespräch bei Varda IT-Services GmbH" };
    expect(via("Varda IT-Services GmbH über Indeed", "no-reply@indeed.example", indeed)).toBe("Varda IT-Services GmbH");
    expect(via("Varda IT-Services GmbH via Indeed", "no-reply@indeed.example", indeed)).toBe("Varda IT-Services GmbH");
    // The platform's own names, alone or in a mailbox name.
    expect(via("Indeed", "no-reply@indeed.example", indeed)).toBe("");
    expect(via("Indeed-Bewerben-Funktion", "indeedapply@indeed.example", { subject: "Bewerbung über Indeed: Web Developer (m/w/d)", body: "" })).toBe("");
    expect(via("Workday", "notifications@myworkday.example")).toBe("");
    // Not named in the text: still nothing.
    expect(via("Halden Group Workday", "halden@myworkday.example", { subject: "Ihre Bewerbung", body: "" })).toBe("");
  });

  it("takes a bare sender name only with a legal form, or when the subject names it", () => {
    const via = (fromName: string, subject: string, body: string) =>
      companyFromPlatformName({ fromName, fromAddress: "recruiting@m.personio.example", subject, body });
    expect(via("quantwerk", "Bewerbung | Application (quantwerk)", "")).toBe("quantwerk");
    expect(via("Ostwind GmbH", "Neuigkeiten", "position at Ostwind GmbH")).toBe("Ostwind GmbH");
    expect(via("Nordkap IT-Services", "Neuigkeiten zu Ihrer Bewerbung von Nordkap IT-Services", "")).toBe("Nordkap IT-Services");
    // A person's name, which a signature repeats.
    expect(via("Carla Brandt", "Ihre Bewerbung", "Viele Grüße\nCarla Brandt")).toBe("");
  });

  it("takes the employer after the @ of a mailbox-like sender name, as the text spells it", () => {
    const m = { fromName: "yourjob@feldmann", fromAddress: "feldmann@successfactors.example", subject: "Ihre Bewerbung", body: "Ihr Feldmann Recruiting Team" };
    expect(companyFromPlatformName(m)).toBe("Feldmann");
    expect(guessCompany(m)).toBe("Feldmann");
    expect(companyFromPlatformName({ ...m, body: "" })).toBe("");
    expect(companyFromPlatformName({ ...m, fromName: "jobs@indeed" })).toBe("");
  });
});

describe("noise: portal housekeeping, job-board advertising, study applications", () => {
  it.each([
    "Dein Verifizierungscode // Your one-time password",
    "Acme - Karriere Account erstellt",
    "Herzlich Willkommen in unserem Karriereportal",
    "Wir haben Ihnen ein Profil in unserer Datenbank angelegt.",
    "Ihr Passwort für unser Karriereportal",
    "Please verify your email address",
    "Your account has been created",
  ])("portal: %s", (subject) => {
    expect(noiseKind(mail({ subject, body: "Ihre Bewerbung" }))).toBe("portal");
  });

  it("reads portal mail from the subject only", () => {
    const confirmation = mail({
      fromAddress: "hr@acme.example",
      subject: "Acme - Eingangsbestätigung deiner Bewerbung",
      body: "vielen Dank für deine Bewerbung als Entwickler (m/w/d). Wenn du dein Passwort zurücksetzen möchtest, klicke hier. Zum Karriereportal.",
    });
    expect(noiseKind(confirmation)).toBeNull();
    expect(run(confirmation).effect).toBe("create Acme | Entwickler [applied]");
  });

  it("links portal mail to the one job it points at and keeps the status, whatever its words say", () => {
    const acme = job("a", "Acme", "Entwickler", "applied");
    const welcome = {
      fromAddress: "portal@acme.example",
      subject: "Herzlich Willkommen in unserem Karriereportal",
      body: "Hier kannst du Termine zu Vorstellungsgesprächen vereinbaren. Leider mitteilen müssen wir nichts.",
    };
    const { result, effect } = run(welcome, [acme]);
    expect(effect).toBe("link Acme | Entwickler: applied -> applied");
    expect(result).toMatchObject({ outcome: "matched", status: null, reviewReason: null });
    expect(result.evidence).toContain("portal_mail");
    // No job, or two that tie: ignored, never review.
    expect(run(welcome).result).toMatchObject({ related: false, outcome: "ignored" });
    expect(run(welcome, [acme, job("b", "Acme", "Tester", "applied")]).result.outcome).toBe("ignored");
    // Through an applicant-tracking system, which alone is strong evidence.
    expect(run({ ...welcome, fromAddress: "acme@successfactors.example" }).result.outcome).toBe("ignored");
  });

  it("drops a job board's advertising, but not an employer's mail with the same words", () => {
    const body = "aufgrund Ihres Profils könnte diese Stelle für Sie passend sein. Leider mitteilen: Jetzt bewerben. Ihre Bewerbung?";
    const advert = { fromName: "Indeed", fromAddress: "alert@match.indeed.example", subject: "Entwickler (m/w/d) bei Acme", body };
    expect(noiseKind(mail(advert))).toBe("advert");
    expect(run(advert).result).toMatchObject({ related: false, outcome: "ignored" });
    expect(run(advert).result.evidence).toContain("job_advert");
    const acme = job("a", "Acme", "Entwickler", "applied");
    expect(run(advert, [acme]).result.outcome).toBe("ignored");
    // The same text from the employer is its mail about the application.
    const employer = { ...advert, fromName: "Acme", fromAddress: "jobs@acme.example" };
    expect(noiseKind(mail(employer))).toBeNull();
    expect(run(employer, [acme]).effect).toBe("link Acme | Entwickler: applied -> rejected");
  });

  it("drops an application for a place at a university, unless its thread is a job's", () => {
    const study = {
      fromAddress: "noreply@hs-nordhafen.example",
      subject: "Bewerbung an der Hochschule Nordhafen",
      body: "Eingangsbestätigung: vielen Dank für Ihre Bewerbung für einen Studienplatz im Masterstudiengang Informatik.",
    };
    expect(noiseKind(mail(study))).toBe("study");
    expect(run(study).result).toMatchObject({ related: false, outcome: "ignored" });
    expect(run(study).result.evidence).toContain("study_application");
    const hiwi = job("h", "Hochschule Nordhafen", "Werkstudent", "saved");
    expect(run(study, [hiwi]).result.outcome).toBe("ignored");
    expect(run(study, [hiwi], { threadJobId: "h" }).effect).toBe("link Hochschule Nordhafen | Werkstudent: saved -> applied");
  });

  it("keeps a student job's mail that quotes its posting's \"Studiengang\"", () => {
    const confirmation = {
      fromName: "Lindqvist Karriere",
      fromAddress: "karriere@lindqvist.example",
      subject: "Deine Bewerbung als Werkstudent Softwareentwicklung (m/w/d)",
      body: "Hallo Robin,\n\nvielen Dank für Deine Bewerbung! Zur Stelle: Du studierst Informatik oder einen vergleichbaren Studiengang.",
    };
    expect(noiseKind(mail(confirmation))).toBeNull();
    expect(run(confirmation).effect).toBe("create Lindqvist | Werkstudent Softwareentwicklung [applied]");
    // Either mark is enough: the gender marker alone, or the student job's word alone.
    expect(noiseKind(mail({ ...confirmation, subject: "Deine Bewerbung als Software Engineer (m/w/d)" }))).toBeNull();
    expect(noiseKind(mail({ ...confirmation, subject: "Deine Bewerbung als Werkstudent Softwareentwicklung" }))).toBeNull();
  });
});

describe("jobs from mail that is not a confirmation", () => {
  const rejection = {
    fromName: "Norvik",
    fromAddress: "karriere@norvik.example",
    subject: "Norvik | Deine Bewerbung",
    body: "Deine Bewerbung für die Stelle Frontend Developer (w/m/d): wir müssen Dir leider mitteilen, dass wir uns für andere Kandidaten entschieden haben.",
  };

  it("starts the job in the stage the first mail about it reports", () => {
    expect(run(rejection).effect).toBe("create Norvik | Frontend Developer [rejected]");
    expect(run(rejection).result).toMatchObject({ outcome: "created", status: "rejected", reviewReason: null });
  });

  it("needs the setting, a certain employer and a role that stood where roles stand", () => {
    expect(run(rejection, [], { createFromConfirmation: false }).effect).toBe("review unknown_job [] rejected");
    // A personal mail host names no employer.
    expect(run({ ...rejection, fromAddress: "norvik.hr@gmail.com" }).effect).toBe("review unknown_job [] rejected");
    // No role at all.
    const noRole = { ...rejection, body: "Deine Bewerbung: wir müssen Dir leider mitteilen, dass wir uns für andere Kandidaten entschieden haben." };
    expect(run(noRole).effect).toBe("review unknown_job [] rejected");
    // A role only at the end of the subject is a guess: enough for a confirmation, not for this.
    const tail = { ...noRole, subject: "Deine Bewerbung – Frontend Developer" };
    expect(guessTitleDetail(tail)).toEqual({ title: "Frontend Developer", anchored: false });
    expect(run(tail).effect).toBe("review unknown_job [] rejected");
    // Keywords that disagree decide nothing.
    const mixed = { ...rejection, body: `${rejection.body} Wir laden Sie zum Vorstellungsgespräch ein.` };
    expect(run(mixed).result.reviewReason).toBe("unknown_job");
  });

  it("does not take a recruiter's first message for an application", () => {
    const outreach = {
      fromName: "Jordan Lee",
      fromAddress: "jordan@brightpath-staffing.example",
      subject: "Position als Web Developer (m/w/d)",
      body: "Hallo Robin, ich besetze die Stelle als Web Developer (m/w/d) bei einem Kunden. Hätten Sie Zeit für ein Erstgespräch?",
    };
    expect(guessTitleDetail(outreach)).toEqual({ title: "Web Developer", anchored: true });
    expect(run(outreach).effect).toBe("review unknown_job [] interview");
    // The same words about an application that was made start the job.
    const invite = { ...outreach, body: `Vielen Dank für Ihre Bewerbung. ${outreach.body}` };
    expect(run(invite).effect).toBe("create Brightpath Staffing | Web Developer [interview]");
  });
});

describe("several applications at one company", () => {
  const first = job("p1", "Pallas", "Frontend-Developer - Logistics & Retail", "applied");
  const second = job("p2", "Pallas", "Data Engineer - Risk Reporting", "applied");
  const from = { fromName: "Dein Pallas Karriere Team", fromAddress: "noreply@jobs.pallas.example" };
  const confirmation = (role: string) => ({
    ...from,
    subject: "Deine Bewerbung bei Pallas: Eingangsbestätigung",
    body: `vielen Dank für deine Bewerbung für die Position ${role} (w/m/d) . Über dein Interesse an Pallas freuen wir uns.`,
  });

  it("creates the second and the third job from their confirmations", () => {
    expect(run(confirmation("Data Engineer - Risk Reporting"), [first]).effect).toBe("create Pallas | Data Engineer - Risk Reporting [applied]");
    expect(run(confirmation("Cloud Platform Developer"), [first, second]).effect).toBe("create Pallas | Cloud Platform Developer [applied]");
    // The same role again is the same job.
    expect(run(confirmation("Data Engineer - Risk Reporting"), [first, second]).effect).toBe(
      "link Pallas | Data Engineer - Risk Reporting: applied -> applied",
    );
    // Two jobs and no role in the mail: still a tie for review.
    const noRole = { ...from, subject: "Deine Bewerbung bei Pallas", body: "vielen Dank für deine Bewerbung." };
    expect(run(noRole, [first, second]).result.reviewReason).toBe("ambiguous_job");
  });

  it("starts a job from a rejection that names another role than the one job there", () => {
    const rejection = {
      ...from,
      subject: "Deine Bewerbung bei Pallas",
      body: "dass wir dir die Position Cloud Platform Developer (w/m/d) nicht anbieten können. Bitte verstehe unsere Absage nicht falsch.",
    };
    expect(run(rejection, [first]).effect).toBe("create Pallas | Cloud Platform Developer [rejected]");
    expect(run(rejection, [first], { createFromConfirmation: false }).effect).toBe(
      "link Pallas | Frontend-Developer - Logistics & Retail: applied -> rejected",
    );
  });

  it("does not compare a role with a job whose title is none", () => {
    // Titles an older version took from a subject, or the company's name.
    for (const title of ["Eingangsbestätigung deiner Bewerbung", "Eingangsbestätigung", "Pallas"]) {
      const old = job("old", "Pallas", title, "applied");
      expect(run(confirmation("Data Engineer"), [old]).effect, title).toBe(`link Pallas | ${title}: applied -> applied`);
    }
    // A role that contains the company's name is still a role.
    const studio = confirmation("ML Developer im Pallas Lab");
    expect(run(studio, [first]).effect).toBe("create Pallas | ML Developer im Pallas Lab [applied]");
  });

  it("sends a confirmation without a role to review once the one job there is rejected", () => {
    const rejected = job("r", "Norvik", "Frontend Developer", "rejected", {
      history: [
        { id: "e0", from: null, to: "applied", at: ago(30), source: "email" },
        { id: "e1", from: "applied", to: "rejected", at: ago(20), source: "email" },
      ],
    });
    const again = { fromName: "Norvik", fromAddress: "karriere@norvik.example", subject: "Norvik | Eingangsbestätigung", body: "herzlichen Dank für Deine Bewerbung." };
    expect(run(again, [rejected]).effect).toBe("review status_mismatch [Norvik | Frontend Developer] applied");
    // Received before the rejection (a first scan out of order), or in the job's thread: linked.
    expect(run({ ...again, receivedAt: new Date(ago(25)) }, [rejected]).effect).toBe("link Norvik | Frontend Developer: rejected -> rejected");
    expect(run(again, [rejected], { threadJobId: "r" }).effect).toBe("link Norvik | Frontend Developer: rejected -> rejected");
  });
});
