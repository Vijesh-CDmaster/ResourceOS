"use server";

import { revalidatePath } from "next/cache";
import { withOrg, isUniqueViolation, type Queryable } from "../db";
import { requireUser } from "../auth";
import { notifyManagers, notifyUser, recordAudit } from "../audit";
import { evaluateReadiness, loadReadinessSnapshot } from "../readiness";
import { queueEmail, type DeliveryOutcome } from "../notifications.ts";
import {
  MIN_OVERRIDE_REASON,
  OVERRIDE_ACTIONS,
  WORK_ORDER_PRIORITIES,
  can,
  canTransition,
  checkVerifier,
  isReleasable,
  overrideBlockedBy,
  overrideNeedsWindow,
  type OverrideAction,
  type WorkOrderStatus,
} from "../work-orders";
import { fail, field, optionalField, ok, parseDateInput, errorMessage } from "../action-utils";

const PAGE = "/work-orders";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type WorkOrderRow = {
  id: string;
  resource_id: string;
  incident_id: string | null;
  code: string;
  status: WorkOrderStatus;
  priority: string;
  assigned_to: string | null;
  vendor_name: string;
  requires_verification: boolean;
  repair_completed_by: string | null;
  title: string;
  resource_name: string;
  resource_status: string;
};

function backTo(workOrderId?: string): string {
  return workOrderId ? `${PAGE}?order=${workOrderId}` : PAGE;
}

/**
 * A redirect thrown by `fail` must reach Next.js. Server actions catch database
 * errors to show a friendly message, and without this the redirect would be
 * rewritten as "NEXT_REDIRECT".
 */
function rethrowRedirect(error: unknown): void {
  if (typeof error !== "object" || error === null) return;
  const candidate = error as { digest?: string; isStubRedirect?: boolean };
  if (candidate.isStubRedirect || (candidate.digest ?? "").startsWith("NEXT_REDIRECT")) throw error;
}

/** Locks one work order and its resource for a transition. */
async function lockWorkOrder(db: Queryable, workOrderId: string): Promise<WorkOrderRow> {
  const result = await db.query(
    `SELECT w.id, w.resource_id, w.incident_id, w.code, w.status, w.priority, w.assigned_to,
            w.vendor_name, w.requires_verification, w.repair_completed_by,
            coalesce(i.title, 'Reported fault') AS title,
            r.name AS resource_name, r.status AS resource_status
       FROM work_orders w
       JOIN resources r ON r.id = w.resource_id
       LEFT JOIN incidents i ON i.id = w.incident_id
      WHERE w.id = $1
      FOR UPDATE OF w, r`,
    [workOrderId],
  );
  const row = result.rows[0] as WorkOrderRow | undefined;
  if (!row) throw new Error("Work order not found in this workspace.");
  return row;
}

async function nextCode(db: Queryable, organizationId: string): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO work_order_sequences (organization_id, last_number) VALUES ($1, 1)
     ON CONFLICT (organization_id)
     DO UPDATE SET last_number = work_order_sequences.last_number + 1
     RETURNING last_number`,
    [organizationId],
  );
  return `WO-${new Date().getUTCFullYear()}-${String(rows[0].last_number).padStart(4, "0")}`;
}

async function logEvent(
  db: Queryable,
  input: {
    organizationId: string;
    workOrderId: string;
    actorId: string;
    from: WorkOrderStatus | null;
    to: WorkOrderStatus;
    kind: "status" | "created" | "assignment" | "verification_passed" | "verification_rejected" | "reopened" | "released" | "note";
    note?: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO work_order_events
       (organization_id, work_order_id, from_status, to_status, kind, note, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [input.organizationId, input.workOrderId, input.from, input.to, input.kind, input.note ?? "", input.actorId],
  );
}

/**
 * The only way a status changes. Refuses any move the lifecycle does not allow,
 * so an action cannot skip verification or reopen a closed job by accident.
 */
async function advance(
  db: Queryable,
  input: {
    organizationId: string;
    order: WorkOrderRow;
    to: WorkOrderStatus;
    actorId: string;
    kind?: "status" | "verification_passed" | "verification_rejected" | "reopened" | "released";
    note?: string;
    extraSql?: string;
    extraParams?: unknown[];
  },
): Promise<void> {
  if (!canTransition(input.order.status, input.to)) {
    throw new Error(`A work order in "${input.order.status}" cannot move to "${input.to}".`);
  }
  const params = [input.order.id, input.to, ...(input.extraParams ?? [])];
  await db.query(
    `UPDATE work_orders SET status = $2, updated_at = now()
       ${input.extraSql ? `, ${input.extraSql}` : ""}
     WHERE id = $1`,
    params,
  );
  await logEvent(db, {
    organizationId: input.organizationId,
    workOrderId: input.order.id,
    actorId: input.actorId,
    from: input.order.status,
    to: input.to,
    kind: input.kind ?? "status",
    note: input.note,
  });
}

async function notifyWithEmail(
  db: Queryable,
  input: {
    organizationId: string;
    userId: string;
    email: string | null;
    title: string;
    body: string;
    link: string;
    relatedType: string;
    relatedId: string;
  },
): Promise<DeliveryOutcome> {
  await notifyUser(db, {
    organizationId: input.organizationId,
    userId: input.userId,
    title: input.title,
    body: input.body,
    link: input.link,
  });
  return queueEmail(db, {
    organizationId: input.organizationId,
    recipient: input.email,
    subject: input.title,
    body: input.body,
    relatedType: input.relatedType,
    relatedId: input.relatedId,
  });
}

async function raiseHold(
  db: Queryable,
  input: {
    organizationId: string;
    resourceId: string;
    workOrderId: string;
    incidentId: string | null;
    kind: "safety" | "maintenance" | "quality";
    title: string;
    reason: string;
    actorId: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO resource_holds
       (organization_id, resource_id, work_order_id, incident_id, kind, title, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (work_order_id) WHERE status = 'active' AND work_order_id IS NOT NULL DO NOTHING`,
    [
      input.organizationId,
      input.resourceId,
      input.workOrderId,
      input.incidentId,
      input.kind,
      input.title,
      input.reason,
      input.actorId,
    ],
  );
  await db.query(
    "UPDATE resources SET status = 'maintenance' WHERE id = $1 AND status = 'ready'",
    [input.resourceId],
  );
}

