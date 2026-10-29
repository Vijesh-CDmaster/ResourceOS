/**
 * Adds operational-readiness fixtures to an isolated DEMO database:
 * calibration records, a consumable, a resource requirement and a stock level.
 *
 *   DEMO_DATABASE_URL=…/resourceos_demo DEMO_SEED_CONFIRM=yes \
 *     node --env-file=.env.local db/seed-readiness-demo.mjs
 *
 * Guards, mirroring db/seed-demo.mjs:
 *   - refuses unless the database name ends in _demo or _test
 *   - refuses unless DEMO_SEED_CONFIRM=yes
 *   - inserts only; never updates existing rows except where noted below
 *   - refuses to run twice once calibration records exist for the tenant
 *
 * Synthetic demonstration data. Not real institutional records.
 */
import { Client } from "pg";

const confirm = process.env.DEMO_SEED_CONFIRM;
const url =
  process.env.DEMO_DATABASE_URL ??
  "postgres://resourceos_app:app_dev_password@localhost:5432/resourceos_demo";

let databaseName;
try {
  databaseName = new URL(url).pathname.replace(/^\//, "");
} catch {
  console.error("DEMO_DATABASE_URL is not a valid connection string.");
  process.exit(1);
}

if (confirm !== "yes") {
  console.error("Refusing to run: set DEMO_SEED_CONFIRM=yes to acknowledge this writes demo data.");
  process.exit(1);
}
if (!/_demo$|_test$/.test(databaseName)) {
  console.error(`Refusing to run against "${databaseName}": the database name must end in _demo or _test.`);
  process.exit(1);
}

const client = new Client({ connectionString: url });

const DEMO = {
  sem: "SEM-01",
  xrd: "XRD-01",
  printer: "3DP-01",
  consumableCode: "FIL-175",
};

try {
  await client.connect();

  const org = await client.query(
    "SELECT id FROM organizations WHERE is_demo = true ORDER BY created_at LIMIT 1",
  );
  if (org.rowCount === 0) {
    console.error("No demo organisation found. Run db/seed-demo.mjs first.");
    process.exit(1);
  }
  const organizationId = org.rows[0].id;

  const existing = await client.query(
    "SELECT count(*)::int AS n FROM calibration_records WHERE organization_id = $1",
    [organizationId],
  );
  if (existing.rows[0].n > 0) {
    console.error("Calibration records already exist for this demo tenant; refusing to seed twice.");
    process.exit(1);
  }

  const resources = await client.query(
    "SELECT id, code FROM resources WHERE organization_id = $1 AND code = ANY($2::text[])",
    [organizationId, [DEMO.sem, DEMO.xrd, DEMO.printer]],
  );
  const byCode = Object.fromEntries(resources.rows.map((row) => [row.code, row.id]));
  if (!byCode[DEMO.printer]) {
    console.error("Expected demo assets (SEM-01, XRD-01, 3DP-01) were not found.");
    process.exit(1);
  }

  await client.query("BEGIN");

  // SEM-01: calibration required and current.
  await client.query("UPDATE resources SET requires_calibration = true, calibration_interval_days = 365 WHERE id = $1", [
    byCode[DEMO.sem],
  ]);
  await client.query(
    `INSERT INTO calibration_records
       (organization_id, resource_id, performed_on, valid_until, result, provider, certificate_ref, notes)
     VALUES ($1, $2, current_date - 120, current_date + 245, 'pass', 'Metrology cell', 'CAL-2026-044',
             'Synthetic demo record')`,
    [organizationId, byCode[DEMO.sem]],
  );

  // XRD-01: calibration required and EXPIRED — demonstrates a hard block.
  await client.query("UPDATE resources SET requires_calibration = true, calibration_interval_days = 180 WHERE id = $1", [
    byCode[DEMO.xrd],
  ]);
  await client.query(
    `INSERT INTO calibration_records
       (organization_id, resource_id, performed_on, valid_until, result, provider, certificate_ref, notes)
     VALUES ($1, $2, current_date - 400, current_date - 40, 'pass', 'Metrology cell', 'CAL-2025-117',
             'Synthetic demo record, deliberately expired')`,
    [organizationId, byCode[DEMO.xrd]],
  );

  // 3DP-01: calibration required and MISSING, plus a mandatory consumable that is short.
  await client.query("UPDATE resources SET requires_calibration = true, calibration_interval_days = 365 WHERE id = $1", [
    byCode[DEMO.printer],
  ]);
  const consumable = await client.query(
    `INSERT INTO consumables (organization_id, code, name, unit, stock, min_stock, supplier)
     VALUES ($1, $2, 'PLA filament 1.75 mm', 'kg', 0.4, 1, 'Demo Supplies')
     RETURNING id`,
    [organizationId, DEMO.consumableCode],
  );
  await client.query(
    `INSERT INTO resource_consumables (organization_id, resource_id, consumable_id, qty_per_session, mandatory)
     VALUES ($1, $2, $3, 1.2, true)`,
    [organizationId, byCode[DEMO.printer], consumable.rows[0].id],
  );
  await client.query(
    `INSERT INTO consumable_movements (organization_id, consumable_id, delta, reason, note)
     VALUES ($1, $2, 0.4, 'purchase', 'Opening stock (synthetic demo)')`,
    [organizationId, consumable.rows[0].id],
  );

  await client.query("COMMIT");

  console.log("Seeded readiness demo fixtures:");
  console.log("  SEM-01   calibration required, valid  → ready");
  console.log("  XRD-01   calibration expired          → blocked");
  console.log("  3DP-01   calibration missing + PLA short → blocked (two reasons)");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`Seeding failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
