import "server-only";
import { withOrg } from "../db";
import type { AssetFacts, BookingFact, MaintenanceFact, PeerFact, UnmetFact, UsageFact } from "../capital/model";

// Every query here runs inside withOrg, so RLS scopes rows to the caller's
// institution and the explicit organization_id filters are a second guard.

export const DEFAULT_WINDOW_DAYS = 180;

export type OrganizationContext = {
  id: string;
  name: string;
  isDemo: boolean;
  openHour: number;
  closeHour: number;
};

export async function getOrganizationContext(organizationId: string): Promise<OrganizationContext | null> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{ id: string; name: string; is_demo: boolean; open_hour: number; close_hour: number }>(
      "SELECT id, name, is_demo, open_hour, close_hour FROM organizations WHERE id = $1",
      [organizationId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      isDemo: row.is_demo,
      openHour: row.open_hour,
      closeHour: row.close_hour,
    };
  });
}

export type AssetSummary = {
  id: string;
  code: string;
  name: string;
  category: string;
  status: string;
  condition: string | null;
  departmentId: string | null;
  departmentName: string | null;
  isDemo: boolean;
  acquiredAt: string | null;
  acquisitionCost: number | null;
  replacementCost: number | null;
  warrantyExpiresAt: string | null;
  expectedLifeYears: number | null;
  bookedHours: number;
  usedHours: number;
  unmetDemand: number;
  maintenanceEvents: number;
  maintenanceCost: number;
  downtimeHours: number;
  openIncidents: number;
  /** Derived below from the institute's operating window. */
  availableHours: number;
  utilisation: number | null;
  maxHoursPerBooking: number;
};

type AssetSummaryRow = {
  id: string;
  code: string;
  name: string;
  category: string;
  status: string;
  condition: string | null;
  department_id: string | null;
  department_name: string | null;
  is_demo: boolean;
  acquired_at: string | null;
  acquisition_cost: string | null;
  replacement_cost: string | null;
  warranty_expires_at: string | null;
  expected_life_years: string | null;
  max_hours_per_booking: string;
  booked_hours: string | null;
  used_hours: string | null;
  unmet_demand: string;
  maintenance_events: string;
  maintenance_cost: string | null;
  downtime_hours: string | null;
  open_incidents: string;
};

const toNumber = (value: string | number | null): number => (value === null ? 0 : Number(value));

/**
 * One row per asset with every aggregate computed from bookings, usage sessions,
 * maintenance, unmet demand and incidents in the window — nothing is hardcoded.
 */
