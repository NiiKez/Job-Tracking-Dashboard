-- 0004_extension_keys.sql: the Chrome extension's keys (docs/plan/4-chrome-extension.md).
--
-- The extension cannot use the session cookie: its requests come from chrome-extension://, not
-- from the app's origin. Connecting a browser (the /extension/connect page) makes a key for it
-- instead: "jtx_" and 32 random bytes, which the extension sends as `Authorization: Bearer`.
-- As with sessions, only the SHA-256 of those bytes is stored, so a copy of this table cannot be
-- replayed as keys. A key does not expire; Settings revokes it, and so does Disconnect in the
-- popup. The label names the browser ("Chrome on Linux"); last_used_at is moved at most every
-- few minutes (src/lib/server/auth/extension-key.ts) and is NULL until the first use.
--
-- Safe while the previous release still runs: a new table that it does not know.
CREATE TABLE extension_keys (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT extension_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT extension_keys_token_hash_key UNIQUE (token_hash),
  CONSTRAINT extension_keys_token_hash_check CHECK (octet_length(token_hash) = 32),
  CONSTRAINT extension_keys_label_check CHECK (label <> '' AND char_length(label) <= 80)
);
-- Settings' list, the 20-key limit, and the cascade when a user is deleted.
CREATE INDEX extension_keys_user_id_idx ON extension_keys (user_id);
