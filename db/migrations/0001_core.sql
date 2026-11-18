-- 0001_core.sql: the core tables (docs/plan/1-backend-core.md, "Data model").
--
-- Conventions (area 2 follows them too):
-- - Plural snake_case tables. `id uuid PRIMARY KEY DEFAULT uuidv7()`: built into PostgreSQL 18.
-- - Every table has user_id -> users(id) ON DELETE CASCADE, and every index starts with user_id.
-- - A child points at its parent with the composite key (user_id, parent_id), so it can never
--   point at another user's row. Parents have UNIQUE (user_id, id) as the target.
-- - timestamptz only. text with a CHECK instead of enum types. created_at everywhere.
-- - Constraint names: <table>_<columns>_{key,idx,check,fkey}. Code matches on them
--   (isUniqueViolation), and later migrations drop and re-create checks by name.
-- - The value lists in the CHECKs mirror src/lib/types.ts. Adding a value there needs a migration
--   that replaces the check.
-- - No triggers: the app writes updated_at and the derived key columns itself.

-- One row per Google account that has signed in. Created by the first sign-in.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  google_sub text NOT NULL, -- the ID token's `sub`: Google's stable account id
  email text NOT NULL, -- lower case, as the allowlist compares it
  name text NOT NULL DEFAULT '',
  picture_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_google_sub_key UNIQUE (google_sub),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_google_sub_check CHECK (google_sub <> '' AND char_length(google_sub) <= 255),
  CONSTRAINT users_email_check CHECK (
    email = lower(btrim(email)) AND email LIKE '_%@_%' AND char_length(email) <= 320
  )
);

-- Sign-in sessions. The cookie holds a random 256-bit token and only its SHA-256 is stored here,
-- so a copy of this table cannot be replayed as cookies.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT sessions_token_hash_check CHECK (octet_length(token_hash) = 32)
);
-- Sign-out everywhere, and the cascade when a user is deleted.
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  company text NOT NULL,
  location text NOT NULL DEFAULT '',
  url text,
  description text NOT NULL DEFAULT '',
  -- Keys from jobKeys() in src/lib/domain/normalize.ts, rewritten whenever url, company or title
  -- change. Changing slug() or normalizeUrl() needs a script that recomputes them.
  url_norm text, -- dedupe by link: unique per user
  company_slug text NOT NULL, -- dedupe by company and title: a lookup only, never unique
  title_norm text NOT NULL,
  search_text text NOT NULL, -- normalize(company || ' ' || title), searched with an escaped LIKE
  -- The current status. One function writes these, together with a job_status_events row.
  status text NOT NULL,
  status_source text NOT NULL,
  status_locked boolean NOT NULL DEFAULT false, -- set by a manual change: email no longer moves the job
  capture_method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(), -- last status change or linked email
  next_interview_at timestamptz,
  next_interview_round text, -- may be ''; set and cleared together with next_interview_at
  offer_deadline timestamptz,
  CONSTRAINT jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT jobs_user_id_id_key UNIQUE (user_id, id),
  -- Limits as in jobInputSchema (src/lib/server/schemas.ts). Values guessed from mail must be
  -- cut to fit before they are written.
  CONSTRAINT jobs_title_check CHECK (btrim(title) <> '' AND char_length(title) <= 200),
  CONSTRAINT jobs_company_check CHECK (btrim(company) <> '' AND char_length(company) <= 200),
  CONSTRAINT jobs_location_check CHECK (char_length(location) <= 200),
  CONSTRAINT jobs_url_check CHECK (url <> ''),
  CONSTRAINT jobs_description_check CHECK (char_length(description) <= 50000),
  -- A link key needs a link. An empty key would make every such job collide in
  -- jobs_user_id_url_norm_key, so it is stored as NULL instead.
  CONSTRAINT jobs_url_norm_check CHECK (url_norm IS NULL OR (url IS NOT NULL AND url_norm <> '')),
  CONSTRAINT jobs_status_check CHECK (
    status IN ('saved', 'applied', 'interview', 'offer', 'rejected', 'no_response')
  ),
  CONSTRAINT jobs_status_source_check CHECK (
    status_source IN ('extension', 'paste', 'manual', 'email', 'review', 'time')
  ),
  CONSTRAINT jobs_capture_method_check CHECK (capture_method IN ('extension', 'paste', 'email')),
  CONSTRAINT jobs_next_interview_at_next_interview_round_check CHECK (
    (next_interview_at IS NULL) = (next_interview_round IS NULL)
  ),
  CONSTRAINT jobs_next_interview_round_check CHECK (char_length(next_interview_round) <= 80)
);
-- Partial: jobs without a link never collide.
CREATE UNIQUE INDEX jobs_user_id_url_norm_key ON jobs (user_id, url_norm) WHERE url_norm IS NOT NULL;
CREATE INDEX jobs_user_id_company_slug_title_norm_idx ON jobs (user_id, company_slug, title_norm);
-- The job list's order.
CREATE INDEX jobs_user_id_last_activity_at_idx ON jobs (user_id, last_activity_at DESC);

