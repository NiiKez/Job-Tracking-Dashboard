import { Briefcase } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Job Tracker reads from Google, what it keeps, and how to remove it.",
};

/**
 * The privacy policy Google asks for before an External OAuth app can be published
 * (docs/gmail-setup.md, "Branding"). Public: src/proxy.ts lets /privacy through without a session.
 * Static on purpose: no session, no data, no client code. It must name no person, email address,
 * server or provider (this is a public repo and a public page). The facts here follow
 * docs/plan/2-gmail-ingest.md, "What is stored", and docs/plan/4-chrome-extension.md for the
 * extension; change both together. "The past 180 days" is this deployment's INBOX_BACKFILL_DAYS
 * (owner, 2026-11-17; the code's default is 30): a copy that sets another value must change this
 * page too.
 */

const LAST_UPDATED = "2026-11-18";

const USER_DATA_POLICY = "https://developers.google.com/terms/api-services-user-data-policy";
const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

const linkClass =
  "rounded-sm font-medium text-foreground underline underline-offset-4 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-section font-semibold">{title}</h2>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function List({ children }: { children: React.ReactNode }) {
  return <ul className="flex list-disc flex-col gap-1.5 pl-5 marker:text-muted-foreground">{children}</ul>;
}

export default function PrivacyPage() {
  return (
    <main className="px-4 py-12 sm:px-6">
      <article className="mx-auto w-full max-w-2xl text-sm text-pretty">
        <div className="flex items-center gap-2">
          <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Briefcase aria-hidden className="size-4" />
          </span>
          <span className="text-sm font-semibold text-foreground">Job Tracker</span>
        </div>

        <h1 className="mt-6 text-2xl leading-9 font-semibold">Privacy policy</h1>
        <p className="mt-1 text-meta text-muted-foreground">
          Last updated <time dateTime={LAST_UPDATED}>18 Nov 2026</time>
        </p>

        <Section title="What this app is">
          <p>
            Job Tracker is a personal job-application tracker. The person who runs it uses it for their own job
            search. It has no other users, and only the one Google account it is set up for can sign in.
          </p>
          <p>It runs on its operator&apos;s own server.</p>
        </Section>

        <Section title="Google data it accesses">
          <List>
            <li>
              <strong className="font-semibold">Google sign-in:</strong> your email address, your name, the link to your
              profile picture and Google&apos;s id for your account, to sign you in and show who is signed in.
            </li>
            <li>
              <strong className="font-semibold">Gmail, read-only:</strong> only after you connect it in Settings. On
              connecting, the app scans your mail from the past 180 days; after that it reads new mail as it arrives. It
              looks for messages about your job applications and updates their status. It cannot send, change or
              delete mail.
            </li>
          </List>
        </Section>

        <Section title="What is stored">
          <p>For mail about a job application:</p>
          <List>
            <li>the sender&apos;s name and address, and the subject</li>
            <li>the text of the message, cleaned up and cut at 20,000 characters</li>
            <li>the time it was received</li>
            <li>what the app decided about it (which job, which status)</li>
            <li>Gmail&apos;s ids for the message and its thread</li>
          </List>
          <p>No HTML, no attachments and no raw headers are kept.</p>
          <p>
            For any other mail, only Gmail&apos;s id for the message, a result code and a time are kept, so the same
            message is not read twice. These records are deleted after 90 days.
          </p>
          <p>
            For the Gmail connection itself: the Gmail address, Google&apos;s id for your account, the permissions you
            granted, and sync bookkeeping (where the last sync stopped, when it ran, and the last error code). This
            record stays after you disconnect, so connecting again continues where it left off.
          </p>
          <p>
            To keep reading new mail, the app stores the refresh token Google gives it, encrypted with AES-256-GCM.
            Short-lived access tokens are kept in memory only, never written to disk.
          </p>
        </Section>

        <Section title="The Chrome extension">
          <p>The app has an optional Chrome extension for saving jobs from their pages. If you install it:</p>
          <List>
            <li>
              It reads a page only when you click its icon (or press its shortcut). It does not look at the pages you
              visit otherwise.
            </li>
            <li>
              It then sends that page&apos;s address (and the address the page gives as its own), its title, a few of
              its meta tags (title, site name and description), the structured data the page publishes for search
              engines, and the text of the page&apos;s main content (on the job sites it knows, only the parts of the
              posting it reads: title, company, location, description and link), plus the text you selected, if you
              selected any. It sends them only to your copy of the app, which fills in the job from them for you to
              check. Only the job you save is kept, like a job you add by hand.
            </li>
            <li>
              In the browser it keeps only its key, your app&apos;s address, and the name and email address of the
              account it is connected to. Until the browser closes, it also keeps the job details you edited in it but
              haven&apos;t saved yet (for each tab) and a connection that is still being made.
            </li>
            <li>
              The app keeps a hash of the key, the browser it was connected in (such as &ldquo;Chrome on Linux&rdquo;),
              and when it was connected and last used.
            </li>
          </List>
        </Section>

        <Section title="What it does not do">
          <List>
            <li>It does not sell or share your data, and does not transfer it to anyone else.</li>
            <li>It shows no ads and does not use your data for advertising.</li>
            <li>It does not use your data to train AI or machine-learning models.</li>
            <li>Nobody but you reads your data.</li>
          </List>
          <p>
            Job Tracker&apos;s use and transfer of information received from Google APIs to any other app will adhere to
            the{" "}
            <a href={USER_DATA_POLICY} className={linkClass}>
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </p>
        </Section>

        <Section title="Removing access and data">
          <List>
            <li>
              <strong className="font-semibold">Disconnect</strong> in Settings, under Inbox, deletes the stored token
              and asks Google to revoke the app&apos;s access. The app then reads no more mail. If Google does not
              confirm, the app says so, and you can remove the access yourself (next point). Emails already filed under
              your jobs, and the connection record, stay in the app.
            </li>
            <li>
              You can also remove the app&apos;s access in your Google Account at{" "}
              <a href={GOOGLE_PERMISSIONS} className={linkClass}>
                myaccount.google.com/permissions
              </a>
              .
            </li>
            <li>
              <strong className="font-semibold">Revoke</strong> in Settings, under Chrome extension, or{" "}
              <strong className="font-semibold">Disconnect</strong> in the extension, deletes that browser&apos;s key.
              The extension there stops working at once.
            </li>
            <li>
              To have all data for your account deleted, ask the person who runs this copy of the app. They can remove
              it completely.
            </li>
          </List>
        </Section>

        <p className="mt-10 border-t pt-6 text-meta text-muted-foreground">
          <Link href="/login" className={linkClass}>
            Sign in
          </Link>
        </p>
      </article>
    </main>
  );
}
