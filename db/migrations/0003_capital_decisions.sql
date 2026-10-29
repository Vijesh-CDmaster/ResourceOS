-- 0003_capital_decisions.sql
-- Equipment lifecycle data and the Capital Decision Record.
--
-- All new columns are nullable or defaulted, so existing rows and existing demo
-- data are unaffected by this migration.

-- Marks a workspace that was populated by db/seed-demo.mjs. The UI labels these
-- workspaces as synthetic; real tenants keep the default false.
ALTER TABLE organizations ADD COLUMN is_demo boolean NOT NULL DEFAULT false;

-- Lifecycle / financial facts used by the capital-decision calculations.
ALTER TABLE resources
  ADD COLUMN acquired_at date,
  ADD COLUMN acquisition_cost numeric(12, 2) CHECK (acquisition_cost IS NULL OR acquisition_cost >= 0),
  ADD COLUMN replacement_cost numeric(12, 2) CHECK (replacement_cost IS NULL OR replacement_cost >= 0),
  ADD COLUMN warranty_expires_at date,
  ADD COLUMN expected_life_years numeric(4, 1) CHECK (expected_life_years IS NULL OR expected_life_years > 0),
  ADD COLUMN condition text CHECK (condition IS NULL OR condition IN ('excellent', 'good', 'fair', 'poor')),
  ADD COLUMN is_demo boolean NOT NULL DEFAULT false;

-- Repair cost and downtime per maintenance event. Downtime is the hours the
-- asset was unavailable beyond its scheduled window, as recorded by staff.
ALTER TABLE maintenance_records
  ADD COLUMN cost numeric(12, 2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  ADD COLUMN downtime_hours numeric(8, 2) NOT NULL DEFAULT 0 CHECK (downtime_hours >= 0),
  ADD COLUMN fault_category text;

CREATE TABLE capital_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  -- Snapshots so the record still reads correctly after an asset is renamed.
  asset_code text NOT NULL,
  asset_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'decided')),
  window_days int NOT NULL CHECK (window_days BETWEEN 7 AND 730),
  -- Evidence snapshot, alternative assessments, assumptions and coverage at the
  -- moment the recommendation was generated. Never recomputed in place.
  evidence jsonb NOT NULL,
  alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
  assumptions jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommended_option text NOT NULL CHECK (
    recommended_option IN ('buy_new', 'repair', 'share', 'reallocate', 'retire')
  ),
  recommendation_reason text NOT NULL,
  confidence text NOT NULL DEFAULT 'low' CHECK (confidence IN ('low', 'medium', 'high')),
  -- The human decision. The rules engine may only recommend.
  decision_option text CHECK (
    decision_option IS NULL OR decision_option IN ('buy_new', 'repair', 'share', 'reallocate', 'retire')
  ),
  decision_rationale text,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'pending' AND decision_option IS NULL AND decided_at IS NULL)
    OR (status = 'decided' AND decision_option IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX capital_decisions_org_idx ON capital_decisions (organization_id, created_at DESC);
CREATE INDEX capital_decisions_resource_idx ON capital_decisions (resource_id, created_at DESC);

ALTER TABLE capital_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON capital_decisions
  FOR ALL
  USING (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

-- Decision history is evidence: it can be created and amended by a human, but
-- not deleted. Deletion would remove the record of who approved a purchase.
CREATE FUNCTION capital_decisions_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'capital_decisions is append-only (attempted %)', TG_OP;
END $$;

CREATE TRIGGER capital_decisions_no_delete
  BEFORE DELETE ON capital_decisions
  FOR EACH ROW EXECUTE FUNCTION capital_decisions_no_delete();
