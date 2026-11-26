-- 0005_job_priority.sql: a priority per job (High, Medium, Low), set by hand in the dashboard or
-- the extension popup. Inside each stage the dashboard puts higher priority first.
--
-- Safe while the previous release still runs: a new column with a default, which the old
-- release neither reads nor writes, so its inserts get 'medium'.
ALTER TABLE jobs ADD COLUMN priority text NOT NULL DEFAULT 'medium';
ALTER TABLE jobs ADD CONSTRAINT jobs_priority_check CHECK (priority IN ('high', 'medium', 'low'));
