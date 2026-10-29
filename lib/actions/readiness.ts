"use server";

import { revalidatePath } from "next/cache";
import { withOrg, isUniqueViolation } from "../db";
import { requireUser } from "../auth";
import { canManage, isStaff } from "../roles";
import { notifyManagers, recordAudit } from "../audit";
import { fail, field, ok, optionalField } from "../action-utils";

const READINESS = "/readiness";
const CONSUMABLES = "/consumables";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RESULTS = new Set(["pass", "conditional", "fail"]);

function decimal(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(READINESS, `${label} must be a number.`);
  return Math.round(parsed * 100) / 100;
}

/** Records a calibration result and re-evaluates readiness immediately. */
export async function recordCalibrationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const resourceId = field(formData, "resource_id");
  const performedOn = field(formData, "performed_on");
  const validUntil = field(formData, "valid_until");
  const result = field(formData, "result") || "pass";
  const provider = field(formData, "provider");
  const certificateRef = field(formData, "certificate_ref");
  const notes = field(formData, "notes");
  const backTo = resourceId ? `/readiness?resource=${resourceId}` : READINESS;

  if (!isStaff(user.role)) fail(backTo, "Only facility staff can record a calibration result.");
  if (!resourceId) fail(backTo, "Choose the asset this calibration belongs to.");
  if (!DATE.test(performedOn) || !DATE.test(validUntil)) {
    fail(backTo, "Enter both the calibration date and the date it stays valid until.");
  }
  if (validUntil < performedOn) fail(backTo, "The valid-until date cannot be before the calibration date.");
  if (!RESULTS.has(result)) fail(backTo, "Choose pass, conditional or fail.");
  if (certificateRef.length > 120) fail(backTo, "The certificate reference must be 120 characters or fewer.");
  if (notes.length > 1000) fail(backTo, "Notes must be 1,000 characters or fewer.");

  await withOrg(user.organizationId, async (db) => {
    const resource = await db.query<{ name: string }>("SELECT name FROM resources WHERE id = $1", [resourceId]);
    if (resource.rows.length === 0) fail(backTo, "That asset does not exist in this workspace.");

    const inserted = await db.query<{ id: string }>(
      `INSERT INTO calibration_records
         (organization_id, resource_id, performed_on, valid_until, result, provider, certificate_ref, notes, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [user.organizationId, resourceId, performedOn, validUntil, result, provider, certificateRef, notes, user.userId],
    );

    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "calibration.recorded",
      entityType: "resource",
      entityId: resourceId,
      summary: `${user.name} recorded a ${result} calibration for ${resource.rows[0].name}, valid to ${validUntil}`,
      metadata: { calibrationId: inserted.rows[0].id, result, performedOn, validUntil, certificateRef },
    });

    if (result !== "pass") {
      await notifyManagers(db, {
        organizationId: user.organizationId,
        title: `Calibration ${result}: ${resource.rows[0].name}`,
        body: `${user.name} recorded a ${result} calibration. Bookings remain subject to the readiness rules.`,
        link: `/readiness?resource=${resourceId}`,
        excludeUserId: user.userId,
      });
    }
  });

  revalidatePath(READINESS);
  revalidatePath(`/resources/${resourceId}`);
  ok(backTo, "Calibration recorded. Readiness recalculated.");
}

/** Turns the calibration requirement on or off for an asset. */
export async function setCalibrationRequirementAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const resourceId = field(formData, "resource_id");
  const requires = field(formData, "requires_calibration") === "on" || field(formData, "requires_calibration") === "1";
  const intervalRaw = optionalField(formData, "calibration_interval_days");
  const backTo = resourceId ? `/readiness?resource=${resourceId}` : READINESS;

  if (!canManage(user.role)) fail(backTo, "Only administrators and facility managers can change calibration policy.");
  if (!resourceId) fail(backTo, "Choose an asset.");
  const interval = intervalRaw ? Number(intervalRaw) : null;
  if (interval !== null && (!Number.isFinite(interval) || interval <= 0)) {
    fail(backTo, "The calibration interval must be a positive number of days.");
  }

  await withOrg(user.organizationId, async (db) => {
    const updated = await db.query<{ name: string }>(
      `UPDATE resources
          SET requires_calibration = $2, calibration_interval_days = $3
        WHERE id = $1
        RETURNING name`,
      [resourceId, requires, requires ? interval : null],
    );
    if (updated.rows.length === 0) fail(backTo, "That asset does not exist in this workspace.");

    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "calibration.policy_changed",
      entityType: "resource",
      entityId: resourceId,
      summary: `${user.name} set calibration requirement for ${updated.rows[0].name} to ${requires ? "required" : "not required"}`,
      metadata: { requiresCalibration: requires, intervalDays: requires ? interval : null },
    });
  });

  revalidatePath(READINESS);
  revalidatePath(`/resources/${resourceId}`);
  ok(backTo, requires ? "Calibration is now required for this asset." : "Calibration is no longer required.");
}

export async function createConsumableAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const code = field(formData, "code").trim().toUpperCase();
  const name = field(formData, "name").trim();
  const unit = field(formData, "unit").trim() || "unit";
  const stockRaw = field(formData, "stock") || "0";
  const minRaw = field(formData, "min_stock") || "0";
  const supplier = field(formData, "supplier").trim();
  const purchaseRef = field(formData, "purchase_ref").trim();

  if (!isStaff(user.role)) fail(CONSUMABLES, "Only facility staff can manage consumables.");
  if (!code || !/^[A-Z0-9._-]{2,24}$/.test(code)) {
    fail(CONSUMABLES, "Use a 2–24 character code made of letters, numbers, dot, dash or underscore.");
  }
  if (name.length < 2) fail(CONSUMABLES, "Give the consumable a name of at least 2 characters.");
  if (unit.length > 16) fail(CONSUMABLES, "The unit must be 16 characters or fewer.");

  const stock = decimal(stockRaw, "Opening stock");
  const minStock = decimal(minRaw, "Minimum stock");
  if (stock < 0 || minStock < 0) fail(CONSUMABLES, "Stock figures cannot be negative.");

  try {
    await withOrg(user.organizationId, async (db) => {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO consumables (organization_id, code, name, unit, stock, min_stock, supplier, purchase_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [user.organizationId, code, name, unit, stock, minStock, supplier, purchaseRef],
      );

      if (stock > 0) {
        await db.query(
          `INSERT INTO consumable_movements (organization_id, consumable_id, delta, reason, actor_id, note)
           VALUES ($1, $2, $3, 'purchase', $4, 'Opening stock')`,
          [user.organizationId, inserted.rows[0].id, stock, user.userId],
        );
      }

      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "consumable.created",
        entityType: "consumable",
        entityId: inserted.rows[0].id,
        summary: `${user.name} added consumable ${code} — ${name}`,
        metadata: { stock, minStock, unit },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) fail(CONSUMABLES, `A consumable with code ${code} already exists.`);
    throw error;
  }

  revalidatePath(CONSUMABLES);
  ok(CONSUMABLES, `${name} added to the consumables catalogue.`);
}

/** Records a signed stock movement. Stock can never go below zero. */
export async function adjustStockAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const consumableId = field(formData, "consumable_id");
  const deltaRaw = field(formData, "delta");
  const note = field(formData, "note").trim();

  if (!isStaff(user.role)) fail(CONSUMABLES, "Only facility staff can change stock.");
  if (!consumableId) fail(CONSUMABLES, "Choose a consumable.");

  const delta = decimal(deltaRaw, "Quantity");
  if (delta === 0) fail(CONSUMABLES, "Enter a quantity above or below zero.");
  if (Math.abs(delta) > 1_000_000) fail(CONSUMABLES, "That quantity is too large.");

  await withOrg(user.organizationId, async (db) => {
    const row = await db.query<{ name: string; unit: string; stock: string }>(
      "SELECT name, unit, stock::text FROM consumables WHERE id = $1 FOR UPDATE",
      [consumableId],
    );
    const item = row.rows[0];
    if (!item) fail(CONSUMABLES, "That consumable does not exist in this workspace.");

    const current = Number(item.stock);
    const next = Math.round((current + delta) * 100) / 100;
    if (next < 0) {
      fail(
        CONSUMABLES,
        `${item.name} has ${current} ${item.unit} in stock, so it cannot be reduced by ${Math.abs(delta)}.`,
      );
    }

    await db.query("UPDATE consumables SET stock = $2, updated_at = now() WHERE id = $1", [consumableId, next]);
    await db.query(
      `INSERT INTO consumable_movements (organization_id, consumable_id, delta, reason, actor_id, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        user.organizationId,
        consumableId,
        delta,
        delta > 0 ? "purchase" : "adjustment",
        user.userId,
        note || (delta > 0 ? "Stock received" : "Stock corrected"),
      ],
    );
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "consumable.stock_adjusted",
      entityType: "consumable",
      entityId: consumableId,
      summary: `${user.name} adjusted ${item.name} by ${delta > 0 ? "+" : ""}${delta} ${item.unit} (now ${next})`,
      metadata: { before: current, delta, after: next, note },
    });
  });

  revalidatePath(CONSUMABLES);
  revalidatePath(READINESS);
  ok(CONSUMABLES, "Stock updated and recorded.");
}