-- Job-related mail and what the pipeline decided about it (the Email type).
CREATE TABLE emails (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  job_id uuid, -- the linked job; NULL until linked, and after the job is deleted
  from_name text NOT NULL DEFAULT '',
  from_address text NOT NULL DEFAULT '',
  subject text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  received_at timestamptz NOT NULL,
  language text NOT NULL DEFAULT '',
  outcome text NOT NULL,
  detected_status text, -- the status the keyword rules picked
  matched_keywords text[] NOT NULL DEFAULT '{}',
  -- Email.statusChange: the change applied. change_from is NULL when the email created the job.
  change_from text,
  change_to text,
  review_reason text,
  -- Best first. Arrays cannot have a foreign key, so readers drop ids that no longer exist.
  suggested_job_ids uuid[] NOT NULL DEFAULT '{}',
  suggested_status text,
  confidence double precision NOT NULL, -- 0..1, how sure the matcher was
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT emails_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT emails_user_id_id_key UNIQUE (user_id, id),
  -- Deleting the job keeps its mail. The column list clears job_id only, so user_id stays set.
  CONSTRAINT emails_user_id_job_id_fkey FOREIGN KEY (user_id, job_id)
    REFERENCES jobs (user_id, id) ON DELETE SET NULL (job_id),
  CONSTRAINT emails_outcome_check CHECK (
    outcome IN ('matched', 'created', 'ignored', 'review', 'resolved', 'dismissed')
  ),
  CONSTRAINT emails_detected_status_check CHECK (
    detected_status IN ('saved', 'applied', 'interview', 'offer', 'rejected', 'no_response')
  ),
  CONSTRAINT emails_change_from_check CHECK (
    change_from IN ('saved', 'applied', 'interview', 'offer', 'rejected', 'no_response')
  ),
  CONSTRAINT emails_change_to_check CHECK (
    change_to IN ('saved', 'applied', 'interview', 'offer', 'rejected', 'no_response')
  ),
  -- statusChange is { from, to } or null as a whole.
  CONSTRAINT emails_change_from_change_to_check CHECK (change_from IS NULL OR change_to IS NOT NULL),
  -- Area 2 adds a reason: its migration drops and re-creates this check under the same name.
  CONSTRAINT emails_review_reason_check CHECK (
    review_reason IN ('ambiguous_job', 'unknown_job', 'no_keyword', 'conflicting_keywords')
  ),
  CONSTRAINT emails_suggested_status_check CHECK (
    suggested_status IN ('saved', 'applied', 'interview', 'offer', 'rejected', 'no_response')
  ),
  CONSTRAINT emails_confidence_check CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT emails_matched_keywords_check CHECK (array_position(matched_keywords, NULL) IS NULL),
  CONSTRAINT emails_suggested_job_ids_check CHECK (array_position(suggested_job_ids, NULL) IS NULL)
);
-- The Activity list's order.
CREATE INDEX emails_user_id_received_at_idx ON emails (user_id, received_at DESC);
-- The review list and its count.
CREATE INDEX emails_user_id_outcome_idx ON emails (user_id, outcome);
-- A job's mail and its count, and the scan when a job is deleted.
CREATE INDEX emails_user_id_job_id_idx ON emails (user_id, job_id);

