// Operational-readiness tests.
//
// Two layers, same split as the rest of the suite:
//   1. Pure evaluator tests — lib/readiness.ts takes a snapshot, so every rule
//      (calibration, safety holds, maintenance windows, stock) is asserted
//      directly with no clock or database involved.
//   2. Real-database tests — a throwaway database is built from the baseline
//      schema plus every migration, then the real server actions are driven
//      through the stubbed Next.js request layer. Booking creation, approval and
//      check-in are exercised end to end, including concurrent stock deduction.
//
// The development and demo databases are never touched.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { applyBaseline, applyMigrations, grantAppRole } from "../db/migration-runner.mjs";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export{}", shortCircuit: true };
    }
    if (specifier === "next/cache") {
      return {
        url: "data:text/javascript,export function revalidatePath(){};export function revalidateTag(){};",
        shortCircuit: true,
      };
    }
    if (specifier === "next/navigation") {
      return {
        url:
          "data:text/javascript," +
          "export function redirect(url){const e=new Error('STUB_REDIRECT');e.url=String(url);e.isStubRedirect=true;throw e;}" +
          "export function permanentRedirect(url){redirect(url);}" +
          "export function notFound(){const e=new Error('STUB_NOT_FOUND');e.isStubNotFound=true;throw e;}",
        shortCircuit: true,
      };
    }
    if (specifier === "next/headers") {
      return {
        url:
          "data:text/javascript," +
          "export async function cookies(){if(!globalThis.__rosCookies) throw new Error('cookie store not initialised');return globalThis.__rosCookies;}" +
          "export async function headers(){return new Headers();}",
        shortCircuit: true,
      };
    }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const adminUrl = process.env.ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/resourceos";
const appUrl = process.env.DATABASE_URL ?? "postgres://resourceos_app:app_dev_password@localhost:5432/resourceos";
const TEST_DB = process.env.READINESS_TEST_DATABASE_NAME ?? "resourceos_readiness_test";

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

process.env.DATABASE_URL = withDatabase(appUrl, TEST_DB);

const readiness = await import("../lib/readiness.ts");
const bookings = await import("../lib/actions/bookings.ts");
const readinessActions = await import("../lib/actions/readiness.ts");
const { pool, withOrg } = await import("../lib/db.ts");

const ORG_A = "11111111-0000-4000-8000-0000000a0001";
const ORG_B = "22222222-0000-4000-8000-0000000b0001";

const USERS = {
  admin: { id: "11111111-1111-4000-8000-0000000a0101", email: "admin.ro@example.edu", name: "Readiness Admin", org: ORG_A, role: "admin" },
  manager: { id: "11111111-2222-4000-8000-0000000a0102", email: "manager.ro@example.edu", name: "Readiness Manager", org: ORG_A, role: "manager" },
  member: { id: "11111111-3333-4000-8000-0000000a0103", email: "member.ro@example.edu", name: "Readiness Member", org: ORG_A, role: "member" },
  other: { id: "22222222-1111-4000-8000-0000000b0101", email: "admin.rb@example.edu", name: "Beta Admin", org: ORG_B, role: "admin" },
};

const R_CAL = "11111111-aaaa-4000-8000-0000000c0001"; // requires calibration
const R_STOCK = "11111111-bbbb-4000-8000-0000000c0002"; // consumable-gated
const R_BETA = "22222222-cccc-4000-8000-0000000c0003"; // other tenant

const CONSUMABLE = "11111111-dddd-4000-8000-0000000d0001";

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function actAs(who) {
  globalThis.__rosCookies = {
    value: `token-${who.email}`,
    get(name) {
      return name === "ros_session" ? { name, value: this.value } : undefined;
    },
    set() {},
    delete() {},
  };
}

function form(fields) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
  return data;
}

async function redirectOf(run) {
  try {
    await run();
  } catch (error) {
    if (error?.isStubRedirect) return error.url;
    throw error;
  }
  throw new Error("expected the action to redirect");
}

function flash(url) {
  const parsed = new URL(url, "http://localhost");
  return { path: parsed.pathname, ok: parsed.searchParams.get("ok"), error: parsed.searchParams.get("error") };
}

const istDay = (offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );

