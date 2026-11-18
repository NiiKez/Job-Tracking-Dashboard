import { JOB_FIELD_ORDER, type JobFieldName, type JobFieldValues } from "@/components/add-job/job-form";
import { useJobFields } from "@/components/add-job/use-job-fields";
import { formatDate } from "@/lib/format";
import { statusSince } from "@/lib/stages";
import { STATUS_META } from "@/lib/status";
import type { Job, UpsertResult } from "@/lib/types";
import { Bookmark, Info, Send } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { isDisconnected, type Api } from "../lib/api";
import { clearDraft, saveDraft } from "../lib/storage";
import type { TargetTab } from "../lib/tab";
import { DescriptionField, TextField } from "./fields";
import { draftAddress, readJob, type ReadOutcome } from "./read-job";
import { ErrorNotice, MOD_KEY, ScreenHeader, Spinner, useAnnounce } from "./ui";

/*
 * Step 3 of the popup: the fields as read, to correct, and the two ways to save.
 *
 * Keys: Enter in a one-line field saves as Saved (the default button, and the safe choice: it
 * never claims an application was sent). Ctrl+Enter (⌘+Enter on a Mac), anywhere in the form,
 * saves as Applied, as Ctrl+Enter submits the app's add-job dialog. Both buttons show their key.
 *
 * Edits are kept as a draft for this tab and page (storage.ts) while the popup is open, so
 * Escape or a click outside, which close a popup, lose nothing: opening it again on the same page
 * brings them back over a fresh read.
 *
 * A read or save that failed because the tracker's site access was withdrawn offers Allow access,
 * which asks Chrome again and then reads or saves again. Chrome's prompt may close the popup; the
 * draft keeps the edits for the next opening then.
 */

export type CaptureStatus = "saved" | "applied";

/** "Already in your tracker: Applied, 14 Nov. Saving updates it.", and where the fields come from. */
function DuplicateNotice({ job }: { job: Job }) {
  return (
    <div className="notice notice-attention">
      <Info aria-hidden />
      <div className="notice-content">
        <p>
          Already in your tracker: <strong>{STATUS_META[job.status].label}</strong>,{" "}
          <span className="tabular">{formatDate(statusSince(job))}</span>. Saving updates it.
        </p>
        <p className="notice-detail">The fields show what the tracker has; empty ones come from this page.</p>
      </div>
    </div>
  );
}

