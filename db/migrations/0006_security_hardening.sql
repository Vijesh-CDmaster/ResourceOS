-- Phase C security hardening. Additive only: nothing is dropped, truncated or reseeded.
--
-- 1. Durable, multi-process login throttling. The previous limiter lived in a
--    per-process Map, so a second application instance (or a restart) reset it.
--    Identifiers are stored as SHA-256 hashes so the table never holds an email
--    address or an IP in readable form.
-- 2. FORCE ROW LEVEL SECURITY on every tenant table that already has RLS. The
--    application role is not the table owner, so this changes nothing for it —
--    it removes the silent bypass that appears the moment a migration, a psql
--    session or a script connects as the owning role.

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  identifier text PRIMARY KEY,
  attempt_count int NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz
);
CREATE INDEX IF NOT EXISTS auth_login_attempts_last_idx ON auth_login_attempts (last_attempt_at);

COMMENT ON TABLE auth_login_attempts IS
  'Failed sign-in counters keyed by SHA-256 of email, address or both. No plaintext identifiers.';

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relrowsecurity
       AND NOT c.relforcerowsecurity
       AND EXISTS (
         SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name = c.relname
            AND col.column_name = 'organization_id'
       )
  LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    RAISE NOTICE 'RLS forced on %', t;
  END LOOP;
END $$;