export async function listAssetSummaries(
  organizationId: string,
  openHour: number,
  closeHour: number,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<AssetSummary[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<AssetSummaryRow>(
      `SELECT r.id, r.code, r.name, r.category, r.status, r.condition,
              r.department_id, d.name AS department_name, r.is_demo,
              r.acquired_at::text AS acquired_at,
              r.acquisition_cost::text AS acquisition_cost,
              r.replacement_cost::text AS replacement_cost,
              r.warranty_expires_at::text AS warranty_expires_at,
              r.expected_life_years::text AS expected_life_years,
              r.max_hours_per_booking::text AS max_hours_per_booking,
              bk.booked_hours,
              us.used_hours,
              COALESCE(ud.unmet_demand, 0)::text AS unmet_demand,
              COALESCE(mt.events, 0)::text AS maintenance_events,
              mt.cost::text AS maintenance_cost,
              mt.downtime::text AS downtime_hours,
              COALESCE(inc.open_incidents, 0)::text AS open_incidents
         FROM resources r
         LEFT JOIN departments d ON d.id = r.department_id
         LEFT JOIN LATERAL (
           SELECT sum(extract(epoch FROM (b.ends_at - b.starts_at)) / 3600) AS booked_hours
             FROM bookings b
            WHERE b.resource_id = r.id
              AND b.status IN ('confirmed', 'completed', 'no_show')
              AND b.starts_at >= now() - $2 * interval '1 day'
         ) bk ON true
         LEFT JOIN LATERAL (
           SELECT sum(extract(epoch FROM (s.ended_at - s.started_at)) / 3600) AS used_hours
             FROM usage_sessions s
             JOIN bookings b ON b.id = s.booking_id
            WHERE b.resource_id = r.id
              AND s.ended_at IS NOT NULL
              AND s.started_at >= now() - $2 * interval '1 day'
         ) us ON true
         LEFT JOIN LATERAL (
           SELECT sum(m.cost) AS cost, sum(m.downtime_hours) AS downtime, count(*) AS events
             FROM maintenance_records m
            WHERE m.resource_id = r.id
              AND COALESCE(m.resolved_at, m.scheduled_start, m.created_at) >= now() - $2 * interval '1 day'
         ) mt ON true
         LEFT JOIN LATERAL (
           SELECT count(*) AS unmet_demand
             FROM unmet_demand_events u
            WHERE u.resource_id = r.id
              AND u.created_at >= now() - $2 * interval '1 day'
         ) ud ON true
         LEFT JOIN LATERAL (
           SELECT count(*) AS open_incidents
             FROM incidents i
            WHERE i.resource_id = r.id AND i.status <> 'resolved'
         ) inc ON true
        WHERE r.organization_id = $1
        ORDER BY r.name`,
      [organizationId, windowDays],
    );

    const dailyHours = Math.max(0, closeHour - openHour);
    return rows.map((row) => {
      const downtimeHours = toNumber(row.downtime_hours);
      const availableHours = Math.max(0, dailyHours * windowDays - downtimeHours);
      const usedHours = toNumber(row.used_hours);
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        category: row.category,
        status: row.status,
        condition: row.condition,
        departmentId: row.department_id,
        departmentName: row.department_name,
        isDemo: row.is_demo,
        acquiredAt: row.acquired_at,
        acquisitionCost: row.acquisition_cost === null ? null : toNumber(row.acquisition_cost),
        replacementCost: row.replacement_cost === null ? null : toNumber(row.replacement_cost),
        warrantyExpiresAt: row.warranty_expires_at,
        expectedLifeYears: row.expected_life_years === null ? null : toNumber(row.expected_life_years),
        bookedHours: Math.round(toNumber(row.booked_hours)),
        usedHours: Math.round(usedHours),
        unmetDemand: toNumber(row.unmet_demand),
        maintenanceEvents: toNumber(row.maintenance_events),
        maintenanceCost: Math.round(toNumber(row.maintenance_cost)),
        downtimeHours: Math.round(downtimeHours),
        openIncidents: toNumber(row.open_incidents),
        availableHours: Math.round(availableHours),
        utilisation: availableHours > 0 ? Math.round((usedHours / availableHours) * 10_000) / 10_000 : null,
        maxHoursPerBooking: toNumber(row.max_hours_per_booking),
      };
    });
  });
}

export type DecisionListItem = {
  id: string;
  assetCode: string;
  assetName: string;
  status: "pending" | "decided";
  recommendedOption: string;
  decisionOption: string | null;
  confidence: string;
  createdAt: Date;
  decidedAt: Date | null;
  decidedByName: string | null;
  createdByName: string | null;
};

export async function listDecisions(organizationId: string, limit = 20): Promise<DecisionListItem[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      asset_code: string;
      asset_name: string;
      status: "pending" | "decided";
      recommended_option: string;
      decision_option: string | null;
      confidence: string;
      created_at: Date;
      decided_at: Date | null;
      decided_by_name: string | null;
      created_by_name: string | null;
    }>(
      `SELECT c.id, c.asset_code, c.asset_name, c.status, c.recommended_option, c.decision_option,
              c.confidence, c.created_at, c.decided_at,
              du.name AS decided_by_name, cu.name AS created_by_name
         FROM capital_decisions c
         LEFT JOIN users du ON du.id = c.decided_by
         LEFT JOIN users cu ON cu.id = c.created_by
        WHERE c.organization_id = $1
        ORDER BY c.created_at DESC
        LIMIT $2`,
      [organizationId, Math.min(100, Math.max(1, limit))],
    );
    return rows.map((row) => ({
      id: row.id,
      assetCode: row.asset_code,
      assetName: row.asset_name,
      status: row.status,
      recommendedOption: row.recommended_option,
      decisionOption: row.decision_option,
      confidence: row.confidence,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      decidedByName: row.decided_by_name,
      createdByName: row.created_by_name,
    }));
  });
}

