import "server-only";
import { withOrg, type Queryable } from "./db";

/**
 * Operational readiness.
 *
 * A free calendar slot is not permission to use an instrument. This module is the
 * single place that decides whether a resource is *usable*, and it is deliberately
 * free of UI concerns so it can be tested as a domain function:
 *
 *   evaluateReadiness(snapshot)      pure  — snapshot in, verdict + reasons out
 *   loadReadinessSnapshot(db, …)     I/O   — one resource's readiness facts
 *   getResourceReadiness(org, …)     I/O   — the same, in a tenant transaction
 *   bookingGate(db, …)               I/O   — the gate booking creation must pass
 *   consumeRequiredConsumables(db)   I/O   — transactional stock deduction
 *
 * Severity is part of the contract: `block` prevents the action, `warning`
 * permits it while telling the user what will fail later. Safety conditions
 * (retired asset, high-severity incident hold, expired calibration on an asset
 * that requires it) are always blocks and are never overridable via the
 * ordinary scheduling flows.
 */

export const CALIBRATION_WARNING_DAYS = 14;

export type ReadinessState = "ready" | "warnings" | "blocked";
export type ReadinessSeverity = "block" | "warning";

export type ReadinessReason = {
  code: string;
  severity: ReadinessSeverity;
  title: string;
  detail: string;
  action: string;
};

export type ConsumableGate = {
  consumableId: string;
  name: string;
  unit: string;
  stock: number;
  minStock: number;
  required: number;
  mandatory: boolean;
};

/** A blocking hold raised by an incident or a work order. Only release clears it. */
export type ActiveHold = {
  id: string;
  kind: "safety" | "maintenance" | "quality";
  title: string;
  reason: string;
};

/** A live emergency restriction that halts work until it expires or is revoked. */
export type ActiveRestriction = {
  id: string;
  scope: string;
  reason: string;
  expiresAt: Date | null;
};

export type ReadinessSnapshot = {
  resource: {
    id: string;
    name: string;
    status: string;
    requiresCalibration: boolean;
    trainingCourseId: string | null;
    trainingName: string | null;
  };
  calibration: { validUntil: string; result: string } | null;
  openIncidents: Array<{ severity: string; title: string }>;
  activeBlackout: { reason: string; endsAt: Date } | null;
  consumables: ConsumableGate[];
  /** Optional so older callers and fixtures keep compiling; absent means none. */
  activeHolds?: ActiveHold[];
  emergencyRestrictions?: ActiveRestriction[];
  at: Date;
};

export type ReadinessResult = {
  state: ReadinessState;
  reasons: ReadinessReason[];
  blocked: ReadinessReason[];
  warnings: ReadinessReason[];
  checkedAt: Date;
};

const IST = "Asia/Kolkata";

/** YYYY-MM-DD in the institution timezone (en-CA renders ISO order). */
export function istDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function dayNumber(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1) / 86_400_000;
}

function formatDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)));
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Pure evaluation. No database, no clock of its own — `snapshot.at` is the
 * evaluation time, which is what makes the tests deterministic.
 */