/* ------------------------------------------------------------------ */
/* Work orders                                                        */
/* ------------------------------------------------------------------ */

export async function createWorkOrderAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const incidentId = optionalField(formData, "incident_id");
  const resourceId = optionalField(formData, "resource_id");
  const priorityRaw = field(formData, "priority") || "normal";
  const assigneeId = optionalField(formData, "assignee_id");
  const vendorName = field(formData, "vendor_name");
  const vendorContact = field(formData, "vendor_contact");
  const diagnosis = field(formData, "diagnosis");
  const target = incidentId ? `${PAGE}?incident=${incidentId}` : PAGE;

  if (!can(user.role, "create")) fail(target, "Only facility staff can raise a work order.");
  if (!incidentId && !resourceId) fail(target, "Choose the incident or the asset this work order is for.");
  if (!(WORK_ORDER_PRIORITIES as readonly string[]).includes(priorityRaw)) {
    fail(target, "Choose a priority: urgent, high, normal or low.");
  }
  if (diagnosis.length > 2000) fail(target, "The diagnosis must be 2,000 characters or fewer.");

  let createdCode = "";
  try {
    createdCode = await withOrg(user.organizationId, async (db) => {
      const resource = await db.query<{
        id: string;
        name: string;
        status: string;
        requires_independent_verification: boolean;
      }>(
        `SELECT r.id, r.name, r.status, r.requires_independent_verification
           FROM resources r
          WHERE r.id = coalesce(
            (SELECT resource_id FROM incidents WHERE id = $1),
            $2::uuid
          )
          FOR UPDATE`,
        [incidentId, resourceId],
      );
      const asset = resource.rows[0];
      if (!asset) fail(target, "That asset does not exist in this workspace.");

      let incident: { id: string; title: string; severity: string; description: string } | null = null;
      if (incidentId) {
        const incidentResult = await db.query<{
          id: string;
          resource_id: string;
          title: string;
          severity: string;
          description: string;
          status: string;
        }>("SELECT id, resource_id, title, severity, description, status FROM incidents WHERE id = $1", [
          incidentId,
        ]);
        const row = incidentResult.rows[0];
        if (!row) fail(target, "That incident does not exist in this workspace.");
        if (row.resource_id !== asset.id) fail(target, "That incident belongs to a different asset.");
        incident = row;
      }

      const existing = await db.query<{ code: string }>(
        "SELECT code FROM work_orders WHERE incident_id = $1",
        [incidentId],
      );
      if (existing.rows[0]) {
        fail(target, `Incident already has work order ${existing.rows[0].code}.`);
      }

      if (assigneeId) {
        const assignee = await db.query<{ name: string }>(
          `SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.user_id = $1 AND m.role IN ('admin', 'manager', 'technician')`,
          [assigneeId],
        );
        if (!assignee.rows[0]) fail(target, "Assign the job to a technician, manager or administrator in this workspace.");
      }

      const code = await nextCode(db, user.organizationId);
      const status = assigneeId ? "assigned" : "reported";
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO work_orders
           (organization_id, resource_id, incident_id, code, status, priority, assigned_to,
            vendor_name, vendor_contact, diagnosis, requires_verification, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          user.organizationId,
          asset.id,
          incidentId,
          code,
          status,
          priorityRaw,
          assigneeId,
          vendorName,
          vendorContact,
          diagnosis,
          asset.requires_independent_verification,
          user.userId,
        ],
      );
      const workOrderId = inserted.rows[0].id;

      await logEvent(db, {
        organizationId: user.organizationId,
        workOrderId,
        actorId: user.userId,
        from: null,
        to: status as WorkOrderStatus,
        kind: "created",
        note: diagnosis || (incident ? incident.description : "Work order raised"),
      });

      // The hold is what keeps the asset unavailable. It is deliberately separate
      // from the work order so that finishing the repair cannot release it.
      await raiseHold(db, {
        organizationId: user.organizationId,
        resourceId: asset.id,
        workOrderId,
        incidentId,
        kind: incident?.severity === "high" ? "safety" : "maintenance",
        title: incident?.title ?? `Fault on ${asset.name}`,
        reason:
          "Raised with work order " +
          code +
          ". Released only by an authorised release after any required verification.",
        actorId: user.userId,
      });

      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "work_order.created",
        entityType: "work_order",
        entityId: workOrderId,
        summary: `${user.name} raised ${code} for ${asset.name}`,
        metadata: { code, priority: priorityRaw, incidentId, assigneeId, vendorName },
      });

      if (assigneeId) {
        const assignee = await db.query<{ email: string; name: string }>(
          "SELECT email, name FROM users WHERE id = $1",
          [assigneeId],
        );
        if (assignee.rows[0]) {
          await notifyWithEmail(db, {
            organizationId: user.organizationId,
            userId: assigneeId,
            email: assignee.rows[0].email,
            title: `Assigned: ${code} — ${asset.name}`,
            body: diagnosis || incident?.title || "A repair job has been assigned to you.",
            link: `${PAGE}?order=${workOrderId}`,
            relatedType: "work_order",
            relatedId: workOrderId,
          });
        }
      } else {
        await notifyManagers(db, {
          organizationId: user.organizationId,
          title: `Work order ${code} needs an assignee`,
          body: `${asset.name}: ${incident?.title ?? "fault reported"}. The asset is held until release.`,
          link: `${PAGE}?order=${workOrderId}`,
          excludeUserId: user.userId,
        });
      }

      return code;
    });
  } catch (error) {
    if (isUniqueViolation(error)) fail(target, "That incident already has a work order.");
    throw error;
  }

  revalidatePath(PAGE);
  revalidatePath("/operations");
  revalidatePath("/readiness");
  revalidatePath(`/resources/${resourceId ?? ""}`);
  ok(PAGE, `${createdCode} raised. The asset stays held until an authorised release.`);
}