export function JobEditor({
  api,
  tab,
  read: firstRead,
  onSaved,
  onDisconnected,
}: {
  api: Api;
  tab: TargetTab | null;
  read: ReadOutcome;
  onSaved: (result: UpsertResult, status: CaptureStatus) => void;
  onDisconnected: () => void;
}) {
  const announce = useAnnounce();
  const fields = useJobFields(firstRead.values);
  const [read, setRead] = useState(firstRead);
  const [rereading, setRereading] = useState(false);
  const [saving, setSaving] = useState<CaptureStatus | null>(null);
  const [saveError, setSaveError] = useState<{ error: unknown; status: CaptureStatus } | null>(null);
  const busy = useRef(false);
  // The values as last rendered: an answer that comes in later must see what was typed meanwhile.
  const latest = useRef(fields.values);
  useLayoutEffect(() => {
    latest.current = fields.values;
  }, [fields.values]);

  // Keep what differs from the read as this page's draft.
  const address = draftAddress(tab);
  useEffect(() => {
    if (!tab || !address) return;
    const edits: Partial<JobFieldValues> = {};
    for (const name of JOB_FIELD_ORDER) {
      if (fields.values[name] !== read.initial[name]) edits[name] = fields.values[name];
    }
    void saveDraft(tab.id, { url: address, edits });
  }, [fields.values, read.initial, tab, address]);

  // Start on Title (from where Enter or Ctrl+Enter saves), or on Company when only that is missing.
  const focusField =
    firstRead.values.title.trim() && !firstRead.values.company.trim() ? "company" : "title";

  /**
   * Reads the page again after a failure; fields the user changed keep their text. The form stays
   * open while the page is read, so that is decided when the answer comes, on the values then:
   * a field is replaced only while it still holds what the earlier read gave.
   */
  async function reread() {
    if (rereading) return;
    setRereading(true);
    announce("Reading the page again");
    const base = read.initial;
    try {
      const next = await readJob(api, tab);
      for (const name of JOB_FIELD_ORDER) {
        if (latest.current[name] === base[name]) fields.setField(name, next.initial[name]);
      }
      setRead(next);
      announce(next.notice ? "The page still couldn't be read" : "Page read. Check the details.");
    } catch (error) {
      if (isDisconnected(error)) onDisconnected();
      else setRead({ ...read, notice: { kind: "failed", error } });
    } finally {
      setRereading(false);
    }
  }

  async function save(status: CaptureStatus) {
    if (busy.current) return;
    const payload = fields.submit();
    if (!payload) {
      announce("Some fields need a fix before saving");
      return;
    }
    busy.current = true;
    setSaving(status);
    setSaveError(null);
    announce("Saving");
    try {
      const result = await api.saveJob({ ...payload, status });
      if (tab) await clearDraft(tab.id);
      onSaved(result, status);
    } catch (error) {
      if (isDisconnected(error)) onDisconnected();
      else setSaveError({ error, status });
    } finally {
      busy.current = false;
      setSaving(null);
    }
  }

  /** Asks Chrome for the tracker's site access again (within the click), then goes on. */
  function allowAccess(then: () => void) {
    void api.requestAccess().then((granted) => {
      if (granted) then();
      else announce("Access wasn't allowed");
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    void save(submitter instanceof HTMLButtonElement && submitter.value === "applied" ? "applied" : "saved");
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void save("applied");
    }
  }

  const missing = (name: JobFieldName) => read.missing.includes(name);

  return (
    <form noValidate className="screen-form" onSubmit={onSubmit} onKeyDown={onKeyDown} aria-busy={!!saving}>
      <ScreenHeader title="Check the details" />
      <main className="screen-body">
        {read.notice?.kind === "unreadable" && (
          <div className="notice">
            <Info aria-hidden />
            <p>Chrome doesn&apos;t let extensions read this page. Fill in the job yourself.</p>
          </div>
        )}
        {/* Once saving failed too, its notice below says the same and is the one that matters. */}
        {read.notice?.kind === "failed" && !saveError && (
          <ErrorNotice
            error={read.notice.error}
            detail="You can still fill in the job and save it."
            onRetry={reread}
            onAllowAccess={() => allowAccess(() => void reread())}
            retrying={rereading}
          />
        )}
        {read.duplicateOf && <DuplicateNotice job={read.duplicateOf} />}

        <TextField
          fields={fields}
          name="title"
          label="Title"
          required
          missing={missing("title")}
          placeholder="e.g. Senior Frontend Engineer"
          autoFocus={focusField === "title"}
        />
        <div className="field-row">
          <TextField
            fields={fields}
            name="company"
            label="Company"
            required
            missing={missing("company")}
            placeholder="e.g. Acme GmbH"
            autoComplete="organization"
            autoFocus={focusField === "company"}
          />
          <TextField
            fields={fields}
            name="location"
            label="Location"
            missing={missing("location")}
            placeholder="Berlin or Remote"
          />
        </div>
        <TextField
          fields={fields}
          name="url"
          label="Link"
          missing={missing("url")}
          placeholder="https://company.com/jobs/123"
          inputMode="url"
          autoComplete="url"
        />
        <DescriptionField fields={fields} missing={missing("description")} />
      </main>

      {/* Outside the scrolling part: the buttons, and why saving failed, stay in view. */}
      <div className="actions-bar">
        {saveError && (
          <ErrorNotice
            error={saveError.error}
            detail="Your edits are kept."
            onRetry={() => void save(saveError.status)}
            onAllowAccess={() => allowAccess(() => void save(saveError.status))}
            retrying={!!saving}
          />
        )}
        <div className="actions">
          {/* First in the form, so Enter in a field presses it. */}
          <button type="submit" value="saved" className="button button-outline" aria-busy={saving === "saved" || undefined}>
            {saving === "saved" ? <Spinner /> : <Bookmark aria-hidden />}
            Save
            <kbd aria-hidden>↵</kbd>
          </button>
          <button
            type="submit"
            value="applied"
            className="button button-primary"
            aria-busy={saving === "applied" || undefined}
            aria-keyshortcuts={MOD_KEY === "⌘" ? "Meta+Enter" : "Control+Enter"}
          >
            {saving === "applied" ? <Spinner /> : <Send aria-hidden />}
            Applied
            <kbd aria-hidden>{MOD_KEY} ↵</kbd>
          </button>
        </div>
      </div>
    </form>
  );
}
