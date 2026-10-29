-- ResourceOS v1 schema (PostgreSQL 16+)
-- Tenant-owned tables carry organization_id and are protected by RLS.
-- The application connects as a non-superuser role, so RLS is enforced in addition
-- to the explicit organization_id filters in lib/db.ts.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  open_hour int NOT NULL DEFAULT 9 CHECK (open_hour BETWEEN 0 AND 23),
  close_hour int NOT NULL DEFAULT 18 CHECK (close_hour BETWEEN 1 AND 24),
  max_active_bookings int NOT NULL DEFAULT 3 CHECK (max_active_bookings > 0),
  max_horizon_days int NOT NULL DEFAULT 30 CHECK (max_horizon_days > 0),
  no_show_grace_minutes int NOT NULL DEFAULT 20 CHECK (no_show_grace_minutes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  location text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'manager', 'technician', 'member')),
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE training_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  validity_months int NOT NULL DEFAULT 12 CHECK (validity_months > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE training_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX training_records_user_idx ON training_records (organization_id, user_id, course_id, expires_at);

CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  facility_id uuid REFERENCES facilities(id) ON DELETE SET NULL,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'General',
  description text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  capacity int NOT NULL DEFAULT 1 CHECK (capacity > 0),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'maintenance', 'suspended', 'retired')),
  requires_approval boolean NOT NULL DEFAULT false,
  training_course_id uuid REFERENCES training_courses(id) ON DELETE SET NULL,
  max_hours_per_booking numeric(5, 2) NOT NULL DEFAULT 4 CHECK (max_hours_per_booking > 0),
  specs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE availability_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens_at time NOT NULL,
  closes_at time NOT NULL,
  CHECK (opens_at < closes_at),
  UNIQUE (resource_id, weekday)
);

CREATE TABLE maintenance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'resolved')),
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  resolved_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blackout_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  maintenance_id uuid REFERENCES maintenance_records(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'maintenance' CHECK (kind IN ('maintenance', 'repair', 'holiday', 'other')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX blackout_resource_time_idx ON blackout_periods (resource_id, starts_at, ends_at);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (
    status IN ('requested', 'confirmed', 'rejected', 'cancelled', 'completed', 'no_show')
  ),
  purpose text NOT NULL DEFAULT '',
  attendees int NOT NULL DEFAULT 1 CHECK (attendees > 0),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text,
  cancelled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  cancel_reason text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

-- The database — not application code — is the final arbiter of double booking.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  )
  WHERE (status IN ('requested', 'confirmed', 'completed'));

CREATE UNIQUE INDEX bookings_idempotency_idx
  ON bookings (organization_id, user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX bookings_resource_time_idx ON bookings (resource_id, starts_at, ends_at);
CREATE INDEX bookings_org_time_idx ON bookings (organization_id, starts_at DESC);
CREATE INDEX bookings_user_idx ON bookings (user_id, starts_at DESC);

CREATE TABLE usage_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  condition_note text NOT NULL DEFAULT '',
  consumables text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  reported_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  resolution text,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_org_idx ON incidents (organization_id, status, created_at DESC);

CREATE TABLE unmet_demand_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason IN ('conflict', 'no_training', 'quota', 'blackout', 'resource_down', 'approval_rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX unmet_demand_org_idx ON unmet_demand_events (organization_id, created_at DESC);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at, created_at DESC);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  summary text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_idx ON audit_events (organization_id, created_at DESC);

-- The audit trail is append-only for every role, including the application role.
-- An override can be recorded, but it cannot be quietly edited or deleted later.
CREATE FUNCTION audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (attempted %)', TG_OP;
END $$;

CREATE TRIGGER audit_events_no_rewrite
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

-- Second line of defence: even a query that forgets its tenant filter returns nothing.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'departments', 'facilities', 'training_courses', 'training_records',
    'resources', 'availability_rules', 'maintenance_records', 'blackout_periods',
    'bookings', 'usage_sessions', 'incidents', 'unmet_demand_events',
    'notifications', 'audit_events'
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