export async function assignWorkOrderAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const workOrderId = field(formData, "work_order_id");
  const assigneeId = optionalField(formData, "assignee_id");
  const vendorName = field(formData, "vendor_name");
  const vendorContact = field(formData, "vendor_contact");
  const note = field(formData, "note");
  const target = backTo(workOrderId);

  if (!can(user.role, "assign")) fail(target, "Only administrators and facility managers can assign work orders.");
  if (!assigneeId && !vendorName) fail(target, "Assign an internal technician or name an external provider.");

  await withOrg(user.organizationId, async (db) => {
    const order = await lockWorkOrder(db, workOrderId);
    if (order.status === "closed" || order.status === "verified") {
      fail(target, "Reopen the work order before changing its assignment.");
    }

    let assigneeRow: { name: string; email: string } | null = null;
    if (assigneeId) {
      const assignee = await db.query<{ name: string; email: string }>(
        `SELECT u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.user_id = $1 AND m.role IN ('admin', 'manager', 'technician')`,
        [assigneeId],
      );
      assigneeRow = assignee.rows[0] ?? null;
      if (!assigneeRow) fail(target, "That person cannot be assigned repairs in this workspace.");
    }

    await db.query(
      `UPDATE work_orders
          SET assigned_to = $2, vendor_name = $3, vendor_contact = $4, updated_at = now()
        WHERE id = $1`,
      [workOrderId, assigneeId, vendorName, vendorContact],
    );

    if (order.status === "reported") {
      await advance(db, {
        organizationId: user.organizationId,
        order: { ...order, status: "reported" },
        to: "assigned",
        actorId: user.userId,
        note: note || `Assigned to ${assigneeRow?.name ?? vendorName}`,
      });
    } else {
      await logEvent(db, {
        organizationId: user.organizationId,
        workOrderId,
        actorId: user.userId,
        from: order.status,
        to: order.status,
        kind: "assignment",
        note: note || `Reassigned to ${assigneeRow?.name ?? vendorName}`,
      });
    }

    if (assigneeId && assigneeRow) {
      await notifyWithEmail(db, {
        organizationId: user.organizationId,
        userId: assigneeId,
        email: assigneeRow.email,
        title: `Assigned: ${order.code} — ${order.resource_name}`,
        body: note || "A repair job has been assigned to you.",
        link: `${PAGE}?order=${workOrderId}`,
        relatedType: "work_order",
        relatedId: workOrderId,
      });
    }

    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "work_order.assigned",
      entityType: "work_order",
      entityId: workOrderId,
      summary: `${user.name} assigned ${order.code} to ${assigneeRow?.name ?? vendorName}`,
      metadata: { assigneeId, vendorName, vendorContact },
    });
  }).catch((error: unknown) => {
    rethrowRedirect(error);
    fail(target, errorMessage(error, "Could not assign the work order."));
  });

  revalidatePath(PAGE);
  ok(target, "Assignment recorded.");
}

