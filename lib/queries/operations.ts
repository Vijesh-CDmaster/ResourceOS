import "server-only";
import { withOrg } from "../db";

export type MaintenanceItem = {
  id: string;
  resourceId: string;
  resourceCode: string;
  resourceName: string;
  title: string;
  description: string;
  status: "scheduled" | "in_progress" | "resolved";
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  createdByName: string | null;
  blackoutId: string | null;
  blackoutStart: Date | null;
  blackoutEnd: Date | null;
};

export type IncidentItem = {
  id: string;
  resourceId: string;
  resourceCode: string;
  resourceName: string;
  bookingId: string | null;
  severity: "low" | "medium" | "high";
  status: "open" | "investigating" | "resolved";
  title: string;
  description: string;
  resolution: string | null;
  reportedByName: string;
  createdAt: Date;
  resolvedAt: Date | null;
};

export async function listMaintenance(organizationId: string): Promise<MaintenanceItem[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      resource_id: string;
      resource_code: string;
      resource_name: string;
      title: string;
      description: string;
      status: MaintenanceItem["status"];
      scheduled_start: Date | null;
      scheduled_end: Date | null;
      resolved_at: Date | null;
      created_at: Date;
      created_by_name: string | null;
      blackout_id: string | null;
      blackout_start: Date | null;
      blackout_end: Date | null;
    }>(
      `SELECT m.id, m.resource_id, r.code AS resource_code, r.name AS resource_name, m.title,
              m.description, m.status, m.scheduled_start, m.scheduled_end, m.resolved_at, m.created_at,
              u.name AS created_by_name, bp.id AS blackout_id, bp.starts_at AS blackout_start, bp.ends_at AS blackout_end
         FROM maintenance_records m
         JOIN resources r ON r.id = m.resource_id
         LEFT JOIN users u ON u.id = m.created_by
         LEFT JOIN blackout_periods bp ON bp.maintenance_id = m.id
        ORDER BY CASE m.status WHEN 'in_progress' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
                 m.created_at DESC
        LIMIT 40`,
    );
    return rows.map((row) => ({
      id: row.id,
      resourceId: row.resource_id,
      resourceCode: row.resource_code,
      resourceName: row.resource_name,
      title: row.title,
      description: row.description,
      status: row.status,
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
      createdByName: row.created_by_name,
      blackoutId: row.blackout_id,
      blackoutStart: row.blackout_start,
      blackoutEnd: row.blackout_end,
    }));
  });
}

export async function listIncidents(organizationId: string): Promise<IncidentItem[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      resource_id: string;
      resource_code: string;
      resource_name: string;
      booking_id: string | null;
      severity: IncidentItem["severity"];
      status: IncidentItem["status"];
      title: string;
      description: string;
      resolution: string | null;
      reporter_name: string;
      created_at: Date;
      resolved_at: Date | null;
    }>(
      `SELECT i.id, i.resource_id, r.code AS resource_code, r.name AS resource_name, i.booking_id,
              i.severity, i.status, i.title, i.description, i.resolution,
              u.name AS reporter_name, i.created_at, i.resolved_at
         FROM incidents i
         JOIN resources r ON r.id = i.resource_id
         JOIN users u ON u.id = i.reported_by
        ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 ELSE 2 END,
                 i.created_at DESC
        LIMIT 50`,
    );
    return rows.map((row) => ({
      id: row.id,
      resourceId: row.resource_id,
      resourceCode: row.resource_code,
      resourceName: row.resource_name,
      bookingId: row.booking_id,
      severity: row.severity,
      status: row.status,
      title: row.title,
      description: row.description,
      resolution: row.resolution,
      reportedByName: row.reporter_name,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    }));
  });
}

export type UpcomingBlackout = {
  id: string;
  resourceCode: string;
  resourceName: string;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  kind: string;
};

export async function listUpcomingBlackouts(organizationId: string): Promise<UpcomingBlackout[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      resource_code: string;
      resource_name: string;
      starts_at: Date;
      ends_at: Date;
      reason: string;
      kind: string;
    }>(
      `SELECT bp.id, r.code AS resource_code, r.name AS resource_name, bp.starts_at, bp.ends_at, bp.reason, bp.kind
         FROM blackout_periods bp JOIN resources r ON r.id = bp.resource_id
        WHERE bp.ends_at > now()
        ORDER BY bp.starts_at LIMIT 15`,
    );
    return rows.map((row) => ({
      id: row.id,
      resourceCode: row.resource_code,
      resourceName: row.resource_name,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      reason: row.reason,
      kind: row.kind,
    }));
  });
}

export async function countOverlappingBookings(
  organizationId: string,
  resourceId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<number> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM bookings
        WHERE resource_id = $1 AND status IN ('requested','confirmed')
          AND tstzrange(starts_at, ends_at) && tstzrange($2, $3)`,
      [resourceId, startsAt, endsAt],
    );
    return rows[0]?.count ?? 0;
  });
}
