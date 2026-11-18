import type { JobFieldName } from "@/components/add-job/job-form";
import type { JobFieldsState } from "@/components/add-job/use-job-fields";
import { ChevronDown, ChevronUp, CircleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { MAX_DESCRIPTION } from "./read-job";

/*
 * The job fields of the popup's form: the app's add-job fields (src/components/add-job/
 * job-fields.tsx) in the popup's width, with the same words and the same validation
 * (useJobFields, job-form.ts). Errors show once a field was left or Save was tried.
 */

function describedBy(...ids: Array<string | false | undefined>) {
  return ids.filter(Boolean).join(" ") || undefined;
}

function MissingHint({ id }: { id: string }) {
  return (
    <p id={id} className="hint hint-missing">
      <CircleAlert aria-hidden />
      Couldn&apos;t find this on the page. Please fill it in.
    </p>
  );
}

export function TextField({
  fields,
  name,
  label,
  required,
  missing,
  placeholder,
  autoFocus,
  inputMode,
  autoComplete = "off",
}: {
  fields: JobFieldsState;
  name: Exclude<JobFieldName, "description">;
  label: string;
  required?: boolean;
  /** The tracker couldn't find this field on the page: a hint while it is still empty. */
  missing?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  inputMode?: "url";
  autoComplete?: string;
}) {
  const id = fields.fieldId(name);
  const value = fields.values[name];
  const error = fields.errors[name];
  const showMissing = !!missing && !value.trim() && !error;
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && (
          <span aria-hidden className="required">
            *
          </span>
        )}
      </label>
      <input
        id={id}
        name={name}
        value={value}
        onChange={(event) => fields.setField(name, event.target.value)}
        onBlur={(event) => {
          // Not when a button takes the focus: an error appearing on mousedown moves the button
          // away before mouseup, and the click is lost. Save checks every field anyway.
          if (!(event.relatedTarget instanceof HTMLButtonElement)) fields.blurField(name);
        }}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={describedBy(showMissing && `${id}-missing`, error && `${id}-error`)}
        className={showMissing ? "is-missing" : undefined}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        inputMode={inputMode}
        spellCheck={name === "url" ? false : undefined}
      />
      {showMissing && <MissingHint id={`${id}-missing`} />}
      {error && (
        <p id={`${id}-error`} className="hint hint-error">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The description, collapsed to a three-line preview with its length (it is often long, and
 * rarely what needs fixing). Show opens the text box and puts the cursor in it; Hide gives the
 * focus to Show, as the Hide button itself goes away.
 */
export function DescriptionField({ fields, missing }: { fields: JobFieldsState; missing?: boolean }) {
  const id = fields.fieldId("description");
  const value = fields.values.description;
  const [expanded, setExpanded] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const showMissing = !!missing && !value.trim();
  const length = (
    <span id={`${id}-length`} className="count">
      {value.length.toLocaleString("en-US")} {value.length === 1 ? "character" : "characters"}
    </span>
  );

  const toggle = () => {
    setExpanded(!expanded);
    // Showing puts the cursor in the text box (in the DOM either way, hidden). Hiding removes the
    // Hide button that has the focus, which would drop it to the body: Show takes it instead,
    // once it is back on the next frame.
    requestAnimationFrame(() => (expanded ? showButton.current : textarea.current)?.focus());
  };

  return (
    <div className="field">
      <label htmlFor={id}>Description</label>
      {!expanded && (
        <div className="description-preview">
          {value.trim() ? (
            <p className="preview-text">{value}</p>
          ) : (
            <p className="preview-text preview-empty">No description yet.</p>
          )}
          <div className="description-bar">
            {length}
            <button
              ref={showButton}
              type="button"
              className="button button-outline button-sm"
              aria-controls={id}
              aria-expanded={false}
              onClick={toggle}
            >
              {value.trim() ? "Show description" : "Add a description"}
              <ChevronDown aria-hidden />
            </button>
          </div>
        </div>
      )}
      <textarea
        ref={textarea}
        id={id}
        name="description"
        hidden={!expanded}
        value={value}
        maxLength={MAX_DESCRIPTION}
        onChange={(event) => fields.setField("description", event.target.value)}
        aria-describedby={describedBy(`${id}-length`, showMissing && `${id}-missing`)}
        placeholder="Paste the job description, or leave it empty."
        rows={8}
      />
      {expanded && (
        <div className="description-bar">
          {length}
          <button
            type="button"
            className="button button-ghost button-sm"
            aria-controls={id}
            aria-expanded
            onClick={toggle}
          >
            Hide description
            <ChevronUp aria-hidden />
          </button>
        </div>
      )}
      {showMissing && <MissingHint id={`${id}-missing`} />}
    </div>
  );
}