-- Status history of each job. The current status lives on jobs; this records how it got there.
CREATE TABLE job_status_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL,
  from_status text, -- NULL for the event that created the job
  to_status text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  email_id uuid, -- the email that caused the change, if any
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_status_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT job_status_events_user_id_job_id_fkey FOREIGN KEY (user_id, job_id)
    REFERENCES jobs (user_id, id) ON DELETE CASCADE,
  -- Deleting the email keeps the event and clears email_id only.
  CONSTRAINT job_status_events_user_id_email_id_fkey FOREIGN KEY (user_id, email_id)
    REFERENCES emails (user_id, id) ON DELETE SET NULL (email_id),
  CONSTRAINT job_status_events_from_status_check CHECK (
    from_status IN ('saved', 'applied', 'interview', 'offer', 'rejected', 'no_response')
  ),
  CONSTRAINT job_status_events_to_status_check CHECK (
    to_status IN ('saved', 'applied', 'interview', 'offer', 'rejected', 'no_response')
  ),
  CONSTRAINT job_status_events_source_check CHECK (
    source IN ('extension', 'paste', 'manual', 'email', 'review', 'time')
  )
);
-- The history of the jobs on a page, in order; also the scan when a job is deleted.
CREATE INDEX job_status_events_user_id_job_id_at_id_idx ON job_status_events (user_id, job_id, at, id);
-- The scan when an email is deleted.
CREATE INDEX job_status_events_user_id_email_id_idx ON job_status_events (user_id, email_id);

-- The user's keyword rules. phrase_norm = normalize(phrase), so "Leider" and "leider" are one rule.
CREATE TABLE keyword_rules (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  status text NOT NULL,
  phrase text NOT NULL,
  phrase_norm text NOT NULL,
  language text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keyword_rules_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT keyword_rules_user_id_status_phrase_norm_key UNIQUE (user_id, status, phrase_norm),
  -- Rules decide only these four (KeywordRule["status"]).
  CONSTRAINT keyword_rules_status_check CHECK (status IN ('applied', 'interview', 'offer', 'rejected')),
  -- Limits as in ruleInputSchema (src/lib/server/schemas.ts).
  CONSTRAINT keyword_rules_phrase_check CHECK (char_length(btrim(phrase)) BETWEEN 2 AND 120),
  CONSTRAINT keyword_rules_phrase_norm_check CHECK (phrase_norm <> ''),
  CONSTRAINT keyword_rules_language_check CHECK (char_length(btrim(language)) BETWEEN 2 AND 5)
);

-- One row per user, created in the first sign-in's transaction. These column defaults are the
-- default settings (the mock's DEFAULT_SETTINGS); the ranges are those of settingsPatchSchema.
CREATE TABLE user_settings (
  user_id uuid PRIMARY KEY,
  no_response_days integer NOT NULL DEFAULT 30,
  create_from_confirmation boolean NOT NULL DEFAULT true,
  review_uncertain boolean NOT NULL DEFAULT true,
  languages text[] NOT NULL DEFAULT '{en,de}',
  inbox_interval_minutes integer NOT NULL DEFAULT 15,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT user_settings_no_response_days_check CHECK (no_response_days BETWEEN 7 AND 120),
  CONSTRAINT user_settings_inbox_interval_minutes_check CHECK (inbox_interval_minutes BETWEEN 5 AND 1440),
  CONSTRAINT user_settings_languages_check CHECK (array_position(languages, NULL) IS NULL)
);
