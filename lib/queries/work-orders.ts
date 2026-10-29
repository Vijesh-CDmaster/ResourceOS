import "server-only";
import { withOrg } from "../db";
import type { WorkOrderPriority, WorkOrderStatus } from "../work-orders";

export type WorkOrderEvent = {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  kind: string;
  note: string;
  actorName: string | null;
  createdAt: Date;
};

export type WorkOrderItem = {
  id: string;
  code: string;
  status: WorkOrderStatus;
  priority: WorkOrderPriority;
  resourceId: string;
  resourceCode: string;
  resourceName: string;
  resourceStatus: string;
  incidentId: string | null;
  incidentTitle: string | null;
  incidentSeverity: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
  vendorName: string;
  vendorContact: string;
  diagnosis: string;
  repairNotes: string;
  partsUsed: string;
  labourHours: number;
  estimatedCost: number | null;
  actualCost: number | null;
  downtimeStart: Date | null;
  downtimeEnd: Date | null;
  serviceDate: string | null;
  requiresVerification: boolean;
  repairCompletedBy: string | null;
  repairCompletedByName: string | null;
  repairCompletedAt: Date | null;
  verifiedByName: string | null;
  verifiedAt: Date | null;
  verificationNotes: string;
  createdByName: string | null;
  createdAt: Date;
  closedAt: Date | null;
  activeHold: { id: string; kind: string; title: string; createdAt: Date } | null;
  history: WorkOrderEvent[];
};

type Row = {
  id: string;
  code: string;
  status: WorkOrderStatus;
  priority: WorkOrderPriority;
  resource_id: string;
  resource_code: string;
  resource_name: string;
  resource_status: string;
  incident_id: string | null;
  incident_title: string | null;
  incident_severity: string | null;
  assigned_to: string | null;
  assignee_name: string | null;
  vendor_name: string;
  vendor_contact: string;
  diagnosis: string;
  repair_notes: string;
  parts_used: string;
  labour_hours: string;
  estimated_cost: string | null;
  actual_cost: string | null;
  downtime_start: Date | null;
  downtime_end: Date | null;
  service_date: string | null;
  requires_verification: boolean;
  repair_completed_by: string | null;
  repair_completed_by_name: string | null;
  repair_completed_at: Date | null;
  verified_by_name: string | null;
  verified_at: Date | null;
  verification_notes: string;
  created_by_name: string | null;
  created_at: Date;
  closed_at: Date | null;
  hold_id: string | null;
  hold_kind: string | null;
  hold_title: string | null;
  hold_created_at: Date | null;
};

const ORDER_BY = `
  ORDER BY CASE w.status
             WHEN 'awaiting_verification' THEN 0
             WHEN 'verified' THEN 1
             WHEN 'waiting_parts' THEN 2
             WHEN 'in_progress' THEN 3
             WHEN 'assigned' THEN 4
             WHEN 'reported' THEN 5
             WHEN 'repair_completed' THEN 6
             ELSE 7
           END,
           CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           w.created_at DESC`;

const SELECT = `
  SELECT w.id, w.code, w.status, w.priority,
         w.resource_id, r.code AS resource_code, r.name AS resource_name, r.status AS resource_status,
         w.incident_id, i.title AS incident_title, i.severity AS incident_severity,
         w.assigned_to, a.name AS assignee_name, w.vendor_name, w.vendor_contact,
         w.diagnosis, w.repair_notes, w.parts_used, w.labour_hours::text,
         w.estimated_cost::text, w.actual_cost::text,
         w.downtime_start, w.downtime_end, w.service_date::text,
         w.requires_verification, w.repair_completed_by,
         rc.name AS repair_completed_by_name, w.repair_completed_at,
         v.name AS verified_by_name, w.verified_at, w.verification_notes,
         cb.name AS created_by_name, w.created_at, w.closed_at,
         h.id AS hold_id, h.kind AS hold_kind, h.title AS hold_title, h.created_at AS hold_created_at
    FROM work_orders w
    JOIN resources r ON r.id = w.resource_id
    LEFT JOIN incidents i ON i.id = w.incident_id
    LEFT JOIN users a ON a.id = w.assigned_to
    LEFT JOIN users rc ON rc.id = w.repair_completed_by
    LEFT JOIN users v ON v.id = w.verified_by
    LEFT JOIN users cb ON cb.id = w.created_by
    LEFT JOIN resource_holds h ON h.work_order_id = w.id AND h.status = 'active'`;

