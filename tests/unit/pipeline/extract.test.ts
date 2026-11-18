import { describe, expect, it } from "vitest";
import * as guess from "@/components/review/guess";
import {
  companyFromDomain,
  companyKeys,
  companyPrefixes,
  domainCore,
  domainKey,
  domainKeys,
  fitField,
  GENERIC_HOSTS,
  guessCompany,
  guessTitle,
  hasWords,
  platformOf,
  RECRUITING_PLATFORMS,
  registrableLabel,
  urlCore,
  wordText,
} from "@/lib/inbox/pipeline/extract";

describe("domains", () => {
  it.each([
    ["mail.meridian-consulting.example", "meridian-consulting"],
    ["hire.lever.co", "lever"],
    ["emberfinance.co.uk", "emberfinance"],
    ["emberfinance.co.example", "emberfinance"],
    ["acme.example.com", "acme"], // RFC 2606 names act as a public suffix
    ["jobs.acme.example.org", "acme"],
    ["example.com", "example"],
    ["Northwind.EXAMPLE", "northwind"],
    ["localhost", null],
    ["", null],
  ])("registrableLabel(%s) = %s", (host, label) => {
    expect(registrableLabel(host)).toBe(label);
  });

  it("names the employer's domain, never a mail host or a recruiting platform", () => {
    expect(domainCore("s.brandt@mail.meridian-consulting.example")).toBe("meridian-consulting");
    expect(domainCore("Jobs@Acme.Example.Com> ")).toBe("acme");
    expect(domainCore("someone@gmail.com")).toBeNull();
    expect(domainCore("someone@web.de")).toBeNull();
    expect(domainCore("jobs@example.com")).toBeNull();
    expect(domainCore("no-reply@us.greenhouse-mail.io")).toBeNull();
    expect(domainCore("jobs-noreply@linkedin.com")).toBeNull();
    expect(domainCore("not an address")).toBeNull();
    expect(domainCore("a@b@acme.example")).toBe("acme");
  });

  it("names the employer of a posting's link", () => {
    expect(urlCore("https://careers.acme.example/jobs/1")).toBe("acme");
    expect(urlCore("https://boards.greenhouse.io/acme/jobs/1")).toBeNull();
    expect(urlCore("https://acme.wd3.myworkdayjobs.com/careers/job/1")).toBeNull();
    expect(urlCore("not a url")).toBeNull();
  });

  it("tells applicant-tracking systems from job boards, apart from mail hosts", () => {
    expect(platformOf("no-reply@hire.lever.co")).toBe("ats");
    expect(platformOf("noreply@personio.de")).toBe("ats");
    expect(platformOf("jobs-noreply@linkedin.com")).toBe("board");
    expect(platformOf("talent@acme.example")).toBeNull();
    expect(platformOf("someone@gmail.com")).toBeNull();
    for (const domain of RECRUITING_PLATFORMS.keys()) {
      expect(domain, domain).toMatch(/^[a-z0-9-]+\.([a-z.]+|\*)$/);
      expect(GENERIC_HOSTS.has(domain.slice(0, domain.indexOf("."))), domain).toBe(false);
    }
  });

  it("compares company names with domain labels", () => {
    expect(companyKeys("Silt & Stone")).toEqual(["siltstone", "siltandstone"]);
    expect(companyKeys("Bramble & Co")).toEqual(["bramble", "brambleand"]);
    expect(companyKeys("Brückenwerk AG")).toEqual(["bruckenwerk", "brueckenwerk"]);
    expect(companyKeys("Straße GmbH")).toEqual(["strae", "strasse"]);
    expect(companyKeys("AG")).toEqual([]);
    expect(domainKey("bramble-co")).toBe("bramble");
    expect(domainKey("halcyon-robotics")).toBe("halcyonrobotics");
    expect(domainKeys("halcyon-robotics")).toEqual(["halcyon", "halcyonrobotics"]);
    expect(domainKeys("bramble-co")).toEqual(["bramble"]);
    expect(domainKeys("metabase")).toEqual(["metabase"]);
    expect(companyPrefixes("Fjordvik Energy Group")).toEqual(["fjordvik", "fjordvikenergy", "fjordvikenergygroup"]);
    expect(companyPrefixes("Silt & Stone")).toEqual(["silt", "siltstone", "siltand", "siltandstone"]);
  });
});

