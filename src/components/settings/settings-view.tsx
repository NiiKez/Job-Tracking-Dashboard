"use client";

import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSettings } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { AppearanceSettings } from "./appearance-settings";
import { AutomationSettings } from "./automation-settings";
import { EmailSandbox } from "./email-sandbox";
import { ExtensionSettings } from "./extension-settings";
import { InboxSettings } from "./inbox-settings";
import { KeywordRules } from "./keyword-rules";
import { SettingsCard, SettingsSection } from "./settings-layout";
import { useDemo } from "@/hooks/use-demo";
import { useHydrated } from "@/hooks/use-hydrated";

const SECTIONS = [
  { id: "inbox", label: "Inbox" },
  { id: "extension", label: "Chrome extension" },
  { id: "automation", label: "Automation" },
  { id: "keyword-rules", label: "Keyword rules" },
  { id: "test-email", label: "Test an email" },
  { id: "appearance", label: "Appearance" },
] as const;

export function SettingsView() {
  const settingsQuery = useSettings();
  const hydrated = useHydrated();
  const settings = hydrated ? settingsQuery.data : undefined;
  // The public demo's Inbox differs (no interval row): wait for /api/me rather than flash a row.
  const { settled: meSettled, demo } = useDemo();

  const loadError = hydrated && settingsQuery.isError ? (
    <SettingsCard>
      <div className="flex flex-col items-start gap-3 px-4 py-6">
        <p className="text-sm">Couldn’t load the settings.</p>
        <p className="text-xs text-muted-foreground">{settingsQuery.error.message}</p>
        <Button variant="outline" className="h-10 md:h-9" onClick={() => settingsQuery.refetch()}>
          <RotateCw aria-hidden />
          Try again
        </Button>
      </div>
    </SettingsCard>
  ) : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl gap-10 px-4 pb-24 sm:px-6 xl:max-w-[calc(64rem+12.5rem)]">
      <SectionNav />
      <div className="min-w-0 max-w-5xl flex-1">
        <SettingsSection
          id="inbox"
          title="Inbox"
          description="The mailbox that keeps your applications up to date."
        >
          {loadError ??
            (settings && meSettled ? <InboxSettings settings={settings} demo={!!demo} /> : <RowsSkeleton rows={4} />)}
        </SettingsSection>

        <SettingsSection
          id="extension"
          title="Chrome extension"
          description="Save a job from its page in one click. The extension reads a page only when you click its icon."
        >
          <ExtensionSettings />
        </SettingsSection>

        <SettingsSection
          id="automation"
          title="Automation"
          description="What may change automatically, and when."
        >
          {loadError ?? (settings ? <AutomationSettings settings={settings} /> : <RowsSkeleton rows={3} />)}
        </SettingsSection>

        <SettingsSection
          id="keyword-rules"
          title="Keyword rules"
          description={
            <>
              <p>
                Phrases in an email decide what it means. Add the wording of every language your
                replies come in, and extend the lists when new wording shows up.
              </p>
              <ul className="mt-4 hidden flex-col gap-2 text-xs lg:flex">
                <li>
                  <span className="font-medium text-foreground">Anywhere, any case.</span> A phrase
                  matches inside the subject or body.
                </li>
                <li>
                  <span className="font-medium text-foreground">Later stages win.</span> “interview”
                  beats “thank you for applying”.
                </li>
                <li>
                  <span className="font-medium text-foreground">Disagreement goes to review.</span>{" "}
                  Interview and Rejected phrases in one email: you decide.
                </li>
              </ul>
            </>
          }
        >
          <KeywordRules settings={settings} />
        </SettingsSection>

        <SettingsSection
          id="test-email"
          title="Test an email"
          description="See what your rules would do with an email before relying on them. Uses your current rules and jobs."
        >
          <EmailSandbox />
        </SettingsSection>

        <SettingsSection id="appearance" title="Appearance" description="Light, dark, or match your device.">
          <AppearanceSettings />
        </SettingsSection>
      </div>
    </div>
  );
}

/** Sticky in-page navigation on xl screens, highlighting the section in view. */
function SectionNav() {
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  useEffect(() => {
    let frame = 0;
    // The active section is the last one whose top has passed under the sticky header.
    const update = () => {
      frame = 0;
      let current: string = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const top = document.getElementById(s.id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= 120) current = s.id;
      }
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      setActive(atBottom ? SECTIONS[SECTIONS.length - 1].id : current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return (
    <nav aria-label="Settings sections" className="sticky top-20 hidden w-40 shrink-0 self-start pt-8 xl:block">
      <ul className="flex flex-col border-l">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              onClick={() => setActive(s.id)}
              aria-current={active === s.id ? "location" : undefined}
              className={cn(
                "-ml-px block border-l-2 border-transparent py-1.5 pl-3 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                active === s.id && "border-primary font-medium text-foreground",
              )}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function RowsSkeleton({ rows }: { rows: number }) {
  return (
    <SettingsCard aria-busy aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-6 px-4 py-4">
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
          <Skeleton className="h-9 w-32 shrink-0" />
        </div>
      ))}
    </SettingsCard>
  );
}