export function evaluateReadiness(snapshot: ReadinessSnapshot): ReadinessResult {
  const reasons: ReadinessReason[] = [];
  const push = (reason: ReadinessReason) => {
    if (!reasons.some((existing) => existing.code === reason.code)) reasons.push(reason);
  };
  const today = istDay(snapshot.at);
  const resource = snapshot.resource;

  // 1. Lifecycle
  if (resource.status === "retired") {
    push({
      code: "resource_retired",
      severity: "block",
      title: "Asset retired",
      detail: `${resource.name} has been retired from the catalogue and cannot be booked.`,
      action: "Reinstate the asset in the catalogue if it is in fact still in service.",
    });
  } else if (resource.status === "suspended") {
    push({
      code: "resource_suspended",
      severity: "block",
      title: "Asset suspended",
      detail: `${resource.name} is suspended, usually after a safety incident.`,
      action: "Resolve the underlying incident, then restore the asset to ready.",
    });
  } else if (resource.status === "maintenance") {
    push({
      code: "resource_maintenance",
      severity: "block",
      title: "Under maintenance",
      detail: `${resource.name} is marked as under maintenance.`,
      action: "Resolve the maintenance record once the repair is verified.",
    });
  }

  // 2. Calibration — only for assets that declare a calibration requirement.
  if (resource.requiresCalibration) {
    const calibration = snapshot.calibration;
    if (!calibration) {
      push({
        code: "calibration_missing",
        severity: "block",
        title: "No calibration on record",
        detail: `${resource.name} requires calibration, but no calibration record exists.`,
        action: "Record a valid calibration result before bookings reopen.",
      });
    } else if (calibration.result === "fail") {
      push({
        code: "calibration_failed",
        severity: "block",
        title: "Calibration failed",
        detail: `The most recent calibration on ${formatDay(calibration.validUntil)} recorded a failure.`,
        action: "Repair or requalify the instrument, then record a passing calibration.",
      });
    } else if (calibration.validUntil < today) {
      push({
        code: "calibration_expired",
        severity: "block",
        title: "Calibration expired",
        detail: `Calibration expired on ${formatDay(calibration.validUntil)}. Bookings are blocked until a valid calibration is recorded.`,
        action: "Record the current calibration certificate, or suspend the asset from the catalogue.",
      });
    } else if (dayNumber(calibration.validUntil) - dayNumber(today) <= CALIBRATION_WARNING_DAYS) {
      push({
        code: "calibration_due_soon",
        severity: "warning",
        title: "Calibration due soon",
        detail: `Calibration expires on ${formatDay(calibration.validUntil)}, within ${CALIBRATION_WARNING_DAYS} days.`,
        action: "Schedule the next calibration before the expiry date.",
      });
    }
  }

  // 3. Safety incidents. A high-severity open incident is a hard hold; anything
  //    else is a warning the facility manager should see but may still accept.
  const highOpen = snapshot.openIncidents.find((incident) => incident.severity === "high");
  if (highOpen) {
    push({
      code: "safety_hold",
      severity: "block",
      title: "Safety hold",
      detail: `Open high-severity incident: “${highOpen.title}”.`,
      action: "Resolve the incident and have a technician verify the repair before releasing the asset.",
    });
  } else if (snapshot.openIncidents.length > 0) {
    push({
      code: "incident_open",
      severity: "warning",
      title: "Open incident",
      detail: `${snapshot.openIncidents.length} unresolved incident${snapshot.openIncidents.length === 1 ? "" : "s"} on this asset.`,
      action: "Review the incident and record a resolution when the fault is fixed.",
    });
  }

  // 4. Blocking holds. These are separate from the incident that caused them: a
  //    completed repair does not clear them, and neither does closing the work
  //    order. Only an authorised release does.
  for (const hold of snapshot.activeHolds ?? []) {
    const label = hold.kind === "safety" ? "Safety hold" : hold.kind === "quality" ? "Quality hold" : "Maintenance hold";
    push({
      code: "active_hold",
      severity: "block",
      title: `${label}: ${hold.title}`,
      detail:
        hold.reason ||
        `${resource.name} is held by an open ${hold.kind} record. A completed repair does not release an asset.`,
      action: "Complete the repair, have it verified where policy requires it, then release the asset explicitly.",
    });
  }

  // 5. Live emergency restriction (temporary, expires or is revoked).
  for (const restriction of snapshot.emergencyRestrictions ?? []) {
    push({
      code: "emergency_restriction",
      severity: "block",
      title: "Temporarily restricted",
      detail: `An emergency restriction is in force: ${restriction.scope}.`,
      action: "Wait for the restriction to expire or be revoked by a facility manager.",
    });
  }

  // 6. Maintenance window covering the requested time.
  if (snapshot.activeBlackout) {
    push({
      code: "maintenance_hold",
      severity: "block",
      title: "Maintenance window active",
      detail: `${snapshot.activeBlackout.reason || "Maintenance"} is scheduled until ${new Intl.DateTimeFormat("en-GB", {
        timeZone: IST,
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(snapshot.activeBlackout.endsAt)}.`,
      action: "Book after the window ends, or ask a facility manager to reschedule the maintenance.",
    });
  }

  // 7. Consumables.
  for (const item of snapshot.consumables) {
    if (item.mandatory && item.stock < item.required) {
      push({
        code: `consumable_shortage_${item.consumableId}`,
        severity: "block",
        title: `${item.name} out of stock`,
        detail: `${trim(item.stock)} ${item.unit} in stock, ${trim(item.required)} ${item.unit} required for this session.`,
        action: "Record a stock purchase or select an approved alternative before booking.",
      });
    } else if (item.stock < item.minStock) {
      push({
        code: `consumable_low_${item.consumableId}`,
        severity: "warning",
        title: `${item.name} below minimum`,
        detail: `${trim(item.stock)} ${item.unit} left, minimum is ${trim(item.minStock)} ${item.unit}.`,
        action: "Reorder before the next busy week.",
      });
    }
  }

  const blocked = reasons.filter((reason) => reason.severity === "block");
  const warnings = reasons.filter((reason) => reason.severity === "warning");
  return {
    state: blocked.length > 0 ? "blocked" : warnings.length > 0 ? "warnings" : "ready",
    reasons,
    blocked,
    warnings,
    checkedAt: snapshot.at,
  };
}