/** reported/assigned → in_progress; records the real downtime start. */
export async function startWorkOrderAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const workOrderId = field(formData, "work_order_id");
  const target = backTo(workOrderId);
  if (!can(user.role, "progress")) fail(target, "Only facility staff can start a repair.");

  await withOrg(user.organizationId, async (db) => {
    const order = await lockWorkOrder(db, workOrderId);
    await advance(db, {
      organizationId: user.organizationId,
      order,
      to: "in_progress",
      actorId: user.userId,
      note: field(formData, "note") || "Work started",
      extraSql: "downtime_start = coalesce(downtime_start, now())",
    });
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "work_order.started",
      entityType: "work_order",
      entityId: workOrderId,
      summary: `${user.name} started ${order.code} on ${order.resource_name}`,
    });
  }).catch((error: unknown) => {
    rethrowRedirect(error);
    fail(target, errorMessage(error, "Could not start the work order."));
  });

  revalidatePath(PAGE);
  ok(target, "Repair started. The asset remains held.");
}

export async function waitForPartsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const workOrderId = field(formData, "work_order_id");
  const note = field(formData, "note");
  const target = backTo(workOrderId);
  if (!can(user.role, "progress")) fail(target, "Only facility staff can change repair status.");
  if (note.length < 3) fail(target, "Say which part is awaited so the record is useful.");

  await withOrg(user.organizationId, async (db) => {
    const order = await lockWorkOrder(db, workOrderId);
    await advance(db, {
      organizationId: user.organizationId,
      order,
      to: "waiting_parts",
      actorId: user.userId,
      note,
    });
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "work_order.waiting_parts",
      entityType: "work_order",
      entityId: workOrderId,
      summary: `${order.code} is waiting for parts: ${note}`,
    });
    await notifyManagers(db, {
      organizationId: user.organizationId,
      title: `${order.code} waiting for parts`,
      body: `${order.resource_name} is still held. ${note}`,
      link: `${PAGE}?order=${workOrderId}`,
      excludeUserId: user.userId,
    });
  }).catch((error: unknown) => {
    rethrowRedirect(error);
    fail(target, errorMessage(error, "Could not update the work order."));
  });

  revalidatePath(PAGE);
  ok(target, "Recorded as waiting for parts.");
}

export async function resumeWorkOrderAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const workOrderId = field(formData, "work_order_id");
  const target = backTo(workOrderId);
  if (!can(user.role, "progress")) fail(target, "Only facility staff can change repair status.");

  await withOrg(user.organizationId, async (db) => {
    const order = await lockWorkOrder(db, workOrderId);
    await advance(db, {
      organizationId: user.organizationId,
      order,
      to: "in_progress",
      actorId: user.userId,
      note: field(formData, "note") || "Parts received, work resumed",
      extraSql: "downtime_start = coalesce(downtime_start, now())",
    });
  }).catch((error: unknown) => {
    rethrowRedirect(error);
    fail(target, errorMessage(error, "Could not resume the work order."));
  });

  revalidatePath(PAGE);
  ok(target, "Repair resumed.");
}

/**
 * Escalation is a priority change, not a lifecycle jump: the job keeps its place
 * in the process but is surfaced as urgent and the managers are told why.
 */
export async function escalateWorkOrderAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const workOrderId = field(formData, "work_order_id");
  const reason = field(formData, "note");
  const target = backTo(workOrderId);

  if (!can(user.role, "progress")) fail(target, "Only facility staff can escalate a work order.");
  if (reason.trim().length < 10) fail(target, "Say why this needs escalation (at least 10 characters).");

  await withOrg(user.organizationId, async (db) => {
    const order = await lockWorkOrder(db, workOrderId);
    if (order.status === "closed") fail(target, "A closed work order cannot be escalated. Reopen it first.");

    await db.query("UPDATE work_orders SET priority = 'urgent', updated_at = now() WHERE id = $1", [workOrderId]);
    await logEvent(db, {
      organizationId: user.organizationId,
      workOrderId,
      actorId: user.userId,
      from: order.status,
      to: order.status,
      kind: "note",
      note: `Escalated to urgent: ${reason}`,
    });
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "work_order.escalated",
      entityType: "work_order",
      entityId: workOrderId,
      summary: `${user.name} escalated ${order.code}: ${reason}`,
      metadata: { previousPriority: order.priority, reason },
    });
    await notifyManagers(db, {
      organizationId: user.organizationId,
      title: `${order.code} escalated`,
      body: `${order.resource_name} is still held. ${reason}`,
      link: `${PAGE}?order=${workOrderId}`,
      excludeUserId: user.userId,
    });
  }).catch((error: unknown) => {
    rethrowRedirect(error);
    fail(target, errorMessage(error, "Could not escalate the work order."));
  });

  revalidatePath(PAGE);
  ok(target, "Work order escalated to urgent.");
}