export async function listDecisionsForResource(
  organizationId: string,
  resourceId: string,
  limit = 5,
): Promise<DecisionListItem[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      asset_code: string;
      asset_name: string;
      status: "pending" | "decided";
      recommended_option: string;
      decision_option: string | null;
      confidence: string;
      created_at: Date;
      decided_at: Date | null;
      decided_by_name: string | null;
      created_by_name: string | null;
    }>(
      `SELECT c.id, c.asset_code, c.asset_name, c.status, c.recommended_option, c.decision_option,
              c.confidence, c.created_at, c.decided_at,
              du.name AS decided_by_name, cu.name AS created_by_name
         FROM capital_decisions c
         LEFT JOIN users du ON du.id = c.decided_by
         LEFT JOIN users cu ON cu.id = c.created_by
        WHERE c.organization_id = $1 AND c.resource_id = $2
        ORDER BY c.created_at DESC
        LIMIT $3`,
      [organizationId, resourceId, Math.min(20, Math.max(1, limit))],
    );
    return rows.map((row) => ({
      id: row.id,
      assetCode: row.asset_code,
      assetName: row.asset_name,
      status: row.status,
      recommendedOption: row.recommended_option,
      decisionOption: row.decision_option,
      confidence: row.confidence,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      decidedByName: row.decided_by_name,
      createdByName: row.created_by_name,
    }));
  });
}

export type DecisionDetail = DecisionListItem & {
  resourceId: string;
  windowDays: number;
  evidence: Record<string, unknown>;
  alternatives: Array<Record<string, unknown>>;
  assumptions: Record<string, unknown>;
  recommendationReason: string;
  decisionRationale: string | null;
  isDemoAsset: boolean;
};

export async function getDecision(organizationId: string, decisionId: string): Promise<DecisionDetail | null> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      resource_id: string;
      asset_code: string;
      asset_name: string;
      status: "pending" | "decided";
      window_days: number;
      evidence: Record<string, unknown>;
      alternatives: Array<Record<string, unknown>>;
      assumptions: Record<string, unknown>;
      recommended_option: string;
      recommendation_reason: string;
      confidence: string;
      decision_option: string | null;
      decision_rationale: string | null;
      created_at: Date;
      decided_at: Date | null;
      decided_by_name: string | null;
      created_by_name: string | null;
      is_demo_asset: boolean;
    }>(
      `SELECT c.id, c.resource_id, c.asset_code, c.asset_name, c.status, c.window_days,
              c.evidence, c.alternatives, c.assumptions,
              c.recommended_option, c.recommendation_reason, c.confidence,
              c.decision_option, c.decision_rationale, c.created_at, c.decided_at,
              du.name AS decided_by_name, cu.name AS created_by_name,
              COALESCE(r.is_demo, false) AS is_demo_asset
         FROM capital_decisions c
         LEFT JOIN users du ON du.id = c.decided_by
         LEFT JOIN users cu ON cu.id = c.created_by
         LEFT JOIN resources r ON r.id = c.resource_id
        WHERE c.id = $1 AND c.organization_id = $2`,
      [decisionId, organizationId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      resourceId: row.resource_id,
      assetCode: row.asset_code,
      assetName: row.asset_name,
      status: row.status,
      windowDays: row.window_days,
      evidence: row.evidence,
      alternatives: row.alternatives,
      assumptions: row.assumptions,
      recommendedOption: row.recommended_option,
      recommendationReason: row.recommendation_reason,
      confidence: row.confidence,
      decisionOption: row.decision_option,
      decisionRationale: row.decision_rationale,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      decidedByName: row.decided_by_name,
      createdByName: row.created_by_name,
      isDemoAsset: row.is_demo_asset,
    };
  });
}

export type AssetCapitalInputs = {
  asset: AssetFacts;
  bookings: BookingFact[];
  sessions: UsageFact[];
  unmet: UnmetFact[];
  maintenance: MaintenanceFact[];
  peers: PeerFact[];
  openIncidents: number;
  maxHoursPerBooking: number;
};