const adminMain = new Client({ connectionString: withDatabase(adminUrl, "postgres") });
const admin = new Client({ connectionString: withDatabase(adminUrl, TEST_DB) });
const appRoleClient = new Client({ connectionString: withDatabase(appUrl, TEST_DB) });

async function resetBookings() {
  await admin.query("DELETE FROM consumable_movements WHERE organization_id = $1", [ORG_A]);
  await admin.query("DELETE FROM bookings WHERE organization_id = $1", [ORG_A]);
  await admin.query("DELETE FROM unmet_demand_events WHERE organization_id = $1", [ORG_A]);
  await admin.query("DELETE FROM incidents WHERE organization_id = $1", [ORG_A]);
  await admin.query("DELETE FROM blackout_periods WHERE organization_id = $1", [ORG_A]);
  await admin.query("DELETE FROM calibration_records WHERE organization_id = $1", [ORG_A]);
  await admin.query("UPDATE consumables SET stock = 5 WHERE id = $1", [CONSUMABLE]);
}

/* ------------------------------------------------------------------ */
/* 1. Pure evaluator                                                   */
/* ------------------------------------------------------------------ */

function snapshot(overrides = {}) {
  return {
    resource: {
      id: R_CAL,
      name: "Confocal Microscope",
      status: "ready",
      requiresCalibration: false,
      trainingCourseId: null,
      trainingName: null,
      ...overrides.resource,
    },
    calibration: overrides.calibration ?? null,
    openIncidents: overrides.openIncidents ?? [],
    activeBlackout: overrides.activeBlackout ?? null,
    consumables: overrides.consumables ?? [],
    at: new Date("2026-10-30T05:00:00Z"),
  };
}

test("a clean asset is ready with no reasons", () => {
  const result = readiness.evaluateReadiness(snapshot());
  assert.equal(result.state, "ready");
  assert.deepEqual(result.reasons, []);
});

test("required calibration with no record blocks use", () => {
  const result = readiness.evaluateReadiness(
    snapshot({ resource: { requiresCalibration: true } }),
  );
  assert.equal(result.state, "blocked");
  assert.equal(result.blocked[0].code, "calibration_missing");
});

test("expired calibration blocks and names the expiry date", () => {
  const result = readiness.evaluateReadiness(
    snapshot({
      resource: { requiresCalibration: true },
      calibration: { validUntil: "2026-10-12", result: "pass" },
    }),
  );
  assert.equal(result.state, "blocked");
  assert.equal(result.blocked[0].code, "calibration_expired");
  assert.match(result.blocked[0].detail, /12 Oct 2026/);
  assert.match(result.blocked[0].action, /Record the current calibration/);
});

test("a failed calibration blocks even when the date is in the future", () => {
  const result = readiness.evaluateReadiness(
    snapshot({
      resource: { requiresCalibration: true },
      calibration: { validUntil: "2027-06-01", result: "fail" },
    }),
  );
  assert.equal(result.blocked[0].code, "calibration_failed");
});

test("calibration expiring inside the warning window is a warning, not a block", () => {
  const result = readiness.evaluateReadiness(
    snapshot({
      resource: { requiresCalibration: true },
      calibration: { validUntil: "2026-11-05", result: "pass" },
    }),
  );
  assert.equal(result.state, "warnings");
  assert.equal(result.warnings[0].code, "calibration_due_soon");
  assert.equal(result.blocked.length, 0);
});

test("calibration is ignored for assets that do not require it", () => {
  const result = readiness.evaluateReadiness(
    snapshot({
      resource: { requiresCalibration: false },
      calibration: { validUntil: "2020-01-01", result: "fail" },
    }),
  );
  assert.equal(result.state, "ready");
});

test("a high-severity open incident is a hard hold; lower severity is a warning", () => {
  const high = readiness.evaluateReadiness(
    snapshot({ openIncidents: [{ severity: "high", title: "Laser interlock failure" }] }),
  );
  assert.equal(high.state, "blocked");
  assert.equal(high.blocked[0].code, "safety_hold");

  const medium = readiness.evaluateReadiness(
    snapshot({ openIncidents: [{ severity: "medium", title: "Stage drift" }] }),
  );
  assert.equal(medium.state, "warnings");
  assert.equal(medium.warnings[0].code, "incident_open");
});