/**
 * Technician sign-off. Sets repair_completed (no independent verification
 * required) or awaiting_verification. Neither releases the asset.
 */
export async function completeRepairAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const workOrderId = field(formData, "work_order_id");
  const repairNotes = field(formData, "repair_notes");
  const partsUsed = field(formData, "parts_used");
  const labourRaw = field(formData, "labour_hours") || "0";
  const estimatedRaw = optionalField(formData, "estimated_cost");
  const actualRaw = optionalField(formData, "actual_cost");
  const serviceDate = optionalField(formData, "service_date");
  const target = backTo(workOrderId);

  if (!can(user.role, "completeRepair")) fail(target, "Only facility staff can sign off a repair.");
  if (repairNotes.length < 10) fail(target, "Record what was actually done (at least 10 characters).");

  const labour = Number(labourRaw);
  if (!Number.isFinite(labour) || labour < 0) fail(target, "Labour hours must be zero or more.");
  const estimated = estimatedRaw === null ? null : Number(estimatedRaw);
  const actual = actualRaw === null ? null : Number(actualRaw);
  if (estimated !== null && (!Number.isFinite(estimated) || estimated < 0)) fail(target, "Estimated cost must be zero or more.");
  if (actual !== null && (!Number.isFinite(actual) || actual < 0)) fail(target, "Actual cost must be zero or more.");
  if (serviceDate !== null && !DATE.test(serviceDate)) fail(target, "Enter the service date as YYYY-MM-DD.");

  await withOrg(user.organizationId, async (db) => {
    const order = await lockWorkOrder(db, workOrderId);
    const next: WorkOrderStatus = order.requires_verification ? "awaiting_verification" : "repair_completed";
    await advance(db, {
      organizationId: user.organizationId,
      order,
      to: next,
      actorId: user.userId,
      note: repairNotes,
      extraSql:
        "repair_completed_by = $3, repair_completed_at = now(), repair_notes = $4, parts_used = $5, labour_hours = $6, estimated_cost = coalesce($7, estimated_cost), actual_cost = coalesce($8, actual_cost), service_date = coalesce($9::date, service_date)",
      extraParams: [user.userId, repairNotes, partsUsed, labour, estimated, actual, serviceDate],
    });

    // Deliberately no hold release here. The asset stays held until release.
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "work_order.repair_completed",
      entityType: "work_order",
      entityId: workOrderId,
      summary: `${user.name} signed off ${order.code} on ${order.resource_name}${order.requires_verification ? " (independent verification required)" : ""}`,
      metadata: { repairNotes, partsUsed, labour, estimated, actual, requiresVerification: order.requires_verification },
    });

    await notifyManagers(db, {
      organizationId: user.organizationId,
      title: `${order.code} ${order.requires_verification ? "needs verification" : "ready for release"}`,
      body: `${order.resource_name} is still held. Repair: ${repairNotes}`,
      link: `${PAGE}?order=${workOrderId}`,
      excludeUserId: user.userId,
    });
  }).catch((error: unknown) => {
    rethrowRedirect(error);
    fail(target, errorMessage(error, "Could not complete the repair."));
  });

  revalidatePath(PAGE);
  revalidatePath("/readiness");
  ok(
    PAGE,
    "Repair signed off. The asset is still held: release is a separate, authorised step.",
  );
}

/** Independent verification. Rejection sends the job back for rework. */
export async function verifyWorkOrderAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const workOrderId = field(formData, "work_order_id");
  const decision = field(formData, "decision");
  const notes = field(formData, "verification_notes");
  const target = backTo(workOrderId);

  if (!can(user.role, "verify")) fail(target, "You are not authorised to verify repairs.");
  if (!["verify", "reject"].includes(decision)) fail(target, "Choose verify or reject.");
  if (decision === "reject" && notes.length < 10) fail(target, "Explain what failed verification (at least 10 characters).");

  await withOrg(user.organizationId, async (db) => {
    const order = await lockWorkOrder(db, workOrderId);
    if (order.status !== "awaiting_verification") {
      fail(target, "This work order is not awaiting verification.");
    }
    const check = checkVerifier({
      role: user.role,
      requiresVerification: order.requires_verification,
      repairerId: order.repair_completed_by,
      verifierId: user.userId,
      status: order.status,
    });
    if (!check.ok) fail(target, check.message);

    if (decision === "reject") {
      await advance(db, {
        organizationId: user.organizationId,
        order,
        to: "in_progress",
        actorId: user.userId,
        kind: "verification_rejected",
        note: notes,
        extraSql: "verified_by = NULL, verified_at = NULL, verification_notes = $3",
        extraParams: [notes],
      });
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "work_order.verification_rejected",
        entityType: "work_order",
        entityId: workOrderId,
        summary: `${user.name} rejected verification of ${order.code}: ${notes}`,
      });
      await notifyManagers(db, {
        organizationId: user.organizationId,
        title: `${order.code} failed verification`,
        body: `${notes}. The asset remains held.`,
        link: `${PAGE}?order=${workOrderId}`,
        excludeUserId: user.userId,
      });
      return;
    }

    await advance(db, {
      organizationId: user.organizationId,
      order,
      to: "verified",
      actorId: user.userId,
      kind: "verification_passed",
      note: notes,
      extraSql: "verified_by = $3, verified_at = now(), verification_notes = $4",
      extraParams: [user.userId, notes],
    });
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "work_order.verified",
      entityType: "work_order",
      entityId: workOrderId,
      summary: `${user.name} verified the repair on ${order.resource_name} (${order.code})`,
      metadata: { notes },
    });
    await notifyManagers(db, {
      organizationId: user.organizationId,
      title: `${order.code} verified — release still required`,
      body: `${order.resource_name} is verified but remains held until a facility manager releases it.`,
      link: `${PAGE}?order=${workOrderId}`,
      excludeUserId: user.userId,
    });
  }).catch((error: unknown) => {
    rethrowRedirect(error);
    fail(target, errorMessage(error, "Could not record the verification."));
  });

  revalidatePath(PAGE);
  ok(PAGE, decision === "verify" ? "Verification recorded. Release remains a separate step." : "Verification rejected. Rework required.");
}

