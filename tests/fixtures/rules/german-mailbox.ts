// An invented German mailbox, in the order the mail arrives: the shapes that real German
// application mail has (found in the owner's inbox on 2026-11-17), with made-up people,
// companies and *.example addresses. tests/unit/pipeline/german-mailbox.test.ts replays it
// through the pipeline, starting without jobs, and applies each effect before the next mail, as
// a first scan does. `expected` is the effect in one line; a created job carries its status.
import type { BulkHeaders, MailInput } from "@/lib/inbox/pipeline/types";
import { daysAgo } from "./jobs";

export interface MailboxEntry {
  key: string;
  /** What the mail is, and what it once did wrong. */
  note: string;
  mail: MailInput;
  expected: string;
}

const BULK: BulkHeaders = { listUnsubscribe: true, listId: null, precedence: "bulk" };

let day = 140;
/** Each mail arrives a day after the one before. */
const mail = (m: Pick<MailInput, "fromName" | "fromAddress" | "subject" | "body"> & { bulk?: BulkHeaders }): MailInput => ({
  ...m,
  receivedAt: daysAgo(day--),
});

export const GERMAN_MAILBOX: MailboxEntry[] = [
  {
    key: "workday-confirmation",
    note: 'The platform\'s name stands in the sender\'s name ("… Workday"), and the subject is a sentence, not a role.',
    mail: mail({
      fromName: "Halden Group Workday",
      fromAddress: "halden@myworkday.example",
      subject: "Halden Group – Wir haben Ihre Bewerbung erhalten!",
      body: "Hallo Robin Okafor,\n\nvielen Dank für Ihre Bewerbung als Cloud Platform Engineer (m/w/d) (JR-0000417) ! Wir werden Ihre Unterlagen sorgfältig prüfen und bitten Sie daher um etwas Geduld. Wir werden uns zu gegebener Zeit wieder bei Ihnen melden.\n\nBeste Grüße,\nHalden Group Recruiting Team",
    }),
    expected: "create Halden Group | Cloud Platform Engineer [applied]",
  },
  {
    key: "confirmation-without-role",
    note: "Du-form, and no role anywhere: nothing can name the job, so it waits in review with the company filled in.",
    mail: mail({
      fromName: "Norvik",
      fromAddress: "karriere@norvik.example",
      subject: "Norvik | Eingangsbestätigung",
      body: "Eingangsbestätigung\n\nHallo Robin,\n\nherzlichen Dank für Deine Bewerbung und Dein damit verbundenes Interesse an Norvik. Wir schauen uns Deine Unterlagen an und kommen kurzfristig mit einem ersten Feedback wieder auf Dich zu.",
    }),
    expected: "review unknown_job [] applied",
  },
  {
    key: "verification-code",
    note: "A career portal's code, sent before the application exists: was review (no keyword).",
    mail: mail({
      fromName: "Dein Pallas Karriere Team",
      fromAddress: "noreply@jobs.pallas.example",
      subject: "Dein Verifizierungscode // Your one-time password",
      body: "Vielen Dank für dein Interesse an einer Karriere bei Pallas. Dein Verifizierungscode lautet: 000000 für die Stelle: Frontend-Developer - Logistics & Retail (w/m/d)\nBitte gib diesen Code auf der Webseite ein, um deine Bewerbung zu starten.",
    }),
    expected: "ignore",
  },
  {
    key: "confirmation-du-form",
    note: 'Du-form ("vielen Dank für deine Bewerbung"); the subject\'s end is "Eingangsbestätigung", which became the job\'s title.',
    mail: mail({
      fromName: "Dein Pallas Karriere Team",
      fromAddress: "noreply@jobs.pallas.example",
      subject: "Deine Bewerbung bei Pallas: Eingangsbestätigung // Your Pallas application: Receipt confirmation",
      body: "Hallo Robin ,\nvielen Dank für deine Bewerbung für die Position Frontend-Developer - Logistics & Retail (w/m/d) . Über dein Interesse an Pallas Deutschland freuen wir uns sehr. Wir haben deine Unterlagen erhalten und werden sie prüfen.",
    }),
    expected: "create Pallas | Frontend-Developer - Logistics & Retail [applied]",
  },
  {
    key: "confirmation-subject-tail",
    note: 'The job was called "Eingangsbestätigung deiner Bewerbung". The footer mentions a password: no portal mail.',
    mail: mail({
      fromName: "HR System",
      fromAddress: "hr-system@corvane.example",
      subject: "Corvane - Eingangsbestätigung deiner Bewerbung",
      body: "Hallo Robin,\n\nvielen Dank für deine Bewerbung und dein Interesse an der Stelle Software Engineer (w/m/d). Unser Talent Acquisition Team wird deine Bewerbung prüfen.\n\nWenn du dein Passwort zurücksetzen möchtest, klicke hier.",
    }),
    expected: "create Corvane | Software Engineer [applied]",
  },
  {
    key: "account-created",
    note: "Portal housekeeping from the employer's domain: was review (no keyword). Linked, status kept.",
    mail: mail({
      fromName: "HR System",
      fromAddress: "hr-system@corvane.example",
      subject: "Corvane - Karriere Account erstellt",
      body: "Hallo Robin,\n\nvielen Dank, dass du ein Konto bei uns angelegt hast. Du kannst jetzt unsere aktuellen Stellenangebote durchsuchen.",
    }),
    expected: "link Corvane | Software Engineer: applied -> applied",
  },
  {
    key: "portal-welcome",
    note: 'A welcome mail before the job exists; "Vorstellungsgesprächen" made it an interview for an unknown job.',
    mail: mail({
      fromName: "Tessin Recruiting",
      fromAddress: "tessin@successfactors.example",
      subject: "Herzlich Willkommen in unserem Karriereportal",
      body: "Hallo Robin Okafor,\n\nwie schön, dass du dich bei uns beworben hast! Um den Status deiner Bewerbung einzusehen und Termine zu Vorstellungsgesprächen zu vereinbaren, haben wir dir ein Profil eingerichtet. Unter folgendem Link kannst du ein Passwort hinterlegen.",
    }),
    expected: "ignore",
  },
  {
    key: "ats-confirmation-du-form",
    note: '"herzlichen Dank für deine Bewerbung": no keyword knew it, and the rejection a week later had no job.',
    mail: mail({
      fromName: "Tessin Recruiting",
      fromAddress: "tessin@successfactors.example",
      subject: "Deine Bewerbung als IT-Operations Engineer (m/w/d) (40021)",
      body: "Guten Tag Robin Okafor,\n\nherzlichen Dank für deine Bewerbung. Deine Unterlagen prüfen wir sehr sorgfältig. Dafür benötigen wir ein wenig Zeit.\n\nViele Grüße\nDein Human Resources Team\nrecruiting@tessin.example\nTessin AG",
    }),
    expected: "create Tessin | IT-Operations Engineer [applied]",
  },
  {
    key: "invitation-unknown-job",
    note: "The first mail about this application is the invitation: a job in Interview.",
    mail: mail({
      fromName: "",
      fromAddress: "c.brandt@kestrel-personal.example",
      subject: "Ihre Bewerbung – Einladung zum Teamsmeeting",
      body: "Sehr geehrter Herr Okafor,\n\nwir danken Ihnen für Ihr Interesse für den Einstieg als KI-Softwareentwickler (m/w/d) – 100 % Remote. Ihre Unterlagen haben einen guten Eindruck vermittelt, weshalb wir Sie gerne persönlich kennenlernen möchten. Wie wäre es morgen um 9 Uhr?\n\nKestrel Personal GmbH",
    }),
    expected: "create Kestrel Personal | KI-Softwareentwickler [interview]",
  },
  {
    key: "rescheduling-leider",
    note: '"leider" about a time slot was a rejection.',
    mail: mail({
      fromName: "Carla Brandt",
      fromAddress: "c.brandt@kestrel-personal.example",
      subject: "RE: Ihre Bewerbung – Einladung zum Teamsmeeting",
      body: "Hallo Herr Okafor,\n\nleider ist der Termin nicht mehr verfügbar. Wie passt Ihnen Dienstag um 9 Uhr?\n\nBeste Grüße\nCarla Brandt",
    }),
    expected: "link Kestrel Personal | KI-Softwareentwickler: interview -> interview",
  },
  {
    key: "workday-rejection",
    note: '"Leider … nicht fortzuführen": found only through "leider" before; the job did not exist.',
    mail: mail({
      fromName: "Halden Group Workday",
      fromAddress: "halden@myworkday.example",
      subject: "Halden Group - Ihre Bewerbung als Cloud Platform Engineer (m/w/d)",
      body: "Hallo Robin Okafor,\n\nwir bedanken uns für Ihre Bewerbung als Cloud Platform Engineer (m/w/d) (JR-0000417). Wir haben Ihre Bewerbung sorgfältig geprüft. Leider haben wir uns dazu entschieden, den Prozess mit Ihnen nicht fortzuführen. Wir wünschen Ihnen für Ihren weiteren beruflichen Werdegang alles Gute.",
    }),
    expected: "link Halden Group | Cloud Platform Engineer: applied -> rejected",
  },
  {
    key: "board-receipt",
    note: "A job board's receipt names the role but no employer: it stays in review, with the role filled in.",
    mail: mail({
      fromName: "Indeed-Bewerben-Funktion",
      fromAddress: "indeedapply@indeed.example",
      subject: "Bewerbung über Indeed: Backend Entwickler / Backend Developer (m/w/d)",
      body: "Ihre Bewerbung wurde weitergeleitet. Viel Erfolg!\n\nSollte Ihnen in Ihrer Bewerbung ein Fehler auffallen, bitte kontaktieren Sie Indeed.",
    }),
    expected: "review unknown_job [] applied",
  },
  {
    key: "ats-bare-sender-name",
    note: "The sender's name is the company and nothing else; the subject names it too.",
    mail: mail({
      fromName: "quantwerk",
      fromAddress: "recruiting@m.personio.example",
      subject: "Bewerbung | Application (quantwerk)",
      body: "Hallo Robin,\n\nvielen Dank für deine Bewerbung auf die Stelle Full Stack Developer Data Products (m/w/d) und die Zeit, die du dir dafür genommen hast. Wir werden deine Bewerbung nun sorgfältig prüfen.",
    }),
    expected: "create quantwerk | Full Stack Developer Data Products [applied]",
  },
  {
    key: "ats-rejection",
    note: '"nicht in die engere Wahl".',
    mail: mail({
      fromName: "Tessin Recruiting",
      fromAddress: "tessin@successfactors.example",
      subject: "Deine Bewerbung als IT-Operations Engineer (m/w/d) (40021)",
      body: "Guten Tag Robin Okafor,\n\nvielen Dank für deine Bewerbung. Leider aber haben wir eine enttäuschende Nachricht: Für die Besetzung der Stelle können wir dich bedauerlicherweise nicht in die engere Wahl nehmen.\n\nTessin AG",
    }),
    expected: "link Tessin | IT-Operations Engineer: applied -> rejected",
  },
  {
    key: "rejection-unknown-job",
    note: "The confirmation named no role; the rejection does: the job starts as Rejected.",
    mail: mail({
      fromName: "Norvik",
      fromAddress: "karriere@norvik.example",
      subject: "Norvik | Deine Bewerbung",
      body: "Unser Feedback\n\nHallo Robin,\n\nwir möchten uns für die Zeit und Mühe bedanken, die Du in Deine Bewerbung für die Stelle (Junior) Frontend Developer - KI-gestützte Logistik-Anwendungen (w/m/d) investiert hast. Wir müssen Dir leider mitteilen, dass wir uns auf andere Kandidat:innen konzentrieren werden.",
    }),
    expected: "create Norvik | (Junior) Frontend Developer - KI-gestützte Logistik-Anwendungen [rejected]",
  },
  {
    key: "rejection-without-role",
    note: "A rejection that names no role, for an application the tracker never saw: review, company and status filled in.",
    mail: mail({
      fromName: "lumora GmbH",
      fromAddress: "jobs@lumora.example",
      subject: "Deine Bewerbung bei lumora",
      body: "Hallo Robin,\n\nwir freuen uns, dass Du Dir lumora ausgesucht hast. Leider müssen wir Dir mitteilen, dass wir Dich bei der Besetzung der ausgeschriebenen Stelle nicht in die engere Wahl nehmen können. Diese Absage ist keine Kritik an Deiner Persönlichkeit.",
    }),
    expected: "review unknown_job [] rejected",
  },
  {
    key: "board-invitation",
    note: 'The employer stands in the sender\'s name before "über Indeed".',
    mail: mail({
      fromName: "Varda IT-Services GmbH über Indeed",
      fromAddress: "no-reply@indeed.example",
      subject: "Gute Neuigkeiten: Varda IT-Services GmbH hat Sie zu einem Videovorstellungsgespräch eingeladen",
      body: "Guten Tag Robin Okafor,\n\nsichern Sie sich einen Termin für ein 30-minütiges Videovorstellungsgespräch bei Varda IT-Services GmbH für die Stelle als Backend Entwickler / Backend Developer (m/w/d).\n\nGespräch planen\nAblehnen",
    }),
    expected: "create Varda IT-Services GmbH | Backend Entwickler / Backend Developer [interview]",
  },
  {
    key: "board-reminder",
    note: 'The button "Absagen oder verschieben" was a rejection keyword ("absage").',
    mail: mail({
      fromName: "Indeed",
      fromAddress: "no-reply@indeed.example",
      subject: "Erinnerung: Morgen findet Ihr Videovorstellungsgespräch mit Varda IT-Services GmbH statt",
      body: "Guten Tag Robin Okafor,\n\nhiermit möchten wir Sie daran erinnern, dass Ihr Vorstellungsgespräch mit Varda IT-Services GmbH morgen stattfindet.\n\nVideovorstellungsgespräch - Backend Entwickler / Backend Developer (m/w/d) - Freitag\n\nAbsagen oder verschieben",
    }),
    expected: "link Varda IT-Services GmbH | Backend Entwickler / Backend Developer: interview -> interview",
  },
  {
    key: "board-upsell",
    note: "A job board's advertising after an application: was review (unknown job).",
    mail: mail({
      fromName: "Indeed",
      fromAddress: "no-reply@indeed.example",
      subject: "Heben Sie sich mit einer kurzen Nachricht an Ostwind GmbH ab",
      body: "Bestätigen Sie Ihr Interesse\n\nEs kann einige Zeit dauern, bis Ostwind GmbH Ihre Bewerbung geprüft hat. Sie können aber mit einer kurzen Nachricht Ihr Interesse bestätigen.",
    }),
    expected: "ignore",
  },
  {
    key: "board-rejection-english",
    note: "A German employer's rejection in the job board's English template.",
    mail: mail({
      fromName: "Varda IT-Services GmbH",
      fromAddress: "no-reply@indeed.example",
      subject: "Neuigkeiten zu Ihrer Bewerbung von Varda IT-Services GmbH",
      body: "Thank you for applying to the Backend Entwickler / Backend Developer (m/w/d) position at Varda IT-Services GmbH. Unfortunately, Varda IT-Services GmbH has moved to the next step in their hiring process, and your application was not selected at this time.",
    }),
    expected: "link Varda IT-Services GmbH | Backend Entwickler / Backend Developer: interview -> rejected",
  },
  {
    key: "university-application",
    note: "An application for a place at a university has a confirmation too: was review (unknown job).",
    mail: mail({
      fromName: "",
      fromAddress: "noreply@hs-nordhafen.example",
      subject: "Bewerbung an der Hochschule Nordhafen",
      body: "Eingangsbestätigung\n\nSehr geehrter Herr Okafor,\n\nvielen Dank für Ihr Interesse und Ihre Bewerbung für einen Studienplatz. Ihre Online-Bewerbung ist nun bei uns eingegangen.",
    }),
    expected: "ignore",
  },
  {
    key: "confirmation-after-rejection",
    note: "A confirmation without a role, after the one job there was rejected: most likely a second application.",
    mail: mail({
      fromName: "Norvik",
      fromAddress: "karriere@norvik.example",
      subject: "Norvik | Eingangsbestätigung",
      body: "Eingangsbestätigung\n\nHallo Robin,\n\nherzlichen Dank für Deine Bewerbung und Dein damit verbundenes Interesse an Norvik.",
    }),
    expected: "review status_mismatch [Norvik | (Junior) Frontend Developer - KI-gestützte Logistik-Anwendungen] applied",
  },
  {
    key: "second-application",
    note: "Another role at a company with a job: was linked to the first job, which then took this one's rejection.",
    mail: mail({
      fromName: "Dein Pallas Karriere Team",
      fromAddress: "noreply@jobs.pallas.example",
      subject: "Deine Bewerbung bei Pallas: Eingangsbestätigung // Your Pallas application: Receipt confirmation",
      body: "Hallo Robin ,\nvielen Dank für deine Bewerbung für die Position Data Engineer - Risk Reporting (w/m/d) . Über dein Interesse an Pallas Deutschland freuen wir uns sehr.",
    }),
    expected: "create Pallas | Data Engineer - Risk Reporting [applied]",
  },
  {
    key: "third-application",
    note: "Two jobs at the company tie; the mail names a third role, without a gender marker.",
    mail: mail({
      fromName: "Dein Pallas Karriere Team",
      fromAddress: "noreply@jobs.pallas.example",
      subject: "Deine Bewerbung bei Pallas: Eingangsbestätigung // Your Pallas application: Receipt confirmation",
      body: "Hallo Robin ,\nvielen Dank für deine Bewerbung für die Position Cloud Frontend/Fullstack Developer. Über dein Interesse an Pallas Deutschland freuen wir uns sehr.",
    }),
    expected: "create Pallas | Cloud Frontend/Fullstack Developer [applied]",
  },
  {
    key: "rejection-names-its-role",
    note: 'Three jobs at the company: the role in the mail picks one. "unsere Absage" is the only rejection word besides "nicht anbieten können".',
    mail: mail({
      fromName: "Dein Pallas Karriere Team",
      fromAddress: "noreply@jobs.pallas.example",
      subject: "Deine Bewerbung bei Pallas // Your Application at Pallas",
      body: "Hallo Robin,\n\nvielen Dank für deine Bewerbung. Nach sorgfältiger Prüfung müssen wir dir mitteilen, dass wir dir die Position Data Engineer - Risk Reporting (w/m/d) nicht anbieten können. Bitte verstehe unsere Absage nicht als Abwertung deiner Fähigkeiten.",
    }),
    expected: "link Pallas | Data Engineer - Risk Reporting: applied -> rejected",
  },
  {
    key: "insurer-receipt",
    note: '"Eingangsbestätigung" from a health insurer: was review (unknown job, applied).',
    mail: mail({
      fromName: "Kasse Lindau Service App",
      fromAddress: "noreply@postbox.dokuwerk.example",
      subject: "Eingangsbestätigung",
      body: "Hallo Robin Okafor,\n\nvielen Dank für die Einreichung des Dokuments Bescheinigung.pdf über die Kasse Lindau Service App. Wir werden uns schnellstmöglich um Ihr Anliegen kümmern.",
    }),
    expected: "ignore",
  },
  {
    key: "board-recommendation",
    note: 'A recommended job; "leider" in its footer made it a rejection for an unknown job.',
    mail: mail({
      fromName: "Indeed",
      fromAddress: "alert@match.indeed.example",
      subject: "Junior Fullstack Developer (m/w/d) KI-Fokus bei Ostwind",
      body: "Guten Tag,\n\naufgrund Ihres Profils könnte diese Stelle als Junior Fullstack Developer (m/w/d) KI-Fokus für Sie passend sein. Bitte reichen Sie bei Interesse eine Schnellbewerbung ein.\n\nJob anzeigen\nJetzt bewerben\n\nLeider können wir nicht jede Stelle prüfen.",
      bulk: BULK,
    }),
    expected: "ignore",
  },
  {
    key: "career-site-domain",
    note: 'The sender\'s domain is the career site ("…-karriere"): the company was "Orbis Karriere"; the subject\'s end is longer than a role.',
    mail: mail({
      fromName: "Ihre Bewerbung",
      fromAddress: "bewerbung@jobs.orbis-karriere.example",
      subject: "Ihre Bewerbung: Software - Engineer (m/w/d) in Hanau & Mobiles Arbeiten",
      body: "Sehr geehrter Herr Okafor,\n\nvielen Dank für Ihre Bewerbung und das damit verbundene Interesse an einer Mitarbeit bei der ORBIS Group. Nach sorgfältiger Prüfung Ihrer Bewerbungsunterlagen melden wir uns umgehend wieder bei Ihnen.",
    }),
    expected: "create ORBIS | Software - Engineer [applied]",
  },
  {
    key: "ats-mailbox-sender-name",
    note: 'The sender\'s name is written like a mailbox ("yourjob@…"); "ist erfolgreich bei uns eingegangen" was no keyword.',
    mail: mail({
      fromName: "yourjob@feldmann",
      fromAddress: "feldmann@successfactors.example",
      subject: "Ihre Bewerbung als Software Engineer (m/w/d)",
      body: "Guten Tag Robin Okafor,\n\nder erste Schritt ist geschafft: Ihre Bewerbung auf die Position Software Engineer (m/w/d) ist erfolgreich bei uns eingegangen. Jetzt sind wir an der Reihe.\n\nIhr Feldmann Recruiting Team",
    }),
    expected: "create Feldmann | Software Engineer [applied]",
  },
  {
    key: "password-reset",
    note: "Portal housekeeping through the applicant-tracking system: was review (no keyword).",
    mail: mail({
      fromName: "yourjob@feldmann",
      fromAddress: "feldmann@successfactors.example",
      subject: "Ihr Passwort für unser Karriereportal",
      body: "Guten Tag Robin Okafor,\n\nSie möchten Ihr Passwort zurücksetzen? Dann klicken Sie bitte auf den untenstehenden Link.\n\nIhr Feldmann Recruiting Team",
    }),
    expected: "link Feldmann | Software Engineer: applied -> applied",
  },
  {
    key: "rejection-regrets-not-meeting",
    note: 'A rejection that regrets not meeting everyone ("kennenlernen" was an interview keyword).',
    mail: mail({
      fromName: "yourjob@feldmann",
      fromAddress: "feldmann@successfactors.example",
      subject: "Ihre Bewerbung als Software Engineer (m/w/d) 30455",
      body: "Guten Tag Robin Okafor,\n\nwir können leider nicht alle Bewerberinnen und Bewerber persönlich kennenlernen und müssen Ihnen leider mitteilen, dass andere Kandidaten etwas mehr überzeugt haben. Werten Sie diese Rückmeldung bitte nicht als Absage an Ihre Person.\n\nIhr Feldmann Recruiting Team",
    }),
    expected: "link Feldmann | Software Engineer: applied -> rejected",
  },
];

/** The jobs the mailbox ends with, as "status Company | Title", in the order they were created. */
export const GERMAN_MAILBOX_JOBS = [
  "rejected Halden Group | Cloud Platform Engineer",
  "applied Pallas | Frontend-Developer - Logistics & Retail",
  "applied Corvane | Software Engineer",
  "rejected Tessin | IT-Operations Engineer",
  "interview Kestrel Personal | KI-Softwareentwickler",
  "applied quantwerk | Full Stack Developer Data Products",
  "rejected Norvik | (Junior) Frontend Developer - KI-gestützte Logistik-Anwendungen",
  "rejected Varda IT-Services GmbH | Backend Entwickler / Backend Developer",
  "rejected Pallas | Data Engineer - Risk Reporting",
  "applied Pallas | Cloud Frontend/Fullstack Developer",
  "applied ORBIS | Software - Engineer",
  "rejected Feldmann | Software Engineer",
];