/** Raw rows needed by lib/capital/model.ts. Calculations happen outside SQL. */
export async function getAssetCapitalInputs(
  organizationId: string,
  resourceId: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<AssetCapitalInputs | null> {
  return withOrg(organizationId, async (db) => {
    const assetResult = await db.query<{
      id: string;
      code: string;
      name: string;
      category: string;
      status: string;
      condition: string | null;
      department_id: string | null;
      department_name: string | null;
      facility_name: string | null;
      location: string;
      acquired_at: string | null;
      acquisition_cost: string | null;
      replacement_cost: string | null;
      warranty_expires_at: string | null;
      expected_life_years: string | null;
      max_hours_per_booking: string;
    }>(
      `SELECT r.id, r.code, r.name, r.category, r.status, r.condition,
              r.department_id, d.name AS department_name, f.name AS facility_name, r.location,
              r.acquired_at::text AS acquired_at,
              r.acquisition_cost::text AS acquisition_cost,
              r.replacement_cost::text AS replacement_cost,
              r.warranty_expires_at::text AS warranty_expires_at,
              r.expected_life_years::text AS expected_life_years,
              r.max_hours_per_booking::text AS max_hours_per_booking
         FROM resources r
         LEFT JOIN departments d ON d.id = r.department_id
         LEFT JOIN facilities f ON f.id = r.facility_id
        WHERE r.id = $1 AND r.organization_id = $2`,
      [resourceId, organizationId],
    );
    const asset = assetResult.rows[0];
    if (!asset) return null;

    const [bookings, sessions, unmet, maintenance, workOrders, peers, incidents] = await Promise.all([
      db.query<{
        status: string;
        starts_at: Date;
        ends_at: Date;
        user_id: string;
        department_id: string | null;
      }>(
        `SELECT b.status, b.starts_at, b.ends_at, b.user_id, m.department_id
           FROM bookings b
           LEFT JOIN memberships m ON m.user_id = b.user_id AND m.organization_id = b.organization_id
          WHERE b.resource_id = $1 AND b.organization_id = $2
            AND b.starts_at >= now() - $3 * interval '1 day'`,
        [resourceId, organizationId, windowDays],
      ),
      // One row per session: the model counts sessions as well as summing their
      // hours, so an aggregate here would understate recorded usage.
      db.query<{ hours: string | null }>(
        `SELECT (extract(epoch FROM (s.ended_at - s.started_at)) / 3600)::text AS hours
           FROM usage_sessions s
           JOIN bookings b ON b.id = s.booking_id
          WHERE b.resource_id = $1 AND s.organization_id = $2
            AND s.ended_at IS NOT NULL
            AND s.started_at >= now() - $3 * interval '1 day'`,
        [resourceId, organizationId, windowDays],
      ),
      db.query<{ reason: string; department_id: string | null; department_name: string | null }>(
        `SELECT u.reason, mm.department_id, d.name AS department_name
           FROM unmet_demand_events u
           LEFT JOIN memberships mm ON mm.user_id = u.user_id AND mm.organization_id = u.organization_id
           LEFT JOIN departments d ON d.id = mm.department_id
          WHERE u.resource_id = $1 AND u.organization_id = $2
            AND u.created_at >= now() - $3 * interval '1 day'`,
        [resourceId, organizationId, windowDays],
      ),
      db.query<{
        title: string;
        fault_category: string | null;
        cost: string;
        downtime_hours: string;
        status: string;
        resolved_at: Date | null;
        scheduled_start: Date | null;
      }>(
        `SELECT title, fault_category, cost::text AS cost, downtime_hours::text AS downtime_hours,
                status, resolved_at, scheduled_start
           FROM maintenance_records
          WHERE resource_id = $1 AND organization_id = $2
            AND COALESCE(resolved_at, scheduled_start, created_at) >= now() - $3 * interval '1 day'
          ORDER BY COALESCE(resolved_at, scheduled_start, created_at) DESC`,
        [resourceId, organizationId, windowDays],
      ),
      // Verified repair evidence from the work-order workflow. Only closed jobs
      // are counted: they have been released, so the repair and its downtime are
      // finished facts rather than work in progress. Estimates stay labelled as
      // estimates and are never folded into the actual figure.
      db.query<{
        code: string;
        title: string;
        actual_cost: string | null;
        estimated_cost: string | null;
        downtime_hours: string | null;
        downtime_start: Date | null;
        closed_at: Date | null;
      }>(
        `SELECT w.code, coalesce(i.title, nullif(w.diagnosis, ''), 'Repair') AS title,
                w.actual_cost::text, w.estimated_cost::text,
                (extract(epoch FROM (w.downtime_end - w.downtime_start)) / 3600)::text AS downtime_hours,
                w.downtime_start, w.closed_at
           FROM work_orders w
           LEFT JOIN incidents i ON i.id = w.incident_id
          WHERE w.resource_id = $1 AND w.organization_id = $2 AND w.status = 'closed'
            AND coalesce(w.closed_at, w.created_at) >= now() - $3 * interval '1 day'
          ORDER BY coalesce(w.closed_at, w.created_at) DESC`,
        [resourceId, organizationId, windowDays],
      ),
      db.query<{
        id: string;
        code: string;
        department_id: string | null;
        department_name: string | null;
        used_hours: string | null;
        unmet_count: string;
      }>(
        `SELECT r2.id, r2.code, r2.department_id, d2.name AS department_name,
                (SELECT sum(extract(epoch FROM (s.ended_at - s.started_at)) / 3600)
                   FROM usage_sessions s
                   JOIN bookings b2 ON b2.id = s.booking_id
                  WHERE b2.resource_id = r2.id AND s.ended_at IS NOT NULL
                    AND s.started_at >= now() - $3 * interval '1 day')::text AS used_hours,
                (SELECT count(*) FROM unmet_demand_events u2
                  WHERE u2.resource_id = r2.id
                    AND u2.created_at >= now() - $3 * interval '1 day')::text AS unmet_count
           FROM resources r2
           LEFT JOIN departments d2 ON d2.id = r2.department_id
          WHERE r2.organization_id = $1 AND r2.category = $2 AND r2.id <> $4`,
        [organizationId, asset.category, windowDays, resourceId],
      ),
      db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM incidents WHERE resource_id = $1 AND organization_id = $2 AND status <> 'resolved'",
        [resourceId, organizationId],
      ),
    ]);

    return {
      asset: {
        id: asset.id,
        code: asset.code,
        name: asset.name,
        category: asset.category,
        status: asset.status,
        condition: asset.condition,
        departmentId: asset.department_id,
        departmentName: asset.department_name,
        facilityName: asset.facility_name,
        location: asset.location,
        acquiredAt: asset.acquired_at,
        acquisitionCost: asset.acquisition_cost === null ? null : Number(asset.acquisition_cost),
        replacementCost: asset.replacement_cost === null ? null : Number(asset.replacement_cost),
        warrantyExpiresAt: asset.warranty_expires_at,
        expectedLifeYears: asset.expected_life_years === null ? null : Number(asset.expected_life_years),
      },
      bookings: bookings.rows.map((row) => ({
        status: row.status,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
        userId: row.user_id,
        departmentId: row.department_id,
      })),
      sessions: sessions.rows.map((row) => ({ hours: toNumber(row.hours) })),
      unmet: unmet.rows.map((row) => ({
        reason: row.reason,
        departmentId: row.department_id,
        departmentName: row.department_name,
      })),
      maintenance: [
        ...maintenance.rows.map((row) => ({
          title: row.title,
          faultCategory: row.fault_category,
          cost: toNumber(row.cost),
          downtimeHours: toNumber(row.downtime_hours),
          status: row.status,
          resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
          scheduledStart: row.scheduled_start ? row.scheduled_start.toISOString() : null,
          source: "maintenance_record" as const,
          costBasis: "actual" as const,
        })),
        ...workOrders.rows.map((row) => ({
          title: `${row.code} — ${row.title}`,
          faultCategory: "Work order",
          cost: toNumber(row.actual_cost ?? row.estimated_cost),
          downtimeHours: toNumber(row.downtime_hours),
          status: "resolved",
          resolvedAt: row.closed_at ? row.closed_at.toISOString() : null,
          scheduledStart: row.downtime_start ? row.downtime_start.toISOString() : null,
          source: "work_order" as const,
          costBasis:
            row.actual_cost !== null ? ("actual" as const) : row.estimated_cost !== null ? ("estimate" as const) : ("unknown" as const),
        })),
      ],
      peers: peers.rows.map((row) => ({
        id: row.id,
        code: row.code,
        departmentId: row.department_id,
        departmentName: row.department_name,
        usedHours: toNumber(row.used_hours),
        unmetCount: toNumber(row.unmet_count),
      })),
      openIncidents: toNumber(incidents.rows[0]?.count ?? 0),
      maxHoursPerBooking: toNumber(asset.max_hours_per_booking),
    };
  });
}