/**
 * Authorised release: the only operation that clears the hold.
 *
 * It releases this work order's hold, resolves the linked incident, then re-runs
 * the full readiness evaluation. Any remaining block (expired calibration,
 * another hold, missing stock) aborts the whole transaction, so a release can
 * never leave an asset looking usable when it is not.
 */
export async function releaseWorkOrderAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const workOrderId = field(formData, "work_order_id");
  const note = field(formData, "release_note");
  const target = backTo(workOrderId);

  if (!can(user.role, "release")) fail(target, "Only administrators and facility managers can release an asset.");
  if (note.trim().length < 10) fail(target, "Record the release rationale (at least 10 characters).");

  await withOrg(user.organizationId, async (db) => {
    const order = await lockWorkOrder(db, workOrderId);
    if (!isReleasable(order.status, order.requires_verification)) {
      fail(
        target,
        order.status === "awaiting_verification"
          ? "Verification is still required before this asset can be released."
          : "Only a completed or verified repair can be released.",
      );
    }

    await db.query(
      `UPDATE resource_holds
          SET status = 'released', released_by = $2, released_at = now(), release_note = $3
        WHERE work_order_id = $1 AND status = 'active'`,
      [workOrderId, user.userId, note],
    );

    // The incident that raised the hold is closed by the release, not by the repair.
    await db.query(
      `UPDATE incidents
          SET status = 'resolved', resolved_at = now(), resolved_by = $2,
              resolution = coalesce(nullif(resolution, ''), $3)
        WHERE id = $1 AND status <> 'resolved'`,
      [order.incident_id, user.userId, `Released via ${order.code}: ${note}`],
    );

    const remaining = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM resource_holds WHERE resource_id = $1 AND status = 'active'",
      [order.resource_id],
    );
    if ((remaining.rows[0]?.count ?? 0) === 0) {
      await db.query(
        "UPDATE resources SET status = 'ready' WHERE id = $1 AND status = 'maintenance'",
        [order.resource_id],
      );
    }

    // Final gate, including the safety incidents and calibration that are not
    // overridable. Runs after the release so it evaluates the resulting state.
    const readiness = evaluateReadiness(await loadReadinessSnapshot(db, order.resource_id, new Date()));
    if (readiness.blocked.length > 0) {
      throw new Error(
        `Release blocked: ${readiness.blocked
          .map((reason) => `${reason.title} — ${reason.action}`)
          .join(" ")} The hold has not been released.`,
      );
    }

    await advance(db, {
      organizationId: user.organizationId,
      order,
      to: "closed",
      actorId: user.userId,
      kind: "released",
      note,
      extraSql: "downtime_end = now(), closed_by = $3, closed_at = now()",
      extraParams: [user.userId],
    });

    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "work_order.released",
      entityType: "work_order",
      entityId: workOrderId,
      summary: `${user.name} released ${order.resource_name} after ${order.code}`,
      metadata: { note, verifiedBy: user.userId, readiness: readiness.state },
    });

    const followers = await db.query<{ user_id: string; email: string }>(
      `SELECT DISTINCT u.id AS user_id, u.email
         FROM bookings b JOIN users u ON u.id = b.user_id
        WHERE b.resource_id = $1 AND b.status IN ('requested', 'confirmed') AND b.ends_at > now()`,
      [order.resource_id],
    );
    for (const follower of followers.rows) {
      await notifyWithEmail(db, {
        organizationId: user.organizationId,
        userId: follower.user_id,
        email: follower.email,
        title: `${order.resource_name} is available again`,
        body: `${order.code} was verified and released. Your upcoming booking can proceed subject to the usual checks.`,
        link: "/bookings",
        relatedType: "work_order",
        relatedId: workOrderId,
      });
    }
  }).catch((error: unknown) => {
    rethrowRedirect(error);
    fail(target, errorMessage(error, "Could not release the asset."));
  });

  revalidatePath(PAGE);
  revalidatePath("/readiness");
  revalidatePath("/operations");
  revalidatePath("/resources");
  ok(target, "Asset released and work order closed.");
}

