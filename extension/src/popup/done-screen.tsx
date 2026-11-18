import type { UpsertResult } from "@/lib/types";
import { Check, ExternalLink } from "lucide-react";
import { useEffect, useRef } from "react";
import type { CaptureStatus } from "./job-editor";
import { Screen, useAnnounce } from "./ui";

/**
 * Step 4: the job is in the tracker. "Saved", "Marked as applied", or "Updated" for a duplicate.
 * The focus goes to Open in tracker, so the title is said aloud through the live region.
 */
export function DoneScreen({
  result,
  status,
  origin,
}: {
  result: UpsertResult;
  status: CaptureStatus;
  origin: string;
}) {
  const announce = useAnnounce();
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => link.current?.focus(), []);
  const { job } = result;
  const title = result.duplicate ? "Updated" : status === "applied" ? "Marked as applied" : "Saved";
  useEffect(() => announce(title), [announce, title]);

  return (
    <Screen title={title}>
      <div className="done" role="status">
        <span className="done-mark" aria-hidden>
          <Check />
        </span>
        <p className="done-job">
          <span className="done-company">{job.company}</span>
          <span className="done-title">{job.title}</span>
        </p>
      </div>
      <a
        ref={link}
        className="button button-primary button-block"
        href={`${origin}/jobs/${encodeURIComponent(job.id)}`}
        target="_blank"
        rel="noreferrer"
      >
        Open in tracker
        <ExternalLink aria-hidden />
      </a>
    </Screen>
  );
}
