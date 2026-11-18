import {
  Bookmark,
  CalendarClock,
  CircleHelp,
  ClipboardPaste,
  EyeOff,
  Hourglass,
  Mail,
  MailCheck,
  MailPlus,
  MailX,
  Puzzle,
  PartyPopper,
  Send,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { CaptureMethod, ChangeSource, EmailOutcome, ReviewReason, Status } from "./types";

export interface StatusMeta {
  value: Status;
  label: string;
  /** One-line explanation shown in tooltips and empty columns. */
  description: string;
  icon: LucideIcon;
  /** Pill: badge / chips. */
  badgeClass: string;
  /** Small dot (timeline, pickers). */
  dotClass: string;
  /** Text / icon colour on neutral backgrounds. */
  textClass: string;
  borderClass: string;
  /** Light background for a highlighted state. */
  tintClass: string;
}

/*
 * Colour is reserved for what needs the user (DESIGN.md): statuses are
 * neutral, only an offer uses the attention accent. The label and icon carry
 * the status, never the colour alone.
 */
const NEUTRAL = {
  badgeClass: "bg-muted text-foreground",
  dotClass: "bg-muted-foreground/60",
  textClass: "text-muted-foreground",
  borderClass: "border-border",
  tintClass: "bg-muted",
} as const;

const ATTENTION = {
  badgeClass: "bg-attention-subtle text-attention",
  dotClass: "bg-attention",
  textClass: "text-attention",
  borderClass: "border-attention",
  tintClass: "bg-attention-subtle",
} as const;

export const STATUS_META: Record<Status, StatusMeta> = {
  saved: {
    value: "saved",
    label: "Saved",
    description: "Not applied yet",
    icon: Bookmark,
    ...NEUTRAL,
  },
  applied: {
    value: "applied",
    label: "Applied",
    description: "Waiting for a reply",
    icon: Send,
    ...NEUTRAL,
  },
  interview: {
    value: "interview",
    label: "Interview",
    description: "Invited to talk",
    icon: CalendarClock,
    ...NEUTRAL,
  },
  offer: {
    value: "offer",
    label: "Offer",
    description: "Offer received",
    icon: PartyPopper,
    ...ATTENTION,
  },
  rejected: {
    value: "rejected",
    label: "Rejected",
    description: "Not moving forward",
    icon: XCircle,
    ...NEUTRAL,
  },
  no_response: {
    value: "no_response",
    label: "No response",
    description: "No reply after 30 days",
    icon: Hourglass,
    ...NEUTRAL,
  },
};

export const SOURCE_LABEL: Record<ChangeSource, string> = {
  extension: "Chrome extension",
  paste: "Added by paste",
  manual: "Changed by you",
  email: "From an email",
  review: "Confirmed by you",
  time: "No reply in time",
};

export const LANGUAGE_LABEL: Record<string, string> = {
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  nl: "Dutch",
  tr: "Turkish",
};

export const CAPTURE_META: Record<CaptureMethod, { label: string; icon: LucideIcon }> = {
  extension: { label: "Chrome extension", icon: Puzzle },
  paste: { label: "Pasted", icon: ClipboardPaste },
  email: { label: "From email", icon: Mail },
};

export const OUTCOME_META: Record<
  EmailOutcome,
  { label: string; description: string; icon: LucideIcon; className: string }
> = {
  matched: {
    label: "Status updated",
    description: "Matched an application and applied the keyword rule",
    icon: MailCheck,
    className: "text-muted-foreground bg-muted",
  },
  created: {
    label: "New application",
    description: "Confirmation for a job that wasn't in the dashboard",
    icon: MailPlus,
    className: "text-muted-foreground bg-muted",
  },
  review: {
    label: "Needs review",
    description: "Couldn't be matched to one job and status",
    icon: CircleHelp,
    className: "text-attention bg-attention-subtle",
  },
  resolved: {
    label: "Confirmed by you",
    description: "Was in review, you confirmed it",
    icon: MailCheck,
    className: "text-muted-foreground bg-muted",
  },
  ignored: {
    label: "Ignored",
    description: "Not related to a job application",
    icon: EyeOff,
    className: "text-muted-foreground bg-muted",
  },
  dismissed: {
    label: "Dismissed",
    description: "You marked it as not job related",
    icon: MailX,
    className: "text-muted-foreground bg-muted",
  },
};

export const REVIEW_REASON_META: Record<ReviewReason, { label: string; explain: string }> = {
  ambiguous_job: {
    label: "Matches several jobs",
    explain: "The sender or wording fits more than one of your applications.",
  },
  unknown_job: {
    label: "No matching job",
    explain: "This looks like a job email, but none of your applications match it.",
  },
  no_keyword: {
    label: "No keyword found",
    explain: "The job is clear, but no keyword rule says what the email means.",
  },
  conflicting_keywords: {
    label: "Keywords disagree",
    explain: "Keywords for more than one status were found in this email.",
  },
  status_mismatch: {
    label: "Doesn't fit the current status",
    explain: "It would change a job that is already closed, or it is older than the job.",
  },
  bulk_mail: {
    label: "Sent as a mass mailing",
    explain: "It came with newsletter headers, so it changes nothing until you confirm it.",
  },
};