export async function linkConsumableAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const resourceId = field(formData, "resource_id");
  const consumableId = field(formData, "consumable_id");
  const qtyRaw = field(formData, "qty_per_session") || "1";
  const mandatory = field(formData, "mandatory") === "on" || field(formData, "mandatory") === "1";
  const backTo = resourceId ? `/readiness?resource=${resourceId}` : READINESS;

  if (!canManage(user.role)) fail(backTo, "Only administrators and facility managers can change resource requirements.");
  if (!resourceId || !consumableId) fail(backTo, "Choose both an asset and a consumable.");

  const qty = decimal(qtyRaw, "Quantity per session");
  if (qty <= 0) fail(backTo, "Quantity per session must be greater than zero.");

  await withOrg(user.organizationId, async (db) => {
    const resource = await db.query<{ name: string }>("SELECT name FROM resources WHERE id = $1", [resourceId]);
    const consumable = await db.query<{ name: string }>("SELECT name FROM consumables WHERE id = $1", [consumableId]);
    if (resource.rows.length === 0 || consumable.rows.length === 0) {
      fail(backTo, "That asset or consumable does not exist in this workspace.");
    }

    await db.query(
      `INSERT INTO resource_consumables (organization_id, resource_id, consumable_id, qty_per_session, mandatory)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (resource_id, consumable_id)
       DO UPDATE SET qty_per_session = EXCLUDED.qty_per_session, mandatory = EXCLUDED.mandatory`,
      [user.organizationId, resourceId, consumableId, qty, mandatory],
    );

    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "consumable.linked",
      entityType: "resource",
      entityId: resourceId,
      summary: `${user.name} requires ${qty} ${consumable.rows[0].name} per session on ${resource.rows[0].name}`,
      metadata: { consumableId, qty, mandatory },
    });
  });

  revalidatePath(READINESS);
  revalidatePath(`/resources/${resourceId}`);
  ok(backTo, "Resource requirement saved.");
}

export async function unlinkConsumableAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const resourceId = field(formData, "resource_id");
  const linkId = field(formData, "link_id");
  const backTo = resourceId ? `/readiness?resource=${resourceId}` : READINESS;

  if (!canManage(user.role)) fail(backTo, "Only administrators and facility managers can change resource requirements.");
  if (!linkId) fail(backTo, "Choose the requirement to remove.");

  await withOrg(user.organizationId, async (db) => {
    const removed = await db.query<{ resource_id: string; name: string }>(
      `DELETE FROM resource_consumables rc
        USING consumables c
        WHERE rc.id = $1 AND c.id = rc.consumable_id
        RETURNING rc.resource_id, c.name`,
      [linkId],
    );
    if (removed.rows.length === 0) fail(backTo, "That requirement has already been removed.");

    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "consumable.unlinked",
      entityType: "resource",
      entityId: removed.rows[0].resource_id,
      summary: `${user.name} removed the ${removed.rows[0].name} requirement`,
      metadata: { linkId },
    });
  });

  revalidatePath(READINESS);
  revalidatePath(`/resources/${resourceId}`);
  ok(backTo, "Requirement removed.");
}