/** Reopen a closed or verified job. Reinstates the hold. */
export async function reopenWorkOrderAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const workOrderId = field(formData, "work_order_id");
  const reason = field(formData, "reason");
  const target = backTo(workOrderId);

  if (!can(user.role, "reopen")) fail(target, "Only administrators and facility managers can reopen a work order.");
  if (reason.trim().length < 10) fail(target, "Give the reason for reopening (at least 10 characters).");

  await withOrg(user.organizationId, async (db) => {
    const order = await lockWorkOrder(db, workOrderId);
    await advance(db, {
      organizationId: user.organizationId,
      order,
      to: "in_progress",
      actorId: user.userId,
      kind: "reopened",
      note: reason,
      extraSql: "closed_by = NULL, closed_at = NULL, downtime_end = NULL, verified_by = NULL, verified_at = NULL",
    });
    await raiseHold(db, {
      organizationId: user.organizationId,
      resourceId: order.resource_id,
      workOrderId,
      incidentId: order.incident_id,
      kind: "maintenance",
      title: `Reopened: ${order.title}`,
      reason: `Work order ${order.code} reopened: ${reason}`,
      actorId: user.userId,
    });
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "work_order.reopened",
      entityType: "work_order",
      entityId: workOrderId,
      summary: `${user.name} reopened ${order.code}: ${reason}`,
    });
  }).catch((error: unknown) => {
    rethrowRedirect(error);
    fail(target, errorMessage(error, "Could not reopen the work order."));
  });

  revalidatePath(PAGE);
  revalidatePath("/readiness");
  ok(target, "Work order reopened and the asset is held again.");
}

/* ------------------------------------------------------------------ */
/* Emergency override                                                 */
/* ------------------------------------------------------------------ */

export type OverrideResult = { bookings: number; notified: number; unavailable: number };

