// Invented mail for the email rules (src/lib/inbox/pipeline), as pipeline inputs: what the Gmail
// parser hands over after cleaning, not Gmail JSON. English and German (the languages the default
// keyword rules cover) and a few in neither. People, companies and addresses are made up.
//
// Each fixture is classified against FIXTURE_JOBS, the default rules and a new user's settings
// (languages en, de; create from confirmations on), with no thread and no sender history unless
// `context` says otherwise, at RULES_NOW. `expected.effect` names jobs as "Company | Title".
import type { MailInput, PipelineContext } from "@/lib/inbox/pipeline/types";
import type { ClassifyResult } from "@/lib/types";
import { daysAgo } from "./jobs";

export interface RuleFixture {
  key: string;
  /** The language the mail is written in. */
  written: "en" | "de" | "fr" | "es" | "nl";
  mail: MailInput;
  context?: Partial<Pick<PipelineContext, "threadJobId" | "senderJobIds" | "languages" | "createFromConfirmation">>;
  expected: Pick<ClassifyResult, "outcome" | "status" | "reviewReason" | "language"> & { effect: string };
}

const LIST = { listUnsubscribe: true, listId: "<news.list.example>", precedence: "bulk" };

const mail = (m: Partial<MailInput> & Pick<MailInput, "fromAddress" | "subject" | "body">): MailInput => ({
  fromName: "",
  receivedAt: daysAgo(0),
  ...m,
});

