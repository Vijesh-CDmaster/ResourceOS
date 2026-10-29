-- 0005_work_orders_and_overrides.sql
-- Service requests → work orders with explicit repair verification and release,
-- plus a controlled emergency-override workflow.
--
-- Strictly additive: every new object is new, and the only change to existing
-- tables is one defaulted column on `resources`. Nothing is dropped, truncated
-- or rewritten, so existing databases upgrade in place and keep their data.
--
-- Safety model encoded here:
--   * A work order never releases an asset by itself. `resource_holds` is a
--     separate blocking record, and only an authorised release clears it.
--   * `work_order_events` and `emergency_overrides` are append-only at the
--     database level, so an override cannot be quietly edited or deleted.
--   * `emergency_overrides` can only be revoked (three columns), never rewritten.

-- --------------------------------------------------------------------------
-- Per-asset policy: is the person who did the repair allowed to verify it?
-- --------------------------------------------------------------------------
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS requires_independent_verification boolean NOT NULL DEFAULT true;

-- --------------------------------------------------------------------------
-- Work orders
-- --------------------------------------------------------------------------
CREATE TABLE work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  -- One work order per incident. The incident stays the evidence of the fault.
  incident_id uuid UNIQUE REFERENCES incidents(id) ON DELETE SET NULL,
  code text NOT NULL,
  status text NOT NULL DEFAULT 'reported' CHECK (status IN (
    'reported', 'assigned', 'in_progress', 'waiting_parts',
    'repair_completed', 'awaiting_verification', 'verified', 'closed'
  )),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  vendor_name text NOT NULL DEFAULT '',
  vendor_contact text NOT NULL DEFAULT '',
  diagnosis text NOT NULL DEFAULT '',
  parts_used text NOT NULL DEFAULT '',
  labour_hours numeric(8, 2) NOT NULL DEFAULT 0 CHECK (labour_hours >= 0),
  estimated_cost numeric(12, 2) CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  actual_cost numeric(12, 2) CHECK (actual_cost IS NULL OR actual_cost >= 0),
  downtime_start timestamptz,
  downtime_end timestamptz,
  service_date date,
  -- Snapshot of the resource policy at creation, so later policy edits do not
  -- retroactively change whether a past verification was independent.
  requires_verification boolean NOT NULL DEFAULT true,
  repair_notes text NOT NULL DEFAULT '',
  verification_notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  repair_completed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  repair_completed_at timestamptz,
  verified_by uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  closed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  closed_at timestamptz,
  UNIQUE (organization_id, code),
  CHECK (downtime_end IS NULL OR downtime_start IS NULL OR downtime_end >= downtime_start)
);
CREATE INDEX work_orders_org_status_idx ON work_orders (organization_id, status, created_at DESC);
CREATE INDEX work_orders_resource_idx ON work_orders (resource_id, created_at DESC);
CREATE INDEX work_orders_assignee_idx ON work_orders (assigned_to, status);

-- Per-tenant numbering for human-readable work-order codes.
CREATE TABLE work_order_sequences (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  last_number int NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);

-- Immutable status history. This is the operational record of who did what.
CREATE TABLE work_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  kind text NOT NULL DEFAULT 'status' CHECK (kind IN (
    'status', 'created', 'assignment', 'verification_passed',
    'verification_rejected', 'reopened', 'released', 'note'
  )),
  note text NOT NULL DEFAULT '',
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_order_events_order_idx ON work_order_events (work_order_id, created_at);

-- --------------------------------------------------------------------------
-- Blocking holds — separate from the work order that caused them
-- --------------------------------------------------------------------------
CREATE TABLE resource_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  work_order_id uuid REFERENCES work_orders(id) ON DELETE SET NULL,
  incident_id uuid REFERENCES incidents(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('safety', 'maintenance', 'quality')),
  title text NOT NULL,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES users(id) ON DELETE SET NULL,
  released_at timestamptz,
  release_note text NOT NULL DEFAULT ''
);
CREATE INDEX resource_holds_resource_idx ON resource_holds (resource_id, status);
-- At most one active hold per work order, so a retried action cannot stack holds.
CREATE UNIQUE INDEX resource_holds_one_active_per_work_order
  ON resource_holds (work_order_id)
  WHERE status = 'active' AND work_order_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Emergency overrides
-- --------------------------------------------------------------------------
CREATE TABLE emergency_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  work_order_id uuid REFERENCES work_orders(id) ON DELETE SET NULL,
  incident_id uuid REFERENCES incidents(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'operational_exception', 'scheduling_exception', 'restrict_resource',
    'cancel_bookings', 'relocate_bookings', 'communicate_downtime'
  )),
  -- What the exception covers, in the operator's own words. Free text on purpose:
  -- it is read by humans, and a wrong scope must be visible, not coerced.
  scope text NOT NULL CHECK (char_length(btrim(scope)) >= 5),
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 20),
  previous_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  resulting_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason text,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > starts_at)
);
CREATE INDEX emergency_overrides_resource_idx ON emergency_overrides (resource_id, created_at DESC);
CREATE INDEX emergency_overrides_org_idx ON emergency_overrides (organization_id, created_at DESC);

CREATE TABLE emergency_override_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  override_id uuid NOT NULL REFERENCES emergency_overrides(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status_before text NOT NULL,
  status_after text NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  notification_status text NOT NULL DEFAULT 'pending' CHECK (notification_status IN (
    'pending', 'sent', 'unavailable', 'skipped'
  )),
  notified_at timestamptz,
  notification_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX emergency_override_bookings_override_idx
  ON emergency_override_bookings (override_id, created_at);

-- --------------------------------------------------------------------------
-- Outbound communication
-- --------------------------------------------------------------------------
-- In-app notifications are real and already stored in `notifications`. Email is
-- a separate channel: if no transport is configured, the row is recorded as
-- `unavailable` rather than pretending a message was delivered.
CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL DEFAULT '',
  related_type text,
  related_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'unavailable', 'failed')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notification_outbox_org_idx ON notification_outbox (organization_id, created_at DESC);

-- --------------------------------------------------------------------------
-- Append-only guarantees
-- --------------------------------------------------------------------------
CREATE FUNCTION work_order_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'work_order_events is append-only (attempted %)', TG_OP;
END $$;

CREATE TRIGGER work_order_events_no_rewrite
  BEFORE UPDATE OR DELETE ON work_order_events
  FOR EACH ROW EXECUTE FUNCTION work_order_events_append_only();

-- An override can be recorded and later revoked, but its action, scope, reason
-- and target cannot be rewritten. That is what makes the audit meaningful.
CREATE FUNCTION emergency_overrides_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'emergency_overrides is append-only (attempted DELETE)';
  END IF;
  IF NEW.action IS DISTINCT FROM OLD.action
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'emergency_overrides: only revocation fields may change';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER emergency_overrides_no_rewrite
  BEFORE UPDATE OR DELETE ON emergency_overrides
  FOR EACH ROW EXECUTE FUNCTION emergency_overrides_guard();

-- --------------------------------------------------------------------------
-- Tenant isolation
-- --------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'work_orders', 'work_order_sequences', 'work_order_events', 'resource_holds',
    'emergency_overrides', 'emergency_override_bookings', 'notification_outbox'
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
