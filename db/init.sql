-- Runs once when the PostgreSQL container is first created.
-- The application connects as this non-superuser role so RLS is enforced.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'resourceos_app') THEN
    CREATE ROLE resourceos_app LOGIN PASSWORD 'app_dev_password';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO resourceos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO resourceos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO resourceos_app;
