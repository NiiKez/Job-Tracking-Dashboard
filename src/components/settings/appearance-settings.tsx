"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useHydrated } from "@/hooks/use-hydrated";
import { SettingsCard, SettingsRow } from "./settings-layout";

const THEMES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

/** Theme choice. Lives here, not in every page header: it's set once, not used daily. */
export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  // The stored theme is only known in the browser; render no selection until then.
  const hydrated = useHydrated();
  return (
    <SettingsCard>
      <SettingsRow>
        <div className="flex flex-col gap-0.5">
          <p id="theme-label" className="text-sm font-medium">
            Theme
          </p>
          <p className="text-xs text-muted-foreground">System follows your device setting.</p>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={hydrated ? (theme ?? "dark") : ""}
          onValueChange={(v) => v && setTheme(v)}
          aria-labelledby="theme-label"
        >
          {THEMES.map(({ value, label, icon: Icon }) => (
            <ToggleGroupItem
              key={value}
              value={value}
              className="h-10 gap-1.5 px-3 text-muted-foreground data-[state=on]:text-foreground md:h-9"
            >
              <Icon aria-hidden />
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingsRow>
    </SettingsCard>
  );
}
