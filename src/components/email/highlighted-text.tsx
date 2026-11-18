import { Fragment } from "react";
import { cn } from "@/lib/utils";

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Renders text (e.g. an email body) with the matched keyword phrases
 * highlighted. Case-insensitive; keeps line breaks.
 */
export function HighlightedText({
  text,
  keywords,
  className,
}: {
  text: string;
  keywords: string[];
  className?: string;
}) {
  const phrases = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (!phrases.length) {
    return <p className={cn("whitespace-pre-line", className)}>{text}</p>;
  }
  const re = new RegExp(`(${phrases.map(escape).join("|")})`, "gi");
  const parts = text.split(re);
  return (
    <p className={cn("whitespace-pre-line", className)}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark
            key={i}
            className="rounded-[3px] bg-highlight px-0.5 text-highlight-foreground"
          >
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </p>
  );
}

/** Small monospace chips for matched keyword phrases. */
export function KeywordChips({ keywords, className }: { keywords: string[]; className?: string }) {
  if (!keywords.length) return null;
  return (
    <ul className={cn("flex flex-wrap gap-1", className)} aria-label="Matched keywords">
      {keywords.map((k) => (
        <li
          key={k}
          className="rounded border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] leading-none text-muted-foreground"
        >
          {k}
        </li>
      ))}
    </ul>
  );
}