test("an active maintenance window blocks", () => {
  const result = readiness.evaluateReadiness(
    snapshot({ activeBlackout: { reason: "Chiller replacement", endsAt: new Date("2026-10-31T12:00:00Z") } }),
  );
  assert.equal(result.state, "blocked");
  assert.equal(result.blocked[0].code, "maintenance_hold");
  assert.match(result.blocked[0].detail, /Chiller replacement/);
});

test("a mandatory consumable below the session quantity blocks; optional stock only warns", () => {
  const short = readiness.evaluateReadiness(
    snapshot({
      consumables: [
        { consumableId: "c1", name: "PLA filament", unit: "kg", stock: 0.5, minStock: 1, required: 2, mandatory: true },
      ],
    }),
  );
  assert.equal(short.state, "blocked");
  assert.match(short.blocked[0].detail, /0.5 kg in stock, 2 kg required/);

  const optional = readiness.evaluateReadiness(
    snapshot({
      consumables: [
        { consumableId: "c2", name: "Gloves", unit: "box", stock: 0.5, minStock: 1, required: 2, mandatory: false },
      ],
    }),
  );
  assert.equal(optional.state, "warnings");
  assert.equal(optional.warnings[0].code, "consumable_low_c2");
});

test("blocked outranks warnings and lists every distinct cause", () => {
  const result = readiness.evaluateReadiness(
    snapshot({
      resource: { requiresCalibration: true },
      calibration: { validUntil: "2026-01-01", result: "pass" },
      openIncidents: [{ severity: "medium", title: "Minor leak" }],
    }),
  );
  assert.equal(result.state, "blocked");
  assert.deepEqual(
    result.reasons.map((reason) => reason.code).sort(),
    ["calibration_expired", "incident_open"],
  );
});

/* ------------------------------------------------------------------ */
/* 2. Database-backed enforcement                                      */
/* ------------------------------------------------------------------ */

