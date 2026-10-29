-- 0001_integrations.sql
-- Integration foundation: connections, external ID mappings, sync runs,
-- quarantine and source provenance on imported entities.
--
-- Applied by db/migrate.mjs after the baseline schema. Every table is
-- tenant-owned and carries the same RLS policy as the rest of the schema,
-- because db/schema.sql's policy loop only covers its own table list.

CREATE TABLE integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  -- Non-secret provider settings: endpoint, field map, page size.
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- AES-256-GCM sealed JSON. Never selected by UI queries.
  credentials_ciphertext text,
  credentials_rotated_at timestamptz,
  -- Opaque connector cursor. Resume point for incremental sync.
  checkpoint text,
  last_synced_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  UNIQUE (organization_id, provider, name)
);
CREATE INDEX integration_connections_org_idx
  ON integration_connections (organization_id, status, created_at DESC);

CREATE TABLE integration_entity_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('resource', 'booking')),
  external_id text NOT NULL,
  internal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The idempotency key: one external record maps to at most one local row.
  UNIQUE (connection_id, entity_type, external_id)
);
CREATE UNIQUE INDEX integration_entity_map_internal_idx
  ON integration_entity_map (connection_id, entity_type, internal_id);
CREATE INDEX integration_entity_map_org_idx
  ON integration_entity_map (organization_id, entity_type);

CREATE TABLE integration_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'incremental' CHECK (mode IN ('incremental', 'full', 'retry')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  cursor_before text,
  cursor_after text,
  imported int NOT NULL DEFAULT 0,
  updated int NOT NULL DEFAULT 0,
  duplicates int NOT NULL DEFAULT 0,
  quarantined int NOT NULL DEFAULT 0,
  failed int NOT NULL DEFAULT 0,
  error text,
  started_by uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX integration_sync_runs_org_idx
  ON integration_sync_runs (organization_id, started_at DESC);
CREATE INDEX integration_sync_runs_connection_idx
  ON integration_sync_runs (connection_id, started_at DESC);

CREATE TABLE integration_quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  sync_run_id uuid REFERENCES integration_sync_runs(id) ON DELETE SET NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('resource', 'booking')),
  external_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('validation', 'conflict', 'error')),
  message text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts int NOT NULL DEFAULT 1 CHECK (attempts > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_run_id uuid REFERENCES integration_sync_runs(id) ON DELETE SET NULL,
  -- One open issue per record and reason; retries bump `attempts` instead of duplicating.
  UNIQUE (connection_id, entity_type, external_id, reason)
);
CREATE INDEX integration_quarantine_open_idx
  ON integration_quarantine (organization_id, resolved_at, last_seen_at DESC);

-- Provenance: an imported row always points at the connection and external id
-- that produced it, so a re-sync cannot create a second copy.
ALTER TABLE resources ADD COLUMN source_connection_id uuid
  REFERENCES integration_connections(id) ON DELETE SET NULL;
ALTER TABLE resources ADD COLUMN source_external_id text;
CREATE UNIQUE INDEX resources_source_idx
  ON resources (source_connection_id, source_external_id)
  WHERE source_external_id IS NOT NULL;

ALTER TABLE bookings ADD COLUMN source_connection_id uuid
  REFERENCES integration_connections(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN source_external_id text;
CREATE UNIQUE INDEX bookings_source_idx
  ON bookings (source_connection_id, source_external_id)
  WHERE source_external_id IS NOT NULL;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'integration_connections', 'integration_entity_map',
    'integration_sync_runs', 'integration_quarantine'
  ]
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
