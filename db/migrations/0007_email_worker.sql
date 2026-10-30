-- 0007_email_worker.sql
-- Email outbox worker: delivery bookkeeping, job claims and stale-job recovery.
--
-- Additive only. Adds a table with the delivery bookkeeping the worker keeps
-- (attempts, last_error, response, sent_at), RLS so the application role can
-- see only its own organisation, an index, and a stable claim helper that
-- prevents two workers from processing the same notification.

-- Booking delivery bookkeeping. Replaces the ad-hoc `pending`/`unavailable`
-- columns in `notification_outbox` with a proper state machine.
CREATE TABLE IF NOT EXISTS email_worker_job (
  id uuid PRIMARY KEY REFERENCES notification_outbox(id) ON DELETE CASCADE,
  worker_pid int NOT NULL REFERENCES pg_catalog.pg_roles(rolname)::int ON DELETE RESTRICT,
  worker_host text NOT NULL DEFAULT '',
  claim_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'delivered', 'failed', 'expired')),
  expires_at timestamptz NOT NULL DEFAULT now() + make_interval(seconds => 300)
);

-- One stable claim per job, held for 5 minutes, refreshable by the worker
-- while it is mid-delivery. If the worker dies, the claim expires on its own.
CREATE INDEX email_worker_job_organisation_idx ON email_worker_job (worker_organisation_id);

-- RLS: the application role can only see-and-manipulate its own tenant rows.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_outbox']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL '
      'USING (organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid) '
      'WITH CHECK (organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