before(async () => {
  await adminMain.connect();
  await adminMain.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await adminMain.query(`CREATE DATABASE ${TEST_DB}`);

  const appRole = new URL(appUrl).username;
  const roleExists = await adminMain.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [appRole]);
  if (roleExists.rowCount === 0) {
    const password = decodeURIComponent(new URL(appUrl).password);
    await adminMain.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${password.replace(/'/g, "''")}'`);
  }

  await admin.connect();
  await applyBaseline(admin);
  await applyMigrations(admin);
  await grantAppRole(admin, appUrl);

  await admin.query(
    `INSERT INTO organizations (id, name, slug, timezone, open_hour, close_hour) VALUES
       ($1, 'Readiness Alpha Institute', 'readiness-alpha', 'Asia/Kolkata', 8, 20),
       ($2, 'Readiness Beta Institute', 'readiness-beta', 'Asia/Kolkata', 8, 18)`,
    [ORG_A, ORG_B],
  );

  for (const user of Object.values(USERS)) {
    await admin.query("INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')", [
      user.id,
      user.email,
      user.name,
    ]);
    await admin.query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)",
      [user.org, user.id, user.role],
    );
    await admin.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '2 hours')",
      [user.id, hashToken(`token-${user.email}`)],
    );
  }

  await admin.query(
    `INSERT INTO resources (id, organization_id, code, name, category, status, requires_calibration, max_hours_per_booking)
     VALUES
       ($1, $3, 'CAL-01', 'Confocal Microscope', 'Imaging', 'ready', true, 4),
       ($2, $3, 'STK-01', '3D Printer', 'Prototyping', 'ready', false, 8),
       ($4, $5, 'BETA-01', 'Beta Only Instrument', 'Imaging', 'ready', false, 4)`,
    [R_CAL, R_STOCK, ORG_A, R_BETA, ORG_B],
  );

  // Open every weekday so the booking window is never the failing condition.
  for (const resourceId of [R_CAL, R_STOCK, R_BETA]) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      await admin.query(
        "INSERT INTO availability_rules (organization_id, resource_id, weekday, opens_at, closes_at) VALUES ($1, $2, $3, '08:00', '20:00')",
        [resourceId === R_BETA ? ORG_B : ORG_A, resourceId, weekday],
      );
    }
  }

  await admin.query(
    `INSERT INTO consumables (id, organization_id, code, name, unit, stock, min_stock)
     VALUES ($1, $2, 'FIL-01', 'PLA filament', 'kg', 5, 2)`,
    [CONSUMABLE, ORG_A],
  );
  await admin.query(
    `INSERT INTO resource_consumables (organization_id, resource_id, consumable_id, qty_per_session, mandatory)
     VALUES ($1, $2, $3, 2, true)`,
    [ORG_A, R_STOCK, CONSUMABLE],
  );
});

after(async () => {
  await pool.end().catch(() => {});
  await appRoleClient.end().catch(() => {});
  await admin.end().catch(() => {});
  await adminMain.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
  await adminMain.end().catch(() => {});
});

async function book(resourceId, extra = {}) {
  return bookings.createBookingAction(
    form({
      resource_id: resourceId,
      date: istDay(2),
      start: "10:00",
      hours: "2",
      purpose: "Readiness test session",
      attendees: "1",
      request_key: `key-${Math.random().toString(36).slice(2)}`,
      ...extra,
    }),
  );
}

test("booking is blocked when required calibration has no record, and the refusal is recorded as unmet demand", async () => {
  await resetBookings();
  actAs(USERS.member);
  const url = await redirectOf(() => book(R_CAL));
  const message = flash(url).error ?? "";

  assert.match(message, /No calibration on record/);
  assert.match(message, /Record a valid calibration result/);

  const { rows } = await admin.query(
    "SELECT reason FROM unmet_demand_events WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1",
    [ORG_A],
  );
  assert.equal(rows[0]?.reason, "not_ready");
});

test("recording a valid calibration reopens booking, and the calibration is audited", async () => {
  await resetBookings();
  actAs(USERS.manager);
  const calUrl = await redirectOf(() =>
    readinessActions.recordCalibrationAction(
      form({
        resource_id: R_CAL,
        performed_on: istDay(-30),
        valid_until: istDay(330),
        result: "pass",
        provider: "Metrology cell",
        certificate_ref: "CAL-2026-118",
      }),
    ),
  );
  assert.match(flash(calUrl).ok ?? "", /Calibration recorded/);

  actAs(USERS.member);
  const bookingUrl = await redirectOf(() => book(R_CAL));
  assert.equal(flash(bookingUrl).path, "/bookings");
  assert.match(flash(bookingUrl).ok ?? "", /Booked|confirmed|requested/i);

  const audit = await admin.query(
    "SELECT action FROM audit_events WHERE organization_id = $1 AND action = 'calibration.recorded'",
    [ORG_A],
  );
  assert.equal(audit.rowCount, 1);
});

test("expired calibration blocks booking with a named date", async () => {
  await resetBookings();
  await admin.query(
    `INSERT INTO calibration_records (organization_id, resource_id, performed_on, valid_until, result)
     VALUES ($1, $2, '2025-10-12', '2026-10-12', 'pass')`,
    [ORG_A, R_CAL],
  );
  actAs(USERS.member);
  const message = flash(await redirectOf(() => book(R_CAL))).error ?? "";
  assert.match(message, /Calibration expired/);
  assert.match(message, /12 Oct 2026/);
});

test("a member cannot record calibration; a manager can", async () => {
  await resetBookings();
  actAs(USERS.member);
  const denied = flash(
    await redirectOf(() =>
      readinessActions.recordCalibrationAction(
        form({ resource_id: R_CAL, performed_on: istDay(0), valid_until: istDay(365), result: "pass" }),
      ),
    ),
  );
  assert.match(denied.error ?? "", /Only facility staff can record a calibration/);

  const count = await admin.query("SELECT count(*)::int AS n FROM calibration_records WHERE organization_id = $1", [ORG_A]);
  assert.equal(count.rows[0].n, 0);
});

test("a mandatory consumable below its session quantity blocks booking, and stock restores it", async () => {
  await resetBookings();
  await admin.query("UPDATE consumables SET stock = 1 WHERE id = $1", [CONSUMABLE]);

  actAs(USERS.member);
  const blocked = flash(await redirectOf(() => book(R_STOCK))).error ?? "";
  assert.match(blocked, /PLA filament out of stock/);
  assert.match(blocked, /1 kg in stock, 2 kg required/);

  actAs(USERS.manager);
  const adjusted = flash(
    await redirectOf(() =>
      readinessActions.adjustStockAction(form({ consumable_id: CONSUMABLE, delta: "25", note: "Delivery" })),
    ),
  );
  assert.match(adjusted.ok ?? "", /Stock updated/);

  actAs(USERS.member);
  const allowed = await redirectOf(() => book(R_STOCK));
  assert.equal(flash(allowed).path, "/bookings");
});

test("approval is refused when readiness regresses while the request waits", async () => {
  await resetBookings();
  await admin.query("UPDATE resources SET requires_approval = true WHERE id = $1", [R_STOCK]);

  actAs(USERS.member);
  const requested = await redirectOf(() => book(R_STOCK, { request_key: `approval-${Date.now()}` }));
  assert.equal(flash(requested).path, "/bookings");

  const { rows } = await admin.query(
    "SELECT id FROM bookings WHERE organization_id = $1 AND status = 'requested' ORDER BY created_at DESC LIMIT 1",
    [ORG_A],
  );
  const bookingId = rows[0].id;

  await admin.query(
    `INSERT INTO incidents (organization_id, resource_id, reported_by, severity, status, title)
     VALUES ($1, $2, $3, 'high', 'open', 'Extruder jam with smoke')`,
    [ORG_A, R_STOCK, USERS.member.id],
  );

  actAs(USERS.manager);
  const refused = flash(
    await redirectOf(() => bookings.decideBookingAction(form({ booking_id: bookingId, decision: "approve", note: "ok" }))),
  );
  assert.match(refused.error ?? "", /Cannot approve/);
  assert.match(refused.error ?? "", /Safety hold/);

  const stillRequested = await admin.query("SELECT status FROM bookings WHERE id = $1", [bookingId]);
  assert.equal(stillRequested.rows[0].status, "requested");

  // Resolving the incident is what restores readiness — the hold is not cleared by
  // the approval attempt itself.
  await admin.query("UPDATE incidents SET status = 'resolved', resolved_at = now() WHERE organization_id = $1", [ORG_A]);
  const approved = flash(
    await redirectOf(() => bookings.decideBookingAction(form({ booking_id: bookingId, decision: "approve", note: "ok" }))),
  );
  assert.match(approved.ok ?? "", /approved/i);

  await admin.query("UPDATE resources SET requires_approval = false WHERE id = $1", [R_STOCK]);
});

test("check-in is re-checked against a safety hold raised after approval", async () => {
  await resetBookings();
  const startsAt = new Date(Date.now() - 5 * 60_000);
  const endsAt = new Date(Date.now() + 55 * 60_000);
  const { rows } = await admin.query(
    `INSERT INTO bookings (organization_id, resource_id, user_id, starts_at, ends_at, status, purpose)
     VALUES ($1, $2, $3, $4, $5, 'confirmed', 'Check-in test') RETURNING id`,
    [ORG_A, R_STOCK, USERS.member.id, startsAt, endsAt],
  );
  const bookingId = rows[0].id;

  await admin.query(
    `INSERT INTO incidents (organization_id, resource_id, reported_by, severity, status, title)
     VALUES ($1, $2, $3, 'high', 'open', 'Coolant leak')`,
    [ORG_A, R_STOCK, USERS.member.id],
  );

  actAs(USERS.member);
  const blocked = flash(
    await redirectOf(() => bookings.checkInAction(form({ booking_id: bookingId, back_to: "/bookings" }))),
  );
  assert.match(blocked.error ?? "", /Check-in blocked/);
  assert.match(blocked.error ?? "", /Safety hold/);

  const sessions = await admin.query("SELECT count(*)::int AS n FROM usage_sessions WHERE booking_id = $1", [bookingId]);
  assert.equal(sessions.rows[0].n, 0);

  await admin.query("UPDATE incidents SET status = 'resolved', resolved_at = now() WHERE organization_id = $1", [ORG_A]);
  const okUrl = await redirectOf(() =>
    bookings.checkInAction(form({ booking_id: bookingId, back_to: "/bookings" })),
  );
  assert.match(flash(okUrl).ok ?? "", /Checked in/);
});

test("check-in consumes required stock exactly once, even when retried", async () => {
  await resetBookings();
  await admin.query("UPDATE consumables SET stock = 5 WHERE id = $1", [CONSUMABLE]);
  const startsAt = new Date(Date.now() - 5 * 60_000);
  const endsAt = new Date(Date.now() + 55 * 60_000);
  const { rows } = await admin.query(
    `INSERT INTO bookings (organization_id, resource_id, user_id, starts_at, ends_at, status, purpose)
     VALUES ($1, $2, $3, $4, $5, 'confirmed', 'Consumption test') RETURNING id`,
    [ORG_A, R_STOCK, USERS.member.id, startsAt, endsAt],
  );
  const bookingId = rows[0].id;

  actAs(USERS.member);
  await redirectOf(() => bookings.checkInAction(form({ booking_id: bookingId, back_to: "/bookings" })));

  const afterFirst = await admin.query("SELECT stock::text FROM consumables WHERE id = $1", [CONSUMABLE]);
  assert.equal(Number(afterFirst.rows[0].stock), 3);

  // A retry of the same check-in must not deduct again.
  const again = await withOrg(ORG_A, (db) =>
    readiness.consumeRequiredConsumables(db, {
      organizationId: ORG_A,
      bookingId,
      resourceId: R_STOCK,
      actorId: USERS.member.id,
    }),
  );
  assert.equal(again.length, 0);

  const afterRetry = await admin.query("SELECT stock::text FROM consumables WHERE id = $1", [CONSUMABLE]);
  assert.equal(Number(afterRetry.rows[0].stock), 3);

  const movements = await admin.query(
    "SELECT count(*)::int AS n FROM consumable_movements WHERE booking_id = $1 AND reason = 'consumption'",
    [bookingId],
  );
  assert.equal(movements.rows[0].n, 1);
});

test("two sessions competing for the last units cannot drive stock negative", async () => {
  await resetBookings();
  await admin.query("UPDATE consumables SET stock = 2 WHERE id = $1", [CONSUMABLE]);

  const created = [];
  // Non-overlapping windows: this test is about stock contention, not booking
  // overlap (which the exclusion constraint already covers elsewhere).
  for (const offset of [0, 3]) {
    const startsAt = new Date(Date.now() - 5 * 60_000 - offset * 3_600_000);
    const { rows } = await admin.query(
      `INSERT INTO bookings (organization_id, resource_id, user_id, starts_at, ends_at, status, purpose)
       VALUES ($1, $2, $3, $4, $5, 'confirmed', 'Concurrency test') RETURNING id`,
      [ORG_A, R_STOCK, USERS.member.id, startsAt, new Date(startsAt.getTime() + 2 * 3_600_000)],
    );
    created.push(rows[0].id);
  }

  const results = await Promise.allSettled(
    created.map((bookingId) =>
      withOrg(ORG_A, (db) =>
        readiness.consumeRequiredConsumables(db, {
          organizationId: ORG_A,
          bookingId,
          resourceId: R_STOCK,
          actorId: USERS.member.id,
        }),
      ),
    ),
  );

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one session may take the last units");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /required to start this session/);

  const stock = await admin.query("SELECT stock::text FROM consumables WHERE id = $1", [CONSUMABLE]);
  assert.equal(Number(stock.rows[0].stock), 0);
});

test("another tenant cannot read readiness for a resource it does not own", async () => {
  actAs(USERS.admin);
  await assert.rejects(
    () => readiness.getResourceReadiness(ORG_A, R_BETA),
    /Resource not found/,
  );
});

test("row-level security hides calibration and stock rows without tenant context", async () => {
  await appRoleClient.connect();
  const withoutContext = await appRoleClient.query(
    "SELECT (SELECT count(*)::int FROM calibration_records) AS cal, (SELECT count(*)::int FROM consumables) AS con",
  );
  assert.equal(withoutContext.rows[0].cal, 0);
  assert.equal(withoutContext.rows[0].con, 0);

  await appRoleClient.query("BEGIN");
  await appRoleClient.query("SELECT set_config('app.current_organization_id', $1, true)", [ORG_A]);
  const scoped = await appRoleClient.query("SELECT count(*)::int AS n FROM consumables");
  await appRoleClient.query("COMMIT");
  assert.ok(scoped.rows[0].n > 0);
});

test("a member cannot change stock", async () => {
  actAs(USERS.member);
  const denied = flash(
    await redirectOf(() =>
      readinessActions.adjustStockAction(form({ consumable_id: CONSUMABLE, delta: "5", note: "nope" })),
    ),
  );
  assert.match(denied.error ?? "", /Only facility staff can change stock/);
});
