import "server-only";
import { withOrg } from "../db";
import {
  evaluateReadiness,
  loadReadinessSnapshot,
  type ReadinessResult,
} from "../readiness";

export type ReadinessBoardRow = {
  id: string;
  code: string;
  name: string;
  category: string;
  status: string;
  requiresCalibration: boolean;
  calibrationValidUntil: string | null;
  readiness: ReadinessResult;
};

export type ReadinessBoard = {
  rows: ReadinessBoardRow[];
  counts: { blocked: number; warnings: number; ready: number };
};

/**
 * Every live resource with its readiness verdict.
 *
 * The evaluation runs per asset inside one tenant transaction. At the scale this
 * product targets (tens to low hundreds of assets) that is a handful of indexed
 * queries per asset and stays well inside a page render.
 */
export async function getReadinessBoard(organizationId: string): Promise<ReadinessBoard> {
  return withOrg(organizationId, async (db) => {
    const resources = await db.query<{ id: string; code: string; name: string; category: string; status: string }>(
      `SELECT id, code, name, category, status
         FROM resources
        WHERE status <> 'retired'
        ORDER BY name`,
    );

    const at = new Date();
    const rows: ReadinessBoardRow[] = [];
    for (const resource of resources.rows) {
      const snapshot = await loadReadinessSnapshot(db, resource.id, at);
      rows.push({
        id: resource.id,
        code: resource.code,
        name: resource.name,
        category: resource.category,
        status: resource.status,
        requiresCalibration: snapshot.resource.requiresCalibration,
        calibrationValidUntil: snapshot.calibration?.validUntil ?? null,
        readiness: evaluateReadiness(snapshot),
      });
    }

    const order = { blocked: 0, warnings: 1, ready: 2 } as const;
    rows.sort((a, b) => order[a.readiness.state] - order[b.readiness.state] || a.name.localeCompare(b.name));

    return {
      rows,
      counts: {
        blocked: rows.filter((row) => row.readiness.state === "blocked").length,
        warnings: rows.filter((row) => row.readiness.state === "warnings").length,
        ready: rows.filter((row) => row.readiness.state === "ready").length,
      },
    };
  });
}

export type CalibrationRow = {
  id: string;
  performedOn: string;
  validUntil: string;
  result: string;
  provider: string;
  certificateRef: string;
  notes: string;
  recordedByName: string | null;
  createdAt: Date;
};

export async function getResourceOperationalDetail(
  organizationId: string,
  resourceId: string,
): Promise<{
  readiness: ReadinessResult;
  requiresCalibration: boolean;
  calibrationHistory: CalibrationRow[];
  consumables: Array<{ linkId: string; consumableId: string; name: string; unit: string; stock: number; minStock: number; required: number; mandatory: boolean }>;
} | null> {
  return withOrg(organizationId, async (db) => {
    const exists = await db.query<{ requires_calibration: boolean }>(
      "SELECT requires_calibration FROM resources WHERE id = $1",
      [resourceId],
    );
    if (exists.rows.length === 0) return null;

    const at = new Date();
    const snapshot = await loadReadinessSnapshot(db, resourceId, at);

    const [history, links] = await Promise.all([
      db.query<{
        id: string;
        performed_on: string;
        valid_until: string;
        result: string;
        provider: string;
        certificate_ref: string;
        notes: string;
        recorded_by_name: string | null;
        created_at: Date;
      }>(
        `SELECT c.id, c.performed_on::text, c.valid_until::text, c.result, c.provider,
                c.certificate_ref, c.notes, u.name AS recorded_by_name, c.created_at
           FROM calibration_records c
           LEFT JOIN users u ON u.id = c.recorded_by
          WHERE c.resource_id = $1
          ORDER BY c.valid_until DESC, c.created_at DESC
          LIMIT 12`,
        [resourceId],
      ),
      db.query<{
        link_id: string;
        consumable_id: string;
        name: string;
        unit: string;
        stock: string;
        min_stock: string;
        qty_per_session: string;
        mandatory: boolean;
      }>(
        `SELECT rc.id AS link_id, c.id AS consumable_id, c.name, c.unit,
                c.stock::text, c.min_stock::text, rc.qty_per_session::text, rc.mandatory
           FROM resource_consumables rc
           JOIN consumables c ON c.id = rc.consumable_id
          WHERE rc.resource_id = $1
          ORDER BY c.name`,
        [resourceId],
      ),
    ]);

    return {
      readiness: evaluateReadiness(snapshot),
      requiresCalibration: snapshot.resource.requiresCalibration,
      calibrationHistory: history.rows.map((row) => ({
        id: row.id,
        performedOn: row.performed_on,
        validUntil: row.valid_until,
        result: row.result,
        provider: row.provider,
        certificateRef: row.certificate_ref,
        notes: row.notes,
        recordedByName: row.recorded_by_name,
        createdAt: row.created_at,
      })),
      consumables: links.rows.map((row) => ({
        linkId: row.link_id,
        consumableId: row.consumable_id,
        name: row.name,
        unit: row.unit,
        stock: Number(row.stock),
        minStock: Number(row.min_stock),
        required: Number(row.qty_per_session),
        mandatory: row.mandatory,
      })),
    };
  });
}

export type ConsumableRow = {
  id: string;
  code: string;
  name: string;
  unit: string;
  stock: number;
  minStock: number;
  supplier: string;
  purchaseRef: string;
  low: boolean;
  requiredBy: number;
};

export async function listConsumables(organizationId: string): Promise<ConsumableRow[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      code: string;
      name: string;
      unit: string;
      stock: string;
      min_stock: string;
      supplier: string;
      purchase_ref: string;
      required_by: number;
    }>(
      `SELECT c.id, c.code, c.name, c.unit, c.stock::text, c.min_stock::text,
              c.supplier, c.purchase_ref,
              (SELECT count(*)::int FROM resource_consumables rc WHERE rc.consumable_id = c.id) AS required_by
         FROM consumables c
        ORDER BY c.name`,
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      unit: row.unit,
      stock: Number(row.stock),
      minStock: Number(row.min_stock),
      supplier: row.supplier,
      purchaseRef: row.purchase_ref,
      low: Number(row.stock) < Number(row.min_stock),
      requiredBy: row.required_by,
    }));
  });
}

export type MovementRow = {
  id: string;
  consumableName: string;
  delta: number;
  unit: string;
  reason: string;
  note: string;
  actorName: string | null;
  createdAt: Date;
};

export async function listConsumableMovements(
  organizationId: string,
  limit = 20,
): Promise<MovementRow[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      name: string;
      unit: string;
      delta: string;
      reason: string;
      note: string;
      actor_name: string | null;
      created_at: Date;
    }>(
      `SELECT m.id, c.name, c.unit, m.delta::text, m.reason, m.note,
              u.name AS actor_name, m.created_at
         FROM consumable_movements m
         JOIN consumables c ON c.id = m.consumable_id
         LEFT JOIN users u ON u.id = m.actor_id
        ORDER BY m.created_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      id: row.id,
      consumableName: row.name,
      delta: Number(row.delta),
      unit: row.unit,
      reason: row.reason,
      note: row.note,
      actorName: row.actor_name,
      createdAt: row.created_at,
    }));
  });
}
