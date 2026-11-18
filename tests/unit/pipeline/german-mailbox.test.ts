import { describe, expect, it } from "vitest";
import { classifyMail } from "@/lib/inbox/pipeline/classify";
import type { MailInput } from "@/lib/inbox/pipeline/types";
import type { ClassifyResult, Job } from "@/lib/types";
import { GERMAN_MAILBOX, GERMAN_MAILBOX_JOBS } from "../../fixtures/rules/german-mailbox";
import { RULES_NOW } from "../../fixtures/rules/jobs";
import { RULES } from "./support";

// A first scan of an invented German mailbox (tests/fixtures/rules/german-mailbox.ts): each
// mail is classified against the jobs the mail before it left behind, as the sync does. The
// shapes come from the owner's inbox (2026-11-17), where 48 of 63 job mails waited in review:
// most because an earlier confirmation was not recognised or could not name a job, so nothing
// after it had a job to go to. A change to the rules that loses one of them shows up here.

/** The pipeline's effects applied in memory: what services/jobs.ts does in the database. */
function mailbox() {
  const jobs: Job[] = [];
  const senders = new Map<string, Set<string>>();
  const name = (id: string) => {
    const job = jobs.find((j) => j.id === id);
    return job ? `${job.company} | ${job.title}` : id;
  };

  function receive(mail: MailInput): { result: ClassifyResult; effect: string } {
    const result = classifyMail(mail, {
      jobs,
      rules: RULES,
      createFromConfirmation: true,
      languages: ["en", "de"],
      threadJobId: null,
      senderJobIds: [...(senders.get(mail.fromAddress) ?? [])],
      now: RULES_NOW,
    });
    const at = mail.receivedAt.toISOString();
    const e = result.effect;
    let jobId: string | null = null;
    let effect = "ignore";
    if (e.kind === "create") {
      const job: Job = {
        id: `job_${jobs.length + 1}`,
        company: e.company,
        title: e.title,
        location: "",
        url: null,
        description: "",
        status: e.status,
        statusSource: "email",
        statusLocked: false,
        captureMethod: "email",
        createdAt: at,
        appliedAt: at,
        updatedAt: at,
        lastActivityAt: at,
        history: [{ id: "created", from: null, to: "applied", at, source: "email" }],
        emailCount: 1,
        nextInterview: null,
        offerDeadline: null,
      };
      if (e.status !== "applied") job.history.push({ id: "moved", from: "applied", to: e.status, at, source: "email" });
      jobs.push(job);
      jobId = job.id;
      effect = `create ${e.company} | ${e.title} [${e.status}]`;
    } else if (e.kind === "link") {
      const job = jobs.find((j) => j.id === e.jobId)!;
      effect = `link ${name(job.id)}: ${e.from} -> ${e.to}`;
      if (e.from !== e.to) {
        job.history.push({ id: `ev${job.history.length}`, from: e.from, to: e.to, at, source: "email" });
        job.status = e.to;
      }
      jobId = job.id;
    } else if (e.kind === "review") {
      effect = `review ${e.reason} [${e.suggestedJobIds.map(name).join(", ")}] ${e.suggestedStatus}`;
    }
    if (jobId) senders.set(mail.fromAddress, (senders.get(mail.fromAddress) ?? new Set()).add(jobId));
    return { result, effect };
  }

  return { jobs, receive };
}

describe("a first scan of a German mailbox", () => {
  const box = mailbox();
  const effects = GERMAN_MAILBOX.map((entry) => ({ entry, ...box.receive(entry.mail) }));

  it("has unique keys, in the order the mail arrives", () => {
    expect(new Set(GERMAN_MAILBOX.map((e) => e.key)).size).toBe(GERMAN_MAILBOX.length);
    const times = GERMAN_MAILBOX.map((e) => e.mail.receivedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it.each(effects.map((e) => [e.entry.key, e] as const))("%s", (_key, { entry, result, effect }) => {
    expect(effect, entry.note).toBe(entry.expected);
    // German mail is recognised as German, whatever the keywords' languages.
    if (result.effect.kind !== "ignore" && entry.key !== "board-rejection-english") expect(result.language).toBe("de");
  });

  it("ends with every application as a job, in the status its mail left it", () => {
    expect(box.jobs.map((j) => `${j.status} ${j.company} | ${j.title}`)).toEqual(GERMAN_MAILBOX_JOBS);
  });

  it("leaves in review only the mail that cannot name its job", () => {
    const review = effects.filter((e) => e.result.effect.kind === "review").map((e) => e.entry.key);
    expect(review).toEqual([
      "confirmation-without-role", // no role in the mail
      "board-receipt", // no employer in the mail
      "rejection-without-role", // no role in the mail
      "confirmation-after-rejection", // a second application without a role
    ]);
  });
});
