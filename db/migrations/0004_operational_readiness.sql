-- 0004_operational_readiness.sql
-- Operational readiness: calibration records, consumables and stock movements.
--
-- Additive only. Nothing existing is dropped or rewritten; the only change to an
-- existing object is widening the unmet-demand reason list so a booking refused
-- by the readiness engine can be recorded (previously such a refusal would have
-- violated the CHECK constraint).
--
-- Every new table is tenant-owned and receives the same RLS policy as the rest of
-- the schema. db/schema.sql's policy loop only covers its own table list, so the
-- policy is declared here too.

-- --------------------------------------------------------------------------
-- Calibration
-- --------------------------------------------------------------------------
CREATE TABLE calibration_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  performed_on date NOT NULL,
  valid_until date NOT NULL,
  result text NOT NULL DEFAULT 'pass' CHECK (result IN ('pass', 'conditional', 'fail')),
  provider text NOT NULL DEFAULT '',
  certificate_ref text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until >= performed_on)
);
CREATE INDEX calibration_records_resource_idx
  ON calibration_records (resource_id, valid_until DESC);
CREATE INDEX calibration_records_org_idx
  ON calibration_records (organization_id, valid_until DESC);

ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS requires_calibration boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS calibration_interval_days int;

ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_calibration_interval_check;
ALTER TABLE resources ADD CONSTRAINT resources_calibration_interval_check
  CHECK (calibration_interval_days IS NULL OR calibration_interval_days > 0);

-- --------------------------------------------------------------------------
-- Consumables and stock
-- --------------------------------------------------------------------------
CREATE TABLE consumables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'unit',
  -- numeric, not float: stock and money must not drift
  stock numeric(12, 2) NOT NULL DEFAULT 0 CHECK (stock >= 0),
  min_stock numeric(12, 2) NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  supplier text NOT NULL DEFAULT '',
  purchase_ref text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
CREATE INDEX consumables_org_idx ON consumables (organization_id, name);

CREATE TABLE resource_consumables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  consumable_id uuid NOT NULL REFERENCES consumables(id) ON DELETE CASCADE,
  qty_per_session numeric(12, 2) NOT NULL DEFAULT 1 CHECK (qty_per_session > 0),
  mandatory boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_id, consumable_id)
);
CREATE INDEX resource_consumables_resource_idx ON resource_consumables (resource_id);

CREATE TABLE consumable_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  consumable_id uuid NOT NULL REFERENCES consumables(id) ON DELETE CASCADE,
  delta numeric(12, 2) NOT NULL CHECK (delta <> 0),
  reason text NOT NULL CHECK (reason IN ('purchase', 'adjustment', 'consumption', 'reversal')),
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  note text NOT NULL DEFAULT '',
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consumable_movements_consumable_idx
  ON consumable_movements (consumable_id, created_at DESC);

-- One consumption row per booking per consumable. A retried or double-submitted
-- check-in therefore cannot deduct stock twice, even if the request races itself.
CREATE UNIQUE INDEX consumable_movements_once_per_booking
  ON consumable_movements (booking_id, consumable_id)
  WHERE booking_id IS NOT NULL AND reason = 'consumption';

-- --------------------------------------------------------------------------
-- Unmet demand can now record a readiness refusal
-- --------------------------------------------------------------------------
ALTER TABLE unmet_demand_events DROP CONSTRAINT IF EXISTS unmet_demand_events_reason_check;
ALTER TABLE unmet_demand_events ADD CONSTRAINT unmet_demand_events_reason_check
  CHECK (reason IN (
    'conflict', 'no_training', 'quota', 'blackout', 'resource_down',
    'approval_rejected', 'not_ready'
  ));

-- --------------------------------------------------------------------------
-- Tenant isolation for the new tables
-- --------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'calibration_records', 'consumables', 'resource_consumables', 'consumable_movements'
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
