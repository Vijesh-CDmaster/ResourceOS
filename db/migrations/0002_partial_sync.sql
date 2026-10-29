-- 0002_partial_sync.sql
-- A run that stops at the page cap has not finished the feed. Record it as
-- 'partial' with an explanation, instead of reporting success and silently
-- leaving records unread.
ALTER TABLE integration_sync_runs
  DROP CONSTRAINT IF EXISTS integration_sync_runs_status_check;

ALTER TABLE integration_sync_runs
  ADD CONSTRAINT integration_sync_runs_status_check
  CHECK (status IN ('running', 'succeeded', 'failed', 'partial'));

-- Operator-facing explanation for a partial or notable run.
ALTER TABLE integration_sync_runs ADD COLUMN IF NOT EXISTS note text;