function mapRow(row: Row): Omit<WorkOrderItem, "history"> {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    priority: row.priority,
    resourceId: row.resource_id,
    resourceCode: row.resource_code,
    resourceName: row.resource_name,
    resourceStatus: row.resource_status,
    incidentId: row.incident_id,
    incidentTitle: row.incident_title,
    incidentSeverity: row.incident_severity,
    assignedTo: row.assigned_to,
    assigneeName: row.assignee_name,
    vendorName: row.vendor_name,
    vendorContact: row.vendor_contact,
    diagnosis: row.diagnosis,
    repairNotes: row.repair_notes,
    partsUsed: row.parts_used,
    labourHours: Number(row.labour_hours),
    estimatedCost: row.estimated_cost === null ? null : Number(row.estimated_cost),
    actualCost: row.actual_cost === null ? null : Number(row.actual_cost),
    downtimeStart: row.downtime_start,
    downtimeEnd: row.downtime_end,
    serviceDate: row.service_date,
    requiresVerification: row.requires_verification,
    repairCompletedBy: row.repair_completed_by,
    repairCompletedByName: row.repair_completed_by_name,
    repairCompletedAt: row.repair_completed_at,
    verifiedByName: row.verified_by_name,
    verifiedAt: row.verified_at,
    verificationNotes: row.verification_notes,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    activeHold:
      row.hold_id && row.hold_kind && row.hold_title && row.hold_created_at
        ? { id: row.hold_id, kind: row.hold_kind, title: row.hold_title, createdAt: row.hold_created_at }
        : null,
  };
}

export async function listWorkOrders(organizationId: string, limit = 40): Promise<WorkOrderItem[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<Row>(`${SELECT} ${ORDER_BY} LIMIT $1`, [limit]);
    if (rows.length === 0) return [];

    const events = await db.query<{
      id: string;
      work_order_id: string;
      from_status: string | null;
      to_status: string;
      kind: string;
      note: string;
      actor_name: string | null;
      created_at: Date;
    }>(
      `SELECT e.id, e.work_order_id, e.from_status, e.to_status, e.kind, e.note,
              u.name AS actor_name, e.created_at
         FROM work_order_events e
         LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.work_order_id = ANY($1::uuid[])
        ORDER BY e.created_at`,
      [rows.map((row) => row.id)],
    );

    const byOrder = new Map<string, WorkOrderEvent[]>();
    for (const event of events.rows) {
      const list = byOrder.get(event.work_order_id) ?? [];
      list.push({
        id: event.id,
        fromStatus: event.from_status,
        toStatus: event.to_status,
        kind: event.kind,
        note: event.note,
        actorName: event.actor_name,
        createdAt: event.created_at,
      });
      byOrder.set(event.work_order_id, list);
    }

    return rows.map((row) => ({ ...mapRow(row), history: byOrder.get(row.id) ?? [] }));
  });
}

export async function getWorkOrder(organizationId: string, workOrderId: string): Promise<WorkOrderItem | null> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<Row>(`${SELECT} WHERE w.id = $1`, [workOrderId]);
    if (!rows[0]) return null;
    const events = await db.query<{
      id: string;
      from_status: string | null;
      to_status: string;
      kind: string;
      note: string;
      actor_name: string | null;
      created_at: Date;
    }>(
      `SELECT e.id, e.from_status, e.to_status, e.kind, e.note, u.name AS actor_name, e.created_at
         FROM work_order_events e
         LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.work_order_id = $1
        ORDER BY e.created_at`,
      [workOrderId],
    );
    return {
      ...mapRow(rows[0]),
      history: events.rows.map((event) => ({
        id: event.id,
        fromStatus: event.from_status,
        toStatus: event.to_status,
        kind: event.kind,
        note: event.note,
        actorName: event.actor_name,
        createdAt: event.created_at,
      })),
    };
  });
}

/** Open incidents that do not yet have a work order, for the creation form. */
export async function listConvertibleIncidents(
  organizationId: string,
): Promise<Array<{ id: string; resourceId: string; resourceCode: string; resourceName: string; title: string; severity: string; createdAt: Date }>> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      resource_id: string;
      resource_code: string;
      resource_name: string;
      title: string;
      severity: string;
      created_at: Date;
    }>(
      `SELECT i.id, i.resource_id, r.code AS resource_code, r.name AS resource_name,
              i.title, i.severity, i.created_at
         FROM incidents i
         JOIN resources r ON r.id = i.resource_id
         LEFT JOIN work_orders w ON w.incident_id = i.id
        WHERE i.status <> 'resolved' AND w.id IS NULL
        ORDER BY CASE i.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, i.created_at DESC
        LIMIT 20`,
    );
    return rows.map((row) => ({
      id: row.id,
      resourceId: row.resource_id,
      resourceCode: row.resource_code,
      resourceName: row.resource_name,
      title: row.title,
      severity: row.severity,
      createdAt: row.created_at,
    }));
  });
}

