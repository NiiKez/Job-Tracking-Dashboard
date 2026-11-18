import type { ClassifyInput } from "@/lib/types";

export interface SandboxExample {
  id: string;
  label: string;
  input: ClassifyInput;
}

/*
 * Rule tester examples, outside the component so tests can classify them.
 * Fictional emails. Senders match demo jobs so the matcher has something to find.
 */
export const EXAMPLES: SandboxExample[] = [
  {
    id: "interview-en",
    label: "Interview invite (EN)",
    input: {
      fromAddress: "talent@northwindlabs.example",
      subject: "Next steps for the Senior Frontend Engineer role",
      body: "Hi,\n\nThanks again for your interest in Northwind Labs. The team enjoyed reading your application and we'd like to invite you to an interview.\n\nCould you send us your availability for a 45-minute video call next week?\n\nBest,\nNorthwind Labs Recruiting",
    },
  },
  {
    id: "rejection-de",
    label: "Rejection (DE)",
    input: {
      fromAddress: "jobs@fernweh-mobility.example",
      subject: "Ihre Bewerbung als Full-Stack Developer",
      body: "Guten Tag,\n\nvielen Dank für die Gespräche und Ihr Interesse an Fernweh Mobility. Leider müssen wir Ihnen mitteilen, dass wir uns für einen der anderen Kandidaten entschieden haben.\n\nWir wünschen Ihnen für Ihre weitere Suche alles Gute.\n\nMit freundlichen Grüßen\nFernweh Mobility",
    },
  },
  {
    id: "newsletter",
    label: "Newsletter",
    input: {
      fromAddress: "digest@designweekly.example",
      subject: "Design Weekly #212: type, color and motion",
      body: "This week: variable fonts in practice, a color system that scales, and five motion tips for product teams.\n\nRead online or unsubscribe anytime.",
    },
  },
];
