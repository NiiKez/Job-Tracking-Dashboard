-- 0002_inbox.sql: Gmail ingest (docs/plan/2-gmail-ingest.md, "What is stored").
--
-- Follows 0001_core.sql's conventions. Safe while the previous release still runs: new tables,
-- new nullable or defaulted columns, and a widened check only.

-- The mailbox connection of a user: at most one per user. Disconnect keeps the row (status
-- 'disconnected', token deleted), so the ledger and the sync position stay and connecting again
-- continues without duplicates.
CREATE TABLE inbox_connections (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  google_sub text NOT NULL, -- the Google account the token belongs to: must be the signed-in user's
  email_address text NOT NULL, -- the mailbox, from users.getProfile; lower case
  status text NOT NULL,
  -- The demo inbox (MAIL_SOURCE=fixture, repo.ts ensureDemoConnection): the sync position, the
  -- scan and last_sync_ok_at belong to the demo mail in fixtures/mail, not to a Gmail mailbox, and
  -- there is no token. Switching either way (ensureDemoConnection on a Gmail row, saveConnection
  -- on a demo row) starts over with a first scan; the ledger and the linked mail stay.
  demo boolean NOT NULL DEFAULT false,
  -- The Gmail refresh token, AES-256-GCM: "v1.<key id>.<iv>.<ciphertext and tag>"
  -- (oauth/token-crypto.ts). NULL after Disconnect. Access tokens live in memory only.
  refresh_token_enc text,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  -- The sync position: Gmail's history id, stored before the first scan lists anything so mail
  -- arriving during the scan is picked up afterwards. NULL until the first scan starts.
  history_id text,
  -- The first scan (and a full re-scan after an expired position): `after` is fixed when the
  -- scan starts, so a restart lists the same window again and the ledger skips what is done.
  backfill_state text NOT NULL DEFAULT 'pending',
  backfill_after timestamptz,
  backfill_total integer, -- messages listed; NULL until listed
  backfill_done integer NOT NULL DEFAULT 0,
  last_sync_ok_at timestamptz,
  next_sync_at timestamptz, -- when the scheduler runs it next; NULL: not scheduled
  last_error_code text, -- a stable code (sync/errors.ts), never Google's text
  last_error_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  -- One sync per connection at a time, across restarts: taken with
  -- UPDATE ... WHERE lease_until IS NULL OR lease_until < now(), renewed while running.
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT inbox_connections_user_id_key UNIQUE (user_id),
  CONSTRAINT inbox_connections_google_sub_check CHECK (google_sub <> '' AND char_length(google_sub) <= 255),
  CONSTRAINT inbox_connections_email_address_check CHECK (
    email_address = lower(btrim(email_address)) AND email_address LIKE '_%@_%' AND char_length(email_address) <= 320
  ),
  CONSTRAINT inbox_connections_status_check CHECK (status IN ('connected', 'needs_reconnect', 'disconnected')),
  -- A disconnected row keeps no token.
  CONSTRAINT inbox_connections_refresh_token_enc_check CHECK (
    status <> 'disconnected' OR refresh_token_enc IS NULL
  ),
  -- Nor does a demo row, so Disconnect in demo mode never revokes a real grant at Google.
  CONSTRAINT inbox_connections_demo_check CHECK (NOT demo OR refresh_token_enc IS NULL),
  CONSTRAINT inbox_connections_granted_scopes_check CHECK (array_position(granted_scopes, NULL) IS NULL),
  CONSTRAINT inbox_connections_backfill_state_check CHECK (backfill_state IN ('pending', 'running', 'done')),
  CONSTRAINT inbox_connections_backfill_total_check CHECK (backfill_total >= 0),
  CONSTRAINT inbox_connections_backfill_done_check CHECK (backfill_done >= 0),
  CONSTRAINT inbox_connections_consecutive_failures_check CHECK (consecutive_failures >= 0),
  CONSTRAINT inbox_connections_lease_owner_lease_until_check CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
);
-- The scheduler's question across all users ("which connections are due?"): the one index that
-- does not start with user_id, on purpose.
CREATE INDEX inbox_connections_status_next_sync_at_idx ON inbox_connections (status, next_sync_at);

-- The ledger: every Gmail message the app has looked at, so nothing is processed twice. For mail
-- that is not job related this row is all that is kept: no sender, subject or text.
--   ignored  not job related
--   stored   kept as an email (job related)
--   skipped  sent, draft, spam, trash, chat, from the own address, or gone (404)
--   retry    failed in a run; `attempts` counts the runs. Retried by the next run. Not cleaned
--            up while runs still look at it: the count must reach "failed", or the position
--            would wait forever.
--   failed   failed in three runs; given up, so the sync position can move on
CREATE TABLE inbox_seen_messages (
  user_id uuid NOT NULL,
  gmail_message_id text NOT NULL,
  result text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  internal_date timestamptz, -- Gmail's received time; NULL when the message could not be read
  seen_at timestamptz NOT NULL DEFAULT now(), -- last time a run looked at it
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_seen_messages_pkey PRIMARY KEY (user_id, gmail_message_id),
  CONSTRAINT inbox_seen_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT inbox_seen_messages_gmail_message_id_check CHECK (
    gmail_message_id <> '' AND char_length(gmail_message_id) <= 64
  ),
  CONSTRAINT inbox_seen_messages_result_check CHECK (result IN ('ignored', 'stored', 'skipped', 'retry', 'failed')),
  CONSTRAINT inbox_seen_messages_attempts_check CHECK (attempts >= 0)
);
-- Clean-up: rows older than 90 days (by internal_date, else seen_at) are deleted, except "retry"
-- rows a run looked at (seen_at) in those 90 days: after every successful sync of the user, and
-- every 6 hours by the scheduler for every user, also once the mailbox is disconnected. A scan
-- never reaches back that far (30 days), and stored mail is also guarded by
-- emails_user_id_gmail_message_id_key.
CREATE INDEX inbox_seen_messages_user_id_internal_date_idx ON inbox_seen_messages (user_id, internal_date);

-- Job-related mail from Gmail. Mail from the seed or the rule tester has no Gmail ids (NULL, and
-- NULLs never collide in the unique key).
ALTER TABLE emails
  ADD COLUMN gmail_message_id text,
  ADD COLUMN gmail_thread_id text,
  ADD COLUMN body_truncated boolean NOT NULL DEFAULT false, -- body cut at 20,000 characters
  ADD CONSTRAINT emails_user_id_gmail_message_id_key UNIQUE (user_id, gmail_message_id),
  ADD CONSTRAINT emails_gmail_message_id_check CHECK (gmail_message_id <> '' AND char_length(gmail_message_id) <= 64),
  ADD CONSTRAINT emails_gmail_thread_id_check CHECK (gmail_thread_id <> '' AND char_length(gmail_thread_id) <= 64);
-- "A reply in a thread already linked to a job goes to that job."
CREATE INDEX emails_user_id_gmail_thread_id_idx ON emails (user_id, gmail_thread_id);
-- "This sender was linked to this job before."
CREATE INDEX emails_user_id_from_address_idx ON emails (user_id, from_address);

-- The new review reasons "Doesn't fit the current status" and "Sent as a mass mailing"
-- (src/lib/types.ts ReviewReason).
ALTER TABLE emails
  DROP CONSTRAINT emails_review_reason_check,
  ADD CONSTRAINT emails_review_reason_check CHECK (
    review_reason IN ('ambiguous_job', 'unknown_job', 'no_keyword', 'conflicting_keywords', 'status_mismatch', 'bulk_mail')
  );