type SnapshotRows = {
  resource: {
    id: string;
    name: string;
    status: string;
    requires_calibration: boolean;
    training_course_id: string | null;
    training_name: string | null;
  };
};

/** Reads one resource's readiness facts inside the caller's transaction. */
export async function loadReadinessSnapshot(
  db: Queryable,
  resourceId: string,
  at: Date,
): Promise<ReadinessSnapshot> {
  const resourceResult = await db.query<SnapshotRows["resource"]>(
    `SELECT r.id, r.name, r.status, r.requires_calibration, r.training_course_id,
            tc.name AS training_name
       FROM resources r
       LEFT JOIN training_courses tc ON tc.id = r.training_course_id
      WHERE r.id = $1`,
    [resourceId],
  );
  const resource = resourceResult.rows[0];
  if (!resource) throw new Error("Resource not found.");

  const [calibration, incidents, blackout, consumables, holds, restrictions] = await Promise.all([
    db.query<{ valid_until: string; result: string }>(
      `SELECT valid_until::text, result FROM calibration_records
        WHERE resource_id = $1
        ORDER BY valid_until DESC, created_at DESC
        LIMIT 1`,
      [resourceId],
    ),
    db.query<{ severity: string; title: string }>(
      `SELECT severity, title FROM incidents
        WHERE resource_id = $1 AND status <> 'resolved'
        ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC
        LIMIT 5`,
      [resourceId],
    ),
    db.query<{ reason: string; ends_at: Date }>(
      `SELECT reason, ends_at FROM blackout_periods
        WHERE resource_id = $1 AND starts_at <= $2 AND ends_at > $2
        ORDER BY starts_at DESC LIMIT 1`,
      [resourceId, at],
    ),
    db.query<{
      id: string;
      name: string;
      unit: string;
      stock: string;
      min_stock: string;
      qty_per_session: string;
      mandatory: boolean;
    }>(
      `SELECT c.id, c.name, c.unit, c.stock::text, c.min_stock::text,
              rc.qty_per_session::text, rc.mandatory
         FROM resource_consumables rc
         JOIN consumables c ON c.id = rc.consumable_id
        WHERE rc.resource_id = $1
        ORDER BY c.name`,
      [resourceId],
    ),
    db.query<{ id: string; kind: "safety" | "maintenance" | "quality"; title: string; reason: string }>(
      `SELECT id, kind, title, reason FROM resource_holds
        WHERE resource_id = $1 AND status = 'active'
        ORDER BY CASE kind WHEN 'safety' THEN 0 WHEN 'maintenance' THEN 1 ELSE 2 END, created_at DESC`,
      [resourceId],
    ),
    db.query<{ id: string; scope: string; reason: string; expires_at: Date | null }>(
      `SELECT id, scope, reason, expires_at FROM emergency_overrides
        WHERE resource_id = $1 AND action = 'restrict_resource' AND revoked_at IS NULL
          AND starts_at <= $2 AND (expires_at IS NULL OR expires_at > $2)
        ORDER BY created_at DESC LIMIT 5`,
      [resourceId, at],
    ),
  ]);

  return {
    resource: {
      id: resource.id,
      name: resource.name,
      status: resource.status,
      requiresCalibration: resource.requires_calibration,
      trainingCourseId: resource.training_course_id,
      trainingName: resource.training_name,
    },
    calibration: calibration.rows[0]
      ? { validUntil: calibration.rows[0].valid_until, result: calibration.rows[0].result }
      : null,
    openIncidents: incidents.rows,
    activeBlackout: blackout.rows[0]
      ? { reason: blackout.rows[0].reason, endsAt: blackout.rows[0].ends_at }
      : null,
    consumables: consumables.rows.map((row) => ({
      consumableId: row.id,
      name: row.name,
      unit: row.unit,
      stock: Number(row.stock),
      minStock: Number(row.min_stock),
      required: Number(row.qty_per_session),
      mandatory: row.mandatory,
    })),
    activeHolds: holds.rows,
    emergencyRestrictions: restrictions.rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      reason: row.reason,
      expiresAt: row.expires_at,
    })),
    at,
  };
}

