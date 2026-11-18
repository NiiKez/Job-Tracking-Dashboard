"use client";

import { useSyncExternalStore } from "react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

const noopSubscribe = () => () => {};

/** True on macOS / iOS, so shortcut hints say ⌘ instead of Ctrl. */
export function useIsMac() {
  return useSyncExternalStore(
    noopSubscribe,
    () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent),
    () => false,
  );
}

/** "⌘ ↵" / "Ctrl ↵" hint inside a primary button (desktop only). */
export function SubmitShortcut({ className }: { className?: string }) {
  const isMac = useIsMac();
  return (
    <Kbd
      aria-hidden
      className={cn(
        "ml-0.5 hidden border-0 bg-white/20 text-[11px] text-primary-foreground sm:inline-flex dark:bg-black/15",
        className,
      )}
    >
      {isMac ? "⌘" : "Ctrl"} ↵
    </Kbd>
  );
}

/** True for Ctrl+Enter / ⌘+Enter. */
export function isSubmitShortcut(e: React.KeyboardEvent) {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing;
}

/** Two short bars + "Step n of 2". */
export function StepIndicator({ step }: { step: 1 | 2 }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <div aria-hidden className="flex gap-1">
        <span className="h-1 w-5 rounded-full bg-primary" />
        <span
          className={cn(
            "h-1 w-5 rounded-full transition-colors duration-200",
            step === 2 ? "bg-primary" : "bg-border",
          )}
        />
      </div>
      <span className="tabular">Step {step} of 2</span>
    </div>
  );
}

/** Sticky footer row of a dialog step. */
export function StepFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-b-xl border-t bg-muted/50 px-4 py-3 sm:px-5",
        className,
      )}
      {...props}
    />
  );
}