describe("whole words", () => {
  it("finds phrases as whole words, after normalize()", () => {
    const text = wordText("Our composition. The Frontend-Engineer ROLE at Zürich Bank!");
    expect(hasWords(text, "role")).toBe(true);
    expect(hasWords(text, "frontend engineer")).toBe(true);
    expect(hasWords(text, "zurich bank")).toBe(true);
    expect(hasWords(text, "position")).toBe(false);
    expect(hasWords(wordText("parole"), "role")).toBe(false);
    expect(hasWords(text, "")).toBe(false);
    expect(hasWords(text, [])).toBe(false);
  });
});

describe("guesses", () => {
  it("are what the review form imports", () => {
    expect(guess.guessCompany).toBe(guessCompany);
    expect(guess.guessTitle).toBe(guessTitle);
  });

  it("guess the company from the domain, spelled as the email spells it", () => {
    const email = { fromName: "Sophie Brandt", subject: "Hallo", body: "ich bin bei Meridian Consulting für das Recruiting zuständig." };
    expect(guessCompany({ ...email, fromAddress: "s.brandt@meridian-consulting.example" })).toBe("Meridian Consulting");
    expect(guessCompany({ ...email, body: "", fromAddress: "s.brandt@meridian-consulting.example" })).toBe(
      "Meridian Consulting",
    );
    expect(guessCompany({ ...email, fromAddress: "talent@acme.example.com", body: "" })).toBe("Acme");
  });

  it("take only the domain's company as confident (companyFromDomain)", () => {
    const email = { fromName: "Driftwood Audio Careers", subject: "Thanks", body: "" };
    expect(companyFromDomain({ ...email, fromAddress: "careers@driftwoodaudio.example" })).toBe("Driftwood Audio");
    expect(companyFromDomain({ ...email, fromAddress: "no-reply@greenhouse-mail.io" })).toBe("");
    expect(companyFromDomain({ ...email, fromAddress: "driftwood-audio@gmail.com" })).toBe("");
  });

  it("fall back to the sender name without mailbox words, never a person's or a platform's name", () => {
    const base = { subject: "Thanks", body: "", fromAddress: "no-reply@greenhouse-mail.io" };
    expect(guessCompany({ ...base, fromName: "Driftwood Audio Careers" })).toBe("Driftwood Audio");
    expect(guessCompany({ ...base, fromName: "Priya Raman" })).toBe("");
    expect(guessCompany({ ...base, fromName: "Workday" })).toBe("");
    expect(guessCompany({ ...base, fromName: "" })).toBe("");
  });

  it("guess the title from the subject, then the body", () => {
    expect(guessTitle({ subject: "Thank you for applying – Frontend Engineer", body: "" })).toBe("Frontend Engineer");
    expect(guessTitle({ subject: "Update on your Frontend Developer application", body: "" })).toBe("Frontend Developer");
    expect(guessTitle({ subject: "Re: Hi", body: "Thank you for applying for the Data Engineer role." })).toBe(
      "Data Engineer",
    );
    expect(guessTitle({ subject: "Ihre Bewerbung als Werkstudent Softwareentwicklung", body: "" })).toBe(
      "Werkstudent Softwareentwicklung",
    );
    expect(guessTitle({ subject: "We received your application", body: "Thanks!" })).toBe("");
  });

  it("fit a value into a job column", () => {
    expect(fitField("  Acme  ")).toBe("Acme");
    expect(fitField("é".repeat(250))).toHaveLength(200);
    expect(fitField(`${"a".repeat(199)} b`)).toBe("a".repeat(199));
    expect(Array.from(fitField("😀".repeat(201)))).toHaveLength(200);
  });
});