/** Tenant-scoped readiness for display. */
export async function getResourceReadiness(
  organizationId: string,
  resourceId: string,
  at: Date = new Date(),
): Promise<ReadinessResult> {
  return withOrg(organizationId, async (db) =>
    evaluateReadiness(await loadReadinessSnapshot(db, resourceId, at)),
  );
}

export type BookingGate =
  | { ok: true; readiness: ReadinessResult }
  | { ok: false; code: "not_ready"; message: string; readiness: ReadinessResult };

/**
 * The gate booking creation and approval must pass. Warnings do not block; a
 * single hard block does, and the message names the condition and the fix.
 */
export async function bookingGate(
  db: Queryable,
  resourceId: string,
  at: Date,
): Promise<BookingGate> {
  const readiness = evaluateReadiness(await loadReadinessSnapshot(db, resourceId, at));
  if (readiness.state !== "blocked") return { ok: true, readiness };

  const first = readiness.blocked[0];
  const others = readiness.blocked.length - 1;
  return {
    ok: false,
    code: "not_ready",
    message:
      `${first.title}: ${first.detail} ${first.action}` +
      (others > 0 ? ` (${others} more blocking condition${others === 1 ? "" : "s"}.)` : ""),
    readiness,
  };
}

/**
 * Deducts the required consumables for a session, transactionally and exactly
 * once per booking.
 *
 * - `SELECT … FOR UPDATE OF c` serialises two sessions competing for the last
 *   unit, so stock can never go negative even under concurrency.
 * - The unique index `consumable_movements_once_per_booking` means a retried or
 *   double-submitted check-in cannot deduct twice.
 */
export async function consumeRequiredConsumables(
  db: Queryable,
  input: { organizationId: string; bookingId: string; resourceId: string; actorId: string | null },
): Promise<Array<{ name: string; quantity: number; unit: string }>> {
  const required = await db.query<{
    consumable_id: string;
    name: string;
    unit: string;
    stock: string;
    qty: string;
  }>(
    `SELECT c.id AS consumable_id, c.name, c.unit, c.stock::text,
            rc.qty_per_session::text AS qty
       FROM resource_consumables rc
       JOIN consumables c ON c.id = rc.consumable_id
      WHERE rc.resource_id = $1
      ORDER BY c.id
      FOR UPDATE OF c`,
    [input.resourceId],
  );

  const consumed: Array<{ name: string; quantity: number; unit: string }> = [];

  for (const row of required.rows) {
    const already = await db.query(
      `SELECT 1 FROM consumable_movements
        WHERE booking_id = $1 AND consumable_id = $2 AND reason = 'consumption'`,
      [input.bookingId, row.consumable_id],
    );
    if (already.rows.length > 0) continue;

    const quantity = Number(row.qty);
    const updated = await db.query<{ stock: string }>(
      `UPDATE consumables
          SET stock = stock - $2, updated_at = now()
        WHERE id = $1 AND stock >= $2
        RETURNING stock::text`,
      [row.consumable_id, quantity],
    );
    if (!updated.rows[0]) {
      throw new Error(
        `${row.name}: ${trim(Number(row.stock))} ${row.unit} in stock, ${trim(quantity)} ${row.unit} required to start this session. Record a purchase first.`,
      );
    }

    await db.query(
      `INSERT INTO consumable_movements
         (organization_id, consumable_id, delta, reason, booking_id, actor_id, note)
       VALUES ($1, $2, $3, 'consumption', $4, $5, $6)`,
      [
        input.organizationId,
        row.consumable_id,
        -quantity,
        input.bookingId,
        input.actorId,
        "Consumed on check-in",
      ],
    );
    consumed.push({ name: row.name, quantity, unit: row.unit });
  }

  return consumed;
}