export async function listAssignableStaff(
  organizationId: string,
): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{ id: string; name: string; email: string; role: string }>(
      `SELECT u.id, u.name, u.email, m.role
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.role IN ('technician', 'manager', 'admin')
        ORDER BY m.role, u.name`,
    );
    return rows;
  });
}

export type OverrideItem = {
  id: string;
  resourceId: string;
  resourceCode: string;
  resourceName: string;
  action: string;
  scope: string;
  reason: string;
  startsAt: Date;
  expiresAt: Date | null;
  /** Evaluated by the database, so the page never has to call the clock. */
  expired: boolean;
  revokedAt: Date | null;
  revokeReason: string | null;
  createdByName: string | null;
  createdAt: Date;
  affected: Array<{
    id: string;
    bookingId: string | null;
    userName: string | null;
    statusBefore: string;
    statusAfter: string;
    notificationStatus: string;
    notificationNote: string;
    startsAt: Date | null;
    endsAt: Date | null;
  }>;
};

export async function listOverrides(organizationId: string, limit = 12): Promise<OverrideItem[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      resource_id: string;
      resource_code: string;
      resource_name: string;
      action: string;
      scope: string;
      reason: string;
      starts_at: Date;
      expires_at: Date | null;
      expired: boolean;
      revoked_at: Date | null;
      revoke_reason: string | null;
      created_by_name: string | null;
      created_at: Date;
    }>(
      `SELECT e.id, e.resource_id, r.code AS resource_code, r.name AS resource_name,
              e.action, e.scope, e.reason, e.starts_at, e.expires_at,
              (e.expires_at IS NOT NULL AND e.expires_at <= now()) AS expired,
              e.revoked_at, e.revoke_reason,
              u.name AS created_by_name, e.created_at
         FROM emergency_overrides e
         JOIN resources r ON r.id = e.resource_id
         LEFT JOIN users u ON u.id = e.created_by
        ORDER BY e.created_at DESC
        LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) return [];

    const affected = await db.query<{
      id: string;
      override_id: string;
      booking_id: string | null;
      user_name: string | null;
      status_before: string;
      status_after: string;
      notification_status: string;
      notification_note: string;
      starts_at: Date | null;
      ends_at: Date | null;
    }>(
      `SELECT eb.id, eb.override_id, eb.booking_id, u.name AS user_name,
              eb.status_before, eb.status_after, eb.notification_status, eb.notification_note,
              eb.starts_at, eb.ends_at
         FROM emergency_override_bookings eb
         LEFT JOIN users u ON u.id = eb.user_id
        WHERE eb.override_id = ANY($1::uuid[])
        ORDER BY eb.starts_at NULLS LAST`,
      [rows.map((row) => row.id)],
    );

    const byOverride = new Map<string, OverrideItem["affected"]>();
    for (const row of affected.rows) {
      const list = byOverride.get(row.override_id) ?? [];
      list.push({
        id: row.id,
        bookingId: row.booking_id,
        userName: row.user_name,
        statusBefore: row.status_before,
        statusAfter: row.status_after,
        notificationStatus: row.notification_status,
        notificationNote: row.notification_note,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
      });
      byOverride.set(row.override_id, list);
    }

    return rows.map((row) => ({
      id: row.id,
      resourceId: row.resource_id,
      resourceCode: row.resource_code,
      resourceName: row.resource_name,
      action: row.action,
      scope: row.scope,
      reason: row.reason,
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
      expired: row.expired,
      revokedAt: row.revoked_at,
      revokeReason: row.revoke_reason,
      createdByName: row.created_by_name,
      createdAt: row.created_at,
      affected: byOverride.get(row.id) ?? [],
    }));
  });
}

/** Counts of outbound email rows by status, so the UI can be honest about delivery. */
export async function getDeliverySummary(
  organizationId: string,
): Promise<{ pending: number; sent: number; unavailable: number; failed: number }> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{ status: string; count: number }>(
      "SELECT status, count(*)::int AS count FROM notification_outbox GROUP BY status",
    );
    const summary = { pending: 0, sent: 0, unavailable: 0, failed: 0 };
    for (const row of rows) {
      if (row.status in summary) summary[row.status as keyof typeof summary] = row.count;
    }
    return summary;
  });
}