export const RULE_FIXTURES: RuleFixture[] = [
  /* ------------------------------------------------------------------ English */
  {
    key: "en-confirm-known",
    written: "en",
    mail: mail({
      fromName: "Lindenhof Logistics Careers",
      fromAddress: "no-reply@lindenhof-logistics.example",
      subject: "Thank you for applying",
      body: "Hi Robin,\n\nThank you for applying for the Frontend Engineer position. We received your application and will review it soon.\n\nLindenhof Logistics",
    }),
    expected: {
      outcome: "matched",
      status: "applied",
      reviewReason: null,
      language: "en",
      effect: "link Lindenhof Logistics | Frontend Engineer: applied -> applied",
    },
  },
  {
    // Via an applicant-tracking system: the company is only in the sender's name, and the body
    // names it too, so it is taken (owner, D3). The first review of 2.1 sent this to review; a
    // name the text does not repeat (a person's, "Sarah Miller | Talent Acquisition") still does.
    key: "en-confirm-new-via-ats",
    written: "en",
    mail: mail({
      fromName: "Fennel & Finch Hiring Team",
      fromAddress: "no-reply@us.greenhouse-mail.example",
      subject: "Thank you for applying – Data Analyst",
      body: "Hi Robin,\n\nThank you for applying to Fennel & Finch. We received your application and our team will be in touch.",
    }),
    expected: {
      outcome: "created",
      status: "applied",
      reviewReason: null,
      language: "en",
      effect: "create Fennel & Finch | Data Analyst",
    },
  },
  {
    // The mock created a job named "Workday".
    key: "en-confirm-platform-name-only",
    written: "en",
    mail: mail({
      fromName: "Workday",
      fromAddress: "notifications@myworkday.example",
      subject: "Thank you for applying – Senior Analyst",
      body: "Your application has been received. You can follow its progress in your candidate home.",
    }),
    expected: {
      outcome: "review",
      status: "applied",
      reviewReason: "unknown_job",
      language: "en",
      effect: "review unknown_job [] applied",
    },
  },
  {
    // The mock created a job without a title ("Untitled role").
    key: "en-confirm-no-title",
    written: "en",
    mail: mail({
      fromName: "Saltmarsh Media Recruiting",
      fromAddress: "jobs@saltmarsh-media.example",
      subject: "We received your application",
      body: "Thanks for your interest in Saltmarsh Media. We received your application and will get back to you.",
    }),
    expected: {
      outcome: "review",
      status: "applied",
      reviewReason: "unknown_job",
      language: "en",
      effect: "review unknown_job [] applied",
    },
  },
  {
    // The mock moved the job to Interview.
    key: "en-confirm-mentions-interview",
    written: "en",
    mail: mail({
      fromName: "Tidewater Games",
      fromAddress: "jobs@tidewatergames.example",
      subject: "Thank you for applying – Web Developer",
      body: "We received your application. If your profile matches the role, we will invite you to a first interview within two weeks.",
    }),
    expected: {
      outcome: "review",
      status: "applied",
      reviewReason: "conflicting_keywords",
      language: "en",
      effect: "review conflicting_keywords [Tidewater Games | Web Developer] applied",
    },
  },
  {
    key: "en-confirm-saved-job",
    written: "en",
    mail: mail({
      fromName: "Tidewater Games",
      fromAddress: "jobs@tidewatergames.example",
      subject: "Your application has been received",
      body: "Thanks for applying to Tidewater Games. Your application has been received.",
    }),
    expected: {
      outcome: "matched",
      status: "applied",
      reviewReason: null,
      language: "en",
      effect: "link Tidewater Games | Web Developer: saved -> applied",
    },
  },
  {
    // The mock moved Interview back to Applied.
    key: "en-confirm-after-interview",
    written: "en",
    mail: mail({
      fromName: "Quokka Labs",
      fromAddress: "talent@quokkalabs.example",
      subject: "Your application has been received",
      body: "Thanks for applying to Quokka Labs. Your application has been received and is with the team.",
    }),
    expected: {
      outcome: "matched",
      status: "applied",
      reviewReason: null,
      language: "en",
      effect: "link Quokka Labs | Platform Engineer: interview -> interview",
    },
  },
  {
    key: "en-thread-reply-no-keyword",
    written: "en",
    mail: mail({
      fromName: "Sam Ortiz",
      fromAddress: "sam.ortiz@gmail.example",
      subject: "Re: Next steps",
      body: "Thursday at 3pm works for us. See you then!\n\nSam",
      threadId: "thread-quokka",
    }),
    context: { threadJobId: "job_quokka" },
    expected: {
      outcome: "matched",
      status: null,
      reviewReason: null,
      language: "en",
      effect: "link Quokka Labs | Platform Engineer: interview -> interview",
    },
  },
  {
    key: "en-thread-reply-offer",
    written: "en",
    mail: mail({
      fromName: "Sam Ortiz",
      fromAddress: "sam.ortiz@gmail.example",
      subject: "Re: Next steps",
      body: "Great news: we are pleased to offer you the role. The offer letter follows by mail.\n\nSam",
      threadId: "thread-quokka",
    }),
    context: { threadJobId: "job_quokka" },
    expected: {
      outcome: "matched",
      status: "offer",
      reviewReason: null,
      language: "en",
      effect: "link Quokka Labs | Platform Engineer: interview -> offer",
    },
  },
  {
    key: "en-sender-history",
    written: "en",
    mail: mail({
      fromName: "Alex Morgan",
      fromAddress: "alex.morgan@talentbridge.example",
      subject: "Scheduling",
      body: "Hi Robin, the hiring manager would like to meet you. Could you send me your availability for next week?",
    }),
    context: { senderJobIds: ["job_orchard_web"] },
    expected: {
      outcome: "matched",
      status: "interview",
      reviewReason: null,
      language: "en",
      effect: "link Orchard Bank | Frontend Engineer: applied -> interview",
    },
  },
  {
    key: "en-two-jobs-one-company",
    written: "en",
    mail: mail({
      fromName: "Orchard Bank Talent",
      fromAddress: "talent@orchardbank.example",
      subject: "Interview invitation",
      body: "We would like to invite you to an interview. Please share your availability.",
    }),
    expected: {
      outcome: "review",
      status: "interview",
      reviewReason: "ambiguous_job",
      language: "en",
      effect: "review ambiguous_job [Orchard Bank | Frontend Engineer, Orchard Bank | Mobile Engineer] interview",
    },
  },
  {
    // The title decides (120 against 95). The mock capped scores at 1.0 and called this a tie.
    key: "en-two-jobs-title-named",
    written: "en",
    mail: mail({
      fromName: "Orchard Bank Talent",
      fromAddress: "talent@orchardbank.example",
      subject: "Interview invitation – Mobile Engineer",
      body: "We would like to invite you to an interview. Please share your availability.",
    }),
    expected: {
      outcome: "matched",
      status: "interview",
      reviewReason: null,
      language: "en",
      effect: "link Orchard Bank | Mobile Engineer: applied -> interview",
    },
  },
  {
    // The mock answered "unknown job": Offer was not a candidate.
    key: "en-closed-offer-rejection",
    written: "en",
    mail: mail({
      fromName: "Marigold Health",
      fromAddress: "people@marigoldhealth.example",
      subject: "About your offer",
      body: "Unfortunately we have to withdraw the offer because the budget for the team was cut.",
    }),
    expected: {
      outcome: "review",
      status: "rejected",
      reviewReason: "status_mismatch",
      language: "en",
      effect: "review status_mismatch [Marigold Health | Product Designer] rejected",
    },
  },
  {
    key: "en-closed-same-status",
    written: "en",
    mail: mail({
      fromName: "Kestrel Analytics",
      fromAddress: "jobs@kestrel-analytics.example",
      subject: "Your application",
      body: "Thank you again for your time. Unfortunately we are not moving forward with your application.",
    }),
    expected: {
      outcome: "matched",
      status: "rejected",
      reviewReason: null,
      language: "en",
      effect: "link Kestrel Analytics | Data Engineer: rejected -> rejected",
    },
  },
  {
    key: "en-locked",
    written: "en",
    mail: mail({
      fromName: "Pinecone Robotics",
      fromAddress: "hr@pinecone-robotics.example",
      subject: "Your application",
      body: "Unfortunately we decided to pursue other candidates for the Embedded Engineer role.",
    }),
    expected: {
      outcome: "matched",
      status: "rejected",
      reviewReason: null,
      language: "en",
      effect: "link Pinecone Robotics | Embedded Engineer: interview -> interview",
    },
  },
  {
    // Received before the offer email (5 days ago) that closed the job: history, linked only.
    key: "en-stale-invite",
    written: "en",
    mail: mail({
      fromName: "Marigold Health",
      fromAddress: "people@marigoldhealth.example",
      subject: "Second interview",
      body: "We would like to invite you to a second interview. Please send us your availability.",
      receivedAt: daysAgo(20),
    }),
    expected: {
      outcome: "matched",
      status: "interview",
      reviewReason: null,
      language: "en",
      effect: "link Marigold Health | Product Designer: offer -> offer",
    },
  },
  {
    // Received before the job was added (2 days ago).
    key: "en-older-than-job",
    written: "en",
    mail: mail({
      fromName: "Halvard Systems",
      fromAddress: "careers@halvard-systems.example",
      subject: "Interview invitation – Backend Engineer",
      body: "We would like to invite you to an interview. Can we schedule a call this week?",
      receivedAt: daysAgo(6),
    }),
    expected: {
      outcome: "review",
      status: "interview",
      reviewReason: "status_mismatch",
      language: "en",
      effect: "review status_mismatch [Halvard Systems | Backend Engineer] interview",
    },
  },
  {
    key: "en-no-response-reply",
    written: "en",
    mail: mail({
      fromName: "Copperleaf",
      fromAddress: "jobs@copperleaf.example",
      subject: "Sorry for the wait",
      body: "Sorry for the slow reply. We would love to invite you to an interview for the UI Developer role.",
    }),
    expected: {
      outcome: "matched",
      status: "interview",
      reviewReason: null,
      language: "en",
      effect: "link Copperleaf | UI Developer: no_response -> interview",
    },
  },
  {
    // The mock matched Tidewater Games on the title alone and moved it to Interview.
    key: "en-title-only",
    written: "en",
    mail: mail({
      fromName: "Jordan Lee",
      fromAddress: "jordan@brightpath-staffing.example",
      subject: "Web Developer role",
      body: "Hi Robin, I am recruiting for a Web Developer role at a client of ours. Would you have time for an interview next week?",
    }),
    expected: {
      outcome: "review",
      status: "interview",
      reviewReason: "unknown_job",
      language: "en",
      effect: "review unknown_job [] interview",
    },
  },
  {
    // The mock sent this to review ("availability").
    key: "en-noise-availability",
    written: "en",
    mail: mail({
      fromName: "Cloudhost",
      fromAddress: "news@cloudhost.example",
      subject: "New regions are live",
      body: "Check the availability of our new regions in Frankfurt and Madrid. Read the docs to get started.",
      bulk: LIST,
    }),
    expected: { outcome: "ignored", status: null, reviewReason: null, language: "en", effect: "ignore" },
  },
  {
    // The mock sent this to review ("position" inside "composition").
    key: "en-noise-substring-hint",
    written: "en",
    mail: mail({
      fromName: "Gearbox Store",
      fromAddress: "orders@gearbox-store.example",
      subject: "Your order has shipped",
      body: "Good news: your composition notebook is on its way. Track your parcel with the link below.",
    }),
    expected: { outcome: "ignored", status: null, reviewReason: null, language: "en", effect: "ignore" },
  },
  {
    // A job board's alert: board sender and a hint, but bulk headers cancel one.
    key: "en-board-alert",
    written: "en",
    mail: mail({
      fromName: "LinkedIn Job Alerts",
      fromAddress: "jobalerts-noreply@linkedin.example",
      subject: "12 new jobs for Frontend Engineer",
      body: "A new position matches your preferences: Frontend Engineer at Bluefin Studio. See all jobs.",
      bulk: LIST,
    }),
    expected: { outcome: "ignored", status: null, reviewReason: null, language: "en", effect: "ignore" },
  },
  {
    key: "en-two-kinds-of-weak",
    written: "en",
    mail: mail({
      fromName: "Casey",
      fromAddress: "casey@gmail.example",
      subject: "Your interview",
      body: "Hey, how did the interview for the position go? Tell me everything!",
    }),
    expected: {
      outcome: "review",
      status: "interview",
      reviewReason: "unknown_job",
      language: "en",
      effect: "review unknown_job [] interview",
    },
  },

  /* ------------------------------------------------------------------- German */
  {
    key: "de-confirm-known",
    written: "de",
    mail: mail({
      fromName: "Sternwarte Software Karriere",
      fromAddress: "karriere@sternwarte-software.example",
      subject: "Eingangsbestätigung Ihrer Bewerbung",
      body: "Guten Tag,\n\nvielen Dank für Ihre Bewerbung als Softwareentwickler Backend. Wir melden uns in den nächsten Tagen bei Ihnen.\n\nMit freundlichen Grüßen",
    }),
    expected: {
      outcome: "matched",
      status: "applied",
      reviewReason: null,
      language: "de",
      effect: "link Sternwarte Software GmbH | Softwareentwickler Backend: applied -> applied",
    },
  },
  {
    // An applicant-tracking system's address; the company is named in the sender name.
    key: "de-invite-via-ats",
    written: "de",
    mail: mail({
      fromName: "Sternwarte Software GmbH",
      fromAddress: "noreply@personio.example",
      subject: "Einladung zum Kennenlernen",
      body: "Hallo,\n\nwir würden Sie gerne persönlich kennenlernen. Bitte wählen Sie einen Termin über den Link.\n\nViele Grüße",
    }),
    expected: {
      outcome: "matched",
      status: "interview",
      reviewReason: null,
      language: "de",
      effect: "link Sternwarte Software GmbH | Softwareentwickler Backend: applied -> interview",
    },
  },
  {
    // The domain spells "ü" as "ue"; the job's posting has the same domain.
    key: "de-reject-umlaut-domain",
    written: "de",
    mail: mail({
      fromName: "Brückenwerk Recruiting",
      fromAddress: "karriere@brueckenwerk.example",
      subject: "Ihre Bewerbung",
      body: "Guten Tag,\n\nleider müssen wir Ihnen eine Absage erteilen. Wir wünschen Ihnen alles Gute.",
    }),
    expected: {
      outcome: "matched",
      status: "rejected",
      reviewReason: null,
      language: "de",
      effect: "link Brückenwerk AG | Werkstudent Frontend: interview -> rejected",
    },
  },
  {
    key: "de-confirm-new",
    written: "de",
    mail: mail({
      fromName: "Kranich Kaffee Recruiting",
      fromAddress: "bewerbung@kranich-kaffee.example",
      subject: "Eingangsbestätigung – Junior Data Analyst",
      body: "Hallo,\n\nvielen Dank für Ihre Bewerbung bei Kranich Kaffee. Ihre Unterlagen sind vollständig.\n\nIhr Team von Kranich Kaffee",
    }),
    expected: {
      outcome: "created",
      status: "applied",
      reviewReason: null,
      language: "de",
      effect: "create Kranich Kaffee | Junior Data Analyst",
    },
  },
  {
    // The mock sent this to review ("leider").
    key: "de-noise-leider",
    written: "de",
    mail: mail({
      fromName: "Paketpost",
      fromAddress: "noreply@paketpost.example",
      subject: "Zustellung nicht möglich",
      body: "Leider konnten wir Ihr Paket heute nicht zustellen. Sie können es ab morgen in der Filiale abholen.",
    }),
    expected: { outcome: "ignored", status: null, reviewReason: null, language: "de", effect: "ignore" },
  },
  {
    // The mock sent this to review ("stelle" inside "stellen").
    key: "de-noise-substring-hint",
    written: "de",
    mail: mail({
      fromName: "Buchladen Eule",
      fromAddress: "service@buchladen-eule.example",
      subject: "Ihre Bestellung ist unterwegs",
      body: "Vielen Dank für Ihren Einkauf. Wir stellen Ihr Paket morgen zwischen 10 und 14 Uhr zu.",
    }),
    expected: { outcome: "ignored", status: null, reviewReason: null, language: "de", effect: "ignore" },
  },
  {
    // A newsletter with hint words only, and bulk headers.
    key: "de-noise-newsletter",
    written: "de",
    mail: mail({
      fromName: "Karriere-Tipps",
      fromAddress: "newsletter@karriere-tipps.example",
      subject: "So gelingt Ihre Bewerbung",
      body: "Zehn Tipps für die perfekte Bewerbung und wie Sie die richtige Stelle finden.",
      bulk: LIST,
    }),
    expected: { outcome: "ignored", status: null, reviewReason: null, language: "de", effect: "ignore" },
  },

  /* ------------------------------------------- Neither English nor German */
  {
    // Strong evidence from the domain; no keyword in French. Content-Language names it.
    key: "fr-reject-known",
    written: "fr",
    mail: mail({
      fromName: "Lindenhof Logistics",
      fromAddress: "recrutement@lindenhof-logistics.example",
      subject: "Votre candidature",
      body: "Bonjour,\n\nnous vous remercions pour votre candidature. Malheureusement, nous ne pouvons pas y donner suite.\n\nCordialement",
      contentLanguage: "fr",
    }),
    expected: {
      outcome: "review",
      status: null,
      reviewReason: "no_keyword",
      language: "fr",
      effect: "review no_keyword [Lindenhof Logistics | Frontend Engineer] null",
    },
  },
  {
    // An applicant-tracking system, no keyword, no job: the stopwords name Dutch (in settings).
    key: "nl-invite-ats",
    written: "nl",
    mail: mail({
      fromName: "Vlinder Verzekeringen",
      fromAddress: "no-reply@recruitee.example",
      subject: "Uitnodiging voor een gesprek",
      body: "Beste Robin,\n\nbedankt voor je sollicitatie. Wij willen je graag uitnodigen voor een gesprek op ons kantoor. Laat ons weten wanneer het jou past.\n\nMet vriendelijke groeten",
    }),
    context: { languages: ["en", "de", "nl"] },
    expected: {
      outcome: "review",
      status: null,
      reviewReason: "unknown_job",
      language: "nl",
      effect: "review unknown_job [] null",
    },
  },
  {
    // No evidence the rules can read: ignored. Spanish is not in settings, so English (first).
    key: "es-unknown",
    written: "es",
    mail: mail({
      fromName: "Ana Ruiz",
      fromAddress: "ana.ruiz@gmail.example",
      subject: "Gracias por tu candidatura",
      body: "Hola, gracias por tu candidatura. Te escribiremos pronto con los próximos pasos.",
    }),
    expected: { outcome: "ignored", status: null, reviewReason: null, language: "en", effect: "ignore" },
  },
];