export async function createEmergencyOverrideAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const resourceId = field(formData, "resource_id");
  const actionRaw = field(formData, "action");
  const scope = field(formData, "scope");
  const reason = field(formData, "reason");
  const expiresRaw = optionalField(formData, "expires_at");
  const condition = field(formData, "condition");
  const target = PAGE;

  if (!can(user.role, "override")) fail(target, "Only administrators and facility managers can record an emergency override.");
  if (!resourceId) fail(target, "Choose the asset this override applies to.");
  if (!(OVERRIDE_ACTIONS as readonly string[]).includes(actionRaw)) fail(target, "Choose an override action.");
  const action = actionRaw as OverrideAction;
  if (scope.length < 5) fail(target, "Describe the scope of the override (at least 5 characters).");
  if (reason.trim().length < MIN_OVERRIDE_REASON) {
    fail(target, `Give a human-readable reason of at least ${MIN_OVERRIDE_REASON} characters.`);
  }

  const expiresAt = expiresRaw ? parseDateInput(expiresRaw) : null;
  if (expiresRaw && !expiresAt) fail(target, "Enter a valid expiry date and time.");
  if (expiresAt && expiresAt.getTime() <= Date.now()) fail(target, "The expiry must be in the future.");
  if (expiresAt && expiresAt.getTime() > Date.now() + 30 * 86_400_000) fail(target, "An override cannot run for more than 30 days.");
  if (overrideNeedsWindow(action) && !expiresAt) {
    fail(target, "This action needs an expiry: it changes what people can do until a known time.");
  }

  let affected = 0;
  await withOrg(user.organizationId, async (db) => {
    const resource = await db.query<{ id: string; name: string; status: string }>(
      "SELECT id, name, status FROM resources WHERE id = $1 FOR UPDATE",
      [resourceId],
    );
    const asset = resource.rows[0];
    if (!asset) fail(target, "That asset does not exist in this workspace.");

    if (condition) {
      const incident = await db.query("SELECT 1 FROM incidents WHERE id = $1 AND resource_id = $2", [
        condition,
        resourceId,
      ]);
      if (incident.rows.length === 0) fail(target, "That incident is not recorded against this asset.");
    }

    const readiness = evaluateReadiness(await loadReadinessSnapshot(db, resourceId, new Date()));
    const blockedCodes = readiness.blocked.map((entry) => entry.code);
    const refusals = overrideBlockedBy(blockedCodes, action);
    if (refusals.length > 0) {
      fail(
        target,
        `An emergency override cannot bypass: ${refusals
          .map((code) => code.replace(/_/g, " "))
          .join(", ")}. Resolve the condition instead.`,
      );
    }

    const inserted = await db.query<{ id: string }>(
      `INSERT INTO emergency_overrides
         (organization_id, resource_id, incident_id, action, scope, reason,
          previous_state, resulting_state, starts_at, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10)
       RETURNING id`,
      [
        user.organizationId,
        resourceId,
        condition || null,
        action,
        scope,
        reason,
        JSON.stringify({
          resourceStatus: asset.status,
          readiness: readiness.state,
          blocked: blockedCodes,
        }),
        JSON.stringify({
          action,
          scope,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          restrictionActive: action === "restrict_resource",
        }),
        expiresAt,
        user.userId,
      ],
    );
    const overrideId = inserted.rows[0].id;

    // Affected bookings: everything live on this asset inside the override window.
    const windowEnd = expiresAt ?? new Date(Date.now() + 7 * 86_400_000);
    const bookings = await db.query<{
      id: string;
      user_id: string;
      email: string;
      name: string;
      status: string;
      starts_at: Date;
      ends_at: Date;
    }>(
      `SELECT b.id, b.user_id, u.email, u.name, b.status, b.starts_at, b.ends_at
         FROM bookings b JOIN users u ON u.id = b.user_id
        WHERE b.resource_id = $1 AND b.status IN ('requested', 'confirmed')
          AND b.ends_at > now() AND b.starts_at < $2
        ORDER BY b.starts_at
        FOR UPDATE OF b`,
      [resourceId, windowEnd],
    );

    const mutates = action === "cancel_bookings";
    for (const booking of bookings.rows) {
      if (mutates) {
        await db.query(
          `UPDATE bookings SET status = 'cancelled', cancelled_by = $2, cancelled_at = now(), cancel_reason = $3
            WHERE id = $1`,
          [booking.id, user.userId, `${scope} — ${reason}`],
        );
      }
      const delivery = await notifyWithEmail(db, {
        organizationId: user.organizationId,
        userId: booking.user_id,
        email: booking.email,
        title: mutates
          ? `${asset.name}: booking cancelled`
          : action === "relocate_bookings"
            ? `${asset.name}: your booking needs a new slot`
            : `${asset.name}: operational notice`,
        body: `${scope}. ${reason}`,
        link: "/bookings",
        relatedType: "emergency_override",
        relatedId: overrideId,
      });

      await db.query(
        `INSERT INTO emergency_override_bookings
           (organization_id, override_id, booking_id, user_id, status_before, status_after,
            starts_at, ends_at, notification_status, notified_at, notification_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          user.organizationId,
          overrideId,
          booking.id,
          booking.user_id,
          booking.status,
          mutates ? "cancelled" : booking.status,
          booking.starts_at,
          booking.ends_at,
          delivery.status === "sent" ? "sent" : delivery.status,
          delivery.status === "sent" ? new Date() : null,
          delivery.note,
        ],
      );
      affected += 1;
    }

    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "emergency_override.created",
      entityType: "emergency_override",
      entityId: overrideId,
      summary: `${user.name} recorded ${action.replace(/_/g, " ")} on ${asset.name}: ${reason}`,
      metadata: {
        action,
        scope,
        reason,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        affectedBookings: affected,
        previousState: { resourceStatus: asset.status, readiness: readiness.state, blocked: blockedCodes },
      },
    });

    await notifyManagers(db, {
      organizationId: user.organizationId,
      title: `Emergency override on ${asset.name}`,
      body: `${action.replace(/_/g, " ")} — ${scope}. ${affected} affected booking(s).`,
      link: PAGE,
      excludeUserId: user.userId,
    });
  }).catch((error: unknown) => {
    rethrowRedirect(error);
    fail(target, errorMessage(error, "Could not record the override."));
  });

  revalidatePath(PAGE);
  revalidatePath("/readiness");
  revalidatePath("/bookings");
  ok(PAGE, `Override recorded${affected > 0 ? ` with ${affected} affected booking${affected === 1 ? "" : "s"}` : ""}.`);
}

export async function revokeEmergencyOverrideAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const overrideId = field(formData, "override_id");
  const reason = field(formData, "revoke_reason");
  const target = PAGE;

  if (!can(user.role, "override")) fail(target, "Only administrators and facility managers can revoke an override.");
  if (reason.trim().length < 10) fail(target, "Record why the override is being revoked (at least 10 characters).");

  await withOrg(user.organizationId, async (db) => {
    const override = await db.query<{ id: string; resource_id: string; action: string; revoked_at: Date | null }>(
      "SELECT id, resource_id, action, revoked_at FROM emergency_overrides WHERE id = $1 FOR UPDATE",
      [overrideId],
    );
    if (!override.rows[0]) fail(target, "That override does not exist in this workspace.");
    if (override.rows[0].revoked_at) fail(target, "This override has already been revoked.");

    await db.query(
      "UPDATE emergency_overrides SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1",
      [overrideId, user.userId, reason],
    );
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "emergency_override.revoked",
      entityType: "emergency_override",
      entityId: overrideId,
      summary: `${user.name} revoked an override: ${reason}`,
      metadata: { reason },
    });
  }).catch((error: unknown) => {
    rethrowRedirect(error);
    fail(target, errorMessage(error, "Could not revoke the override."));
  });

  revalidatePath(PAGE);
  revalidatePath("/readiness");
  ok(target, "Override revoked.");
}
