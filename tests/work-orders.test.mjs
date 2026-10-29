// Work-order and emergency-override tests.
//
// Layers:
//   1. Pure lifecycle/permission rules from lib/work-orders.ts (no database).
//   2. Real database tests for the server actions, against a throwaway database
//      built from the baseline plus every migration.
//
// Two deliberate constraints learned from the schema:
//   * work_order_events and emergency_overrides are append-only, so tests never
//     delete them; each test asserts on the rows it created (by id/code) instead
//     of on global counts.
//   * tests must never touch the development or demo database. Only
//     resourceos_workorders_test is created and dropped.
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
const TEST_DB = process.env.WORK_ORDER_TEST_DATABASE_NAME ?? "resourceos_workorders_test";

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

process.env.DATABASE_URL = withDatabase(appUrl, TEST_DB);

const domain = await import("../lib/work-orders.ts");
const readiness = await import("../lib/readiness.ts");
const bookings = await import("../lib/actions/bookings.ts");
const actions = await import("../lib/actions/work-orders.ts");
const queries = await import("../lib/queries/work-orders.ts");
const { pool } = await import("../lib/db.ts");

const ORG_A = "33333333-0000-4000-8000-0000000a0001";
const ORG_B = "44444444-0000-4000-8000-0000000b0001";

const USERS = {
  admin: { id: "33333333-1111-4000-8000-0000000a0101", email: "admin.wo@example.edu", name: "Wren Admin", org: ORG_A, role: "admin" },
  manager: { id: "33333333-2222-4000-8000-0000000a0102", email: "manager.wo@example.edu", name: "Mira Manager", org: ORG_A, role: "manager" },
  tech: { id: "33333333-3333-4000-8000-0000000a0103", email: "tech.wo@example.edu", name: "Tomas Technician", org: ORG_A, role: "technician" },
  verifier: { id: "33333333-4444-4000-8000-0000000a0104", email: "verifier.wo@example.edu", name: "Vera Verifier", org: ORG_A, role: "technician" },
  member: { id: "33333333-5555-4000-8000-0000000a0105", email: "member.wo@example.edu", name: "Mason Member", org: ORG_A, role: "member" },
  adminB: { id: "44444444-1111-4000-8000-0000000b0101", email: "admin.wb@example.edu", name: "Beta Admin", org: ORG_B, role: "admin" },
};

const R_A = "33333333-aaaa-4000-8000-0000000c0001"; // repair completion leaves the hold
const R_B = "33333333-bbbb-4000-8000-0000000c0002"; // self-verification, rejection, rework
const R_C = "33333333-cccc-4000-8000-0000000c0003"; // full verified release
const R_NOVERIFY = "33333333-dddd-4000-8000-0000000c0004"; // policy: no independent verification
const R_CAL = "33333333-eeee-4000-8000-0000000c0005"; // expired calibration
const R_FREE = "33333333-ffff-4000-8000-0000000c0006"; // overrides and bookings
const R_BETA = "44444444-aaaa-4000-8000-0000000c0007";

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
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) data.set(key, String(value));
  }
  return data;
}

async function redirectOf(run) {
  try {
    await run();
  } catch (error) {
    if (error?.isStubRedirect) return { url: error.url };
    throw error;
  }
  throw new Error("expected the action to redirect");
}

function flash({ url }) {
  const parsed = new URL(url, "http://localhost");
  return {
    path: parsed.pathname,
    ok: parsed.searchParams.get("ok"),
    error: parsed.searchParams.get("error"),
    params: parsed.searchParams,
  };
}

const istDay = (offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );

/** A datetime-local value (institute time) for a JS date. */
function istInput(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

const adminMain = new Client({ connectionString: withDatabase(adminUrl, "postgres") });
const admin = new Client({ connectionString: withDatabase(adminUrl, TEST_DB) });
const appRoleClient = new Client({ connectionString: withDatabase(appUrl, TEST_DB) });

/* ------------------------------------------------------------------ */
/* 1. Pure rules                                                       */
/* ------------------------------------------------------------------ */

test("the lifecycle allows the documented moves and refuses jumps", () => {
  assert.equal(domain.canTransition("reported", "assigned"), true);
  assert.equal(domain.canTransition("reported", "in_progress"), false);
  assert.equal(domain.canTransition("assigned", "in_progress"), true);
  assert.equal(domain.canTransition("in_progress", "awaiting_verification"), true);
  assert.equal(domain.canTransition("repair_completed", "closed"), true);
  assert.equal(domain.canTransition("awaiting_verification", "verified"), true);
  assert.equal(domain.canTransition("awaiting_verification", "in_progress"), true);
  assert.equal(domain.canTransition("awaiting_verification", "closed"), false);
  assert.equal(domain.canTransition("verified", "closed"), true);
  assert.equal(domain.canTransition("closed", "in_progress"), true);
  assert.equal(domain.canTransition("closed", "verified"), false);
});

test("release is only possible from verified, or from repair_completed when no verification is required", () => {
  assert.equal(domain.isReleasable("verified", true), true);
  assert.equal(domain.isReleasable("awaiting_verification", true), false);
  assert.equal(domain.isReleasable("repair_completed", true), false);
  assert.equal(domain.isReleasable("repair_completed", false), true);
  assert.equal(domain.isReleasable("in_progress", false), false);
  assert.equal(domain.isReleasable("closed", false), false);
});

test("independent verification refuses the repairer but allows another verifier", () => {
  const self = domain.checkVerifier({
    role: "technician",
    requiresVerification: true,
    repairerId: USERS.tech.id,
    verifierId: USERS.tech.id,
    status: "awaiting_verification",
  });
  assert.equal(self.ok, false);
  assert.equal(self.code, "self_verification");

  const other = domain.checkVerifier({
    role: "technician",
    requiresVerification: true,
    repairerId: USERS.tech.id,
    verifierId: USERS.verifier.id,
    status: "awaiting_verification",
  });
  assert.equal(other.ok, true);

  const member = domain.checkVerifier({
    role: "member",
    requiresVerification: true,
    repairerId: USERS.tech.id,
    verifierId: USERS.member.id,
    status: "awaiting_verification",
  });
  assert.equal(member.code, "not_authorised");
});

test("an override may not bypass calibration, safety holds, retirement, quota or training", () => {
  const blocked = ["calibration_expired", "safety_hold", "resource_maintenance"];
  assert.deepEqual(domain.overrideBlockedBy(blocked, "scheduling_exception").sort(), [
    "calibration_expired",
    "safety_hold",
  ]);
  // Actions that only restrict or inform are always allowed: they grant nothing.
  assert.deepEqual(domain.overrideBlockedBy(blocked, "restrict_resource"), []);
  assert.deepEqual(domain.overrideBlockedBy(blocked, "communicate_downtime"), []);
});

/* ------------------------------------------------------------------ */
/* 2. Database setup                                                   */
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
       ($1, 'Work Order Alpha', 'wo-alpha', 'Asia/Kolkata', 8, 20),
       ($2, 'Work Order Beta', 'wo-beta', 'Asia/Kolkata', 8, 18)`,
    [ORG_A, ORG_B],
  );

  for (const user of Object.values(USERS)) {
    await admin.query("INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')", [
      user.id,
      user.email,
      user.name,
    ]);
    await admin.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)", [
      user.org,
      user.id,
      user.role,
    ]);
    await admin.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '2 hours')",
      [user.id, hashToken(`token-${user.email}`)],
    );
  }

  await admin.query(
    `INSERT INTO resources (id, organization_id, code, name, category, status, requires_calibration,
                            requires_independent_verification, max_hours_per_booking)
     VALUES
       ($1, $8, 'A-01', 'Alpha Instrument', 'Imaging', 'ready', false, true, 4),
       ($2, $8, 'B-01', 'Beta Instrument', 'Imaging', 'ready', false, true, 4),
       ($3, $8, 'C-01', 'Gamma Instrument', 'Imaging', 'ready', false, true, 4),
       ($4, $8, 'N-01', 'No Verify Instrument', 'Prototyping', 'ready', false, false, 4),
       ($5, $8, 'CAL-01', 'Calibrated Instrument', 'Imaging', 'ready', true, true, 4),
       ($6, $8, 'F-01', 'Free Instrument', 'Prototyping', 'ready', false, true, 4),
       ($7, $9, 'BETA-01', 'Beta Only Instrument', 'Imaging', 'ready', false, true, 4)`,
    [R_A, R_B, R_C, R_NOVERIFY, R_CAL, R_FREE, R_BETA, ORG_A, ORG_B],
  );

  for (const resourceId of [R_A, R_B, R_C, R_NOVERIFY, R_CAL, R_FREE, R_BETA]) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      await admin.query(
        "INSERT INTO availability_rules (organization_id, resource_id, weekday, opens_at, closes_at) VALUES ($1, $2, $3, '08:00', '20:00')",
        [resourceId === R_BETA ? ORG_B : ORG_A, resourceId, weekday],
      );
    }
  }

  // Expired calibration: repairing the hold must not clear this.
  await admin.query(
    `INSERT INTO calibration_records (organization_id, resource_id, performed_on, valid_until, result)
     VALUES ($1, $2, '2025-01-01', '2026-01-01', 'pass')`,
    [ORG_A, R_CAL],
  );
});

after(async () => {
  await pool.end().catch(() => {});
  await appRoleClient.end().catch(() => {});
  await admin.end().catch(() => {});
  await adminMain.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
  await adminMain.end().catch(() => {});
});

/** An incident owned by ORG_A on the given asset. */
async function seedIncident(resourceId, { severity = "high", title = "Fault reported by test" } = {}) {
  const { rows } = await admin.query(
    `INSERT INTO incidents (organization_id, resource_id, reported_by, severity, status, title, description)
     VALUES ($1, $2, $3, $4, 'open', $5, 'Synthetic test fault')
     RETURNING id`,
    [ORG_A, resourceId, USERS.member.id, severity, title],
  );
  return rows[0].id;
}

async function workOrder(incidentId) {
  const { rows } = await admin.query(
    "SELECT id, code, status, resource_id, incident_id, requires_verification, repair_completed_by FROM work_orders WHERE incident_id = $1",
    [incidentId],
  );
  return rows[0];
}

async function activeHoldCount(workOrderId) {
  const { rows } = await admin.query(
    "SELECT count(*)::int AS n FROM resource_holds WHERE work_order_id = $1 AND status = 'active'",
    [workOrderId],
  );
  return rows[0].n;
}

async function createOrder(resourceId, who = USERS.admin, extra = {}) {
  const incidentId = extra.incident_id ?? (await seedIncident(resourceId, extra.incident ?? {}));
  actAs(who);
  const result = await redirectOf(() =>
    actions.createWorkOrderAction(
      form({
        incident_id: incidentId,
        priority: "high",
        diagnosis: "Suspected coolant leak; must be pressure-tested before return to service.",
        ...extra.fields,
      }),
    ),
  );
  return { incidentId, result, order: await workOrder(incidentId) };
}

/* ------------------------------------------------------------------ */
/* 3. Conversion and permissions                                       */
/* ------------------------------------------------------------------ */

test("an open incident converts into exactly one work order, which holds the asset", async () => {
  const { incidentId, result, order } = await createOrder(R_A, USERS.admin);

  assert.match(flash(result).ok ?? "", /raised/i);
  assert.ok(order, "work order row exists");
  assert.match(order.code, /^WO-\d{4}-\d{4}$/);
  assert.equal(order.status, "reported");

  const resource = await admin.query("SELECT status FROM resources WHERE id = $1", [R_A]);
  assert.equal(resource.rows[0].status, "maintenance");

  assert.equal(await activeHoldCount(order.id), 1, "a hold is raised with the work order");

  const audit = await admin.query("SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'work_order.created'", [
    order.id,
  ]);
  assert.equal(audit.rowCount, 1);

  // A second conversion of the same incident is refused.
  actAs(USERS.admin);
  const duplicate = flash(
    await redirectOf(() =>
      actions.createWorkOrderAction(
        form({ incident_id: incidentId, priority: "normal", diagnosis: "duplicate attempt" }),
      ),
    ),
  );
  assert.match(duplicate.error ?? "", /already has work order/i);
});

test("a member cannot raise a work order and a technician cannot assign one", async () => {
  actAs(USERS.member);
  const denied = flash(
    await redirectOf(() =>
      actions.createWorkOrderAction(form({ resource_id: R_B, priority: "normal", diagnosis: "member attempt" })),
    ),
  );
  assert.match(denied.error ?? "", /Only facility staff can raise a work order/);

  const { order } = await createOrder(R_B, USERS.admin);
  actAs(USERS.tech);
  const assignDenied = flash(
    await redirectOf(() =>
      actions.assignWorkOrderAction(form({ work_order_id: order.id, assignee_id: USERS.tech.id })),
    ),
  );
  assert.match(assignDenied.error ?? "", /Only administrators and facility managers can assign/);

  // A manager may assign, and assignment moves reported → assigned.
  actAs(USERS.manager);
  const assigned = await redirectOf(() =>
    actions.assignWorkOrderAction(form({ work_order_id: order.id, assignee_id: USERS.tech.id })),
  );
  assert.match(flash(assigned).ok ?? "", /Assignment recorded/);

  const row = await admin.query("SELECT status, assigned_to FROM work_orders WHERE id = $1", [order.id]);
  assert.equal(row.rows[0].status, "assigned");
  assert.equal(row.rows[0].assigned_to, USERS.tech.id);
});

test("an invalid status transition is refused and leaves the row untouched", async () => {
  const { order } = await createOrder(R_A);
  assert.equal(order.status, "reported");

  actAs(USERS.tech);
  const skipped = flash(
    await redirectOf(() => actions.startWorkOrderAction(form({ work_order_id: order.id }))),
  );
  assert.match(skipped.error ?? "", /cannot move to "in_progress"/);

  const row = await admin.query("SELECT status FROM work_orders WHERE id = $1", [order.id]);
  assert.equal(row.rows[0].status, "reported");
});

test("escalation raises priority without skipping a lifecycle step", async () => {
  const { order } = await createOrder(R_A);
  actAs(USERS.tech);
  const escalated = await redirectOf(() =>
    actions.escalateWorkOrderAction(
      form({ work_order_id: order.id, note: "Safety-critical: the teaching lab cannot run without it." }),
    ),
  );
  assert.match(flash(escalated).ok ?? "", /escalated/i);

  const row = await admin.query("SELECT status, priority FROM work_orders WHERE id = $1", [order.id]);
  assert.equal(row.rows[0].status, "reported", "escalation is not a status jump");
  assert.equal(row.rows[0].priority, "urgent");

  const audit = await admin.query(
    "SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'work_order.escalated'",
    [order.id],
  );
  assert.equal(audit.rowCount, 1);
});

/* ------------------------------------------------------------------ */
/* 4. Repair completion, verification, rework                          */
/* ------------------------------------------------------------------ */

test("completing a repair does not clear the hold or make the asset bookable", async () => {
  const { order } = await createOrder(R_A);
  actAs(USERS.manager);
  await redirectOf(() =>
    actions.assignWorkOrderAction(form({ work_order_id: order.id, assignee_id: USERS.tech.id })),
  );
  actAs(USERS.tech);
  await redirectOf(() => actions.startWorkOrderAction(form({ work_order_id: order.id })));

  const completed = await redirectOf(() =>
    actions.completeRepairAction(
      form({
        work_order_id: order.id,
        repair_notes: "Replaced the coolant hose and pressure-tested to 4 bar.",
        parts_used: "Hose kit",
        labour_hours: "2.5",
        actual_cost: "4200",
      }),
    ),
  );
  assert.match(flash(completed).ok ?? "", /still held/i);

  const row = await admin.query(
    "SELECT status, repair_completed_by, actual_cost::text FROM work_orders WHERE id = $1",
    [order.id],
  );
  assert.equal(row.rows[0].status, "awaiting_verification", "verification required by policy");
  assert.equal(row.rows[0].repair_completed_by, USERS.tech.id);
  assert.equal(Number(row.rows[0].actual_cost), 4200);

  assert.equal(await activeHoldCount(order.id), 1, "repair completion does not release the hold");

  const verdict = await readiness.getResourceReadiness(ORG_A, R_A);
  assert.equal(verdict.state, "blocked");
  assert.ok(verdict.blocked.some((reason) => reason.code === "active_hold"));

  actAs(USERS.member);
  const booking = flash(
    await redirectOf(() =>
      bookings.createBookingAction(
        form({
          resource_id: R_A,
          date: istDay(2),
          start: "10:00",
          hours: "1",
          purpose: "Should remain blocked",
          attendees: "1",
          request_key: `wo-block-${Date.now()}`,
        }),
      ),
    ),
  );
  assert.match(booking.error ?? "", /hold|maintenance/i);
});

test("the repairer cannot verify their own work", async () => {
  const { order } = await createOrder(R_B);
  actAs(USERS.manager);
  await redirectOf(() =>
    actions.assignWorkOrderAction(form({ work_order_id: order.id, assignee_id: USERS.tech.id })),
  );
  actAs(USERS.tech);
  await redirectOf(() => actions.startWorkOrderAction(form({ work_order_id: order.id })));
  await redirectOf(() =>
    actions.completeRepairAction(
      form({ work_order_id: order.id, repair_notes: "Replaced the drive belt and re-tensioned it." }),
    ),
  );

  const self = flash(
    await redirectOf(() =>
      actions.verifyWorkOrderAction(form({ work_order_id: order.id, decision: "verify", verification_notes: "looks fine" })),
    ),
  );
  assert.match(self.error ?? "", /Independent verification is required/);

  const row = await admin.query("SELECT status, verified_by FROM work_orders WHERE id = $1", [order.id]);
  assert.equal(row.rows[0].status, "awaiting_verification");
  assert.equal(row.rows[0].verified_by, null);
});

test("rejected verification sends the job back for rework, and re-verification closes the loop", async () => {
  const { order } = await createOrder(R_B);
  actAs(USERS.manager);
  await redirectOf(() =>
    actions.assignWorkOrderAction(form({ work_order_id: order.id, assignee_id: USERS.tech.id })),
  );
  actAs(USERS.tech);
  await redirectOf(() => actions.startWorkOrderAction(form({ work_order_id: order.id })));
  await redirectOf(() =>
    actions.completeRepairAction(
      form({ work_order_id: order.id, repair_notes: "First attempt at the belt replacement." }),
    ),
  );

  actAs(USERS.verifier);
  const rejected = await redirectOf(() =>
    actions.verifyWorkOrderAction(
      form({
        work_order_id: order.id,
        decision: "reject",
        verification_notes: "Belt tension is still outside the service manual range.",
      }),
    ),
  );
  assert.match(flash(rejected).ok ?? "", /Rework required/i);

  const afterReject = await admin.query("SELECT status FROM work_orders WHERE id = $1", [order.id]);
  assert.equal(afterReject.rows[0].status, "in_progress");

  const events = await admin.query(
    "SELECT kind FROM work_order_events WHERE work_order_id = $1 AND kind = 'verification_rejected'",
    [order.id],
  );
  assert.equal(events.rowCount, 1);

  // Rework, then a second, independent verification.
  actAs(USERS.tech);
  await redirectOf(() =>
    actions.completeRepairAction(
      form({ work_order_id: order.id, repair_notes: "Re-tensioned the belt to the manual specification." }),
    ),
  );
  actAs(USERS.verifier);
  const verified = await redirectOf(() =>
    actions.verifyWorkOrderAction(
      form({ work_order_id: order.id, decision: "verify", verification_notes: "Tension and alignment checked." }),
    ),
  );
  assert.match(flash(verified).ok ?? "", /Verification recorded/);

  const row = await admin.query("SELECT status, verified_by FROM work_orders WHERE id = $1", [order.id]);
  assert.equal(row.rows[0].status, "verified");
  assert.equal(row.rows[0].verified_by, USERS.verifier.id);
});

/* ------------------------------------------------------------------ */
/* 5. Release                                                          */
/* ------------------------------------------------------------------ */

test("only a manager can release, and release clears the specific hold and resolves the incident", async () => {
  const { incidentId, order } = await createOrder(R_C);
  actAs(USERS.manager);
  await redirectOf(() =>
    actions.assignWorkOrderAction(form({ work_order_id: order.id, assignee_id: USERS.tech.id })),
  );
  actAs(USERS.tech);
  await redirectOf(() => actions.startWorkOrderAction(form({ work_order_id: order.id })));
  await redirectOf(() =>
    actions.completeRepairAction(
      form({ work_order_id: order.id, repair_notes: "Replaced the pump seal and ran a leak test." }),
    ),
  );

  // Verification is still pending: release must refuse.
  actAs(USERS.manager);
  const tooEarly = flash(
    await redirectOf(() =>
      actions.releaseWorkOrderAction(
        form({ work_order_id: order.id, release_note: "Trying to release before verification is complete." }),
      ),
    ),
  );
  assert.match(tooEarly.error ?? "", /Verification is still required/);

  actAs(USERS.verifier);
  await redirectOf(() =>
    actions.verifyWorkOrderAction(
      form({ work_order_id: order.id, decision: "verify", verification_notes: "Leak test passed at operating pressure." }),
    ),
  );

  // A technician may not release even after verifying.
  actAs(USERS.verifier);
  const denied = flash(
    await redirectOf(() =>
      actions.releaseWorkOrderAction(
        form({ work_order_id: order.id, release_note: "Technician trying to release without authority." }),
      ),
    ),
  );
  assert.match(denied.error ?? "", /Only administrators and facility managers can release/);

  actAs(USERS.manager);
  const released = await redirectOf(() =>
    actions.releaseWorkOrderAction(
      form({ work_order_id: order.id, release_note: "Verification accepted; asset returned to the booking pool." }),
    ),
  );
  assert.match(flash(released).ok ?? "", /released/i);

  const row = await admin.query(
    "SELECT status, closed_by, downtime_end FROM work_orders WHERE id = $1",
    [order.id],
  );
  assert.equal(row.rows[0].status, "closed");
  assert.equal(row.rows[0].closed_by, USERS.manager.id);
  assert.ok(row.rows[0].downtime_end, "downtime is closed on release");

  assert.equal(await activeHoldCount(order.id), 0);
  const incident = await admin.query("SELECT status, resolved_by FROM incidents WHERE id = $1", [incidentId]);
  assert.equal(incident.rows[0].status, "resolved");
  assert.equal(incident.rows[0].resolved_by, USERS.manager.id);

  const resource = await admin.query("SELECT status FROM resources WHERE id = $1", [R_C]);
  assert.equal(resource.rows[0].status, "ready");

  const verdict = await readiness.getResourceReadiness(ORG_A, R_C);
  assert.equal(verdict.state, "ready");

  const audit = await admin.query("SELECT metadata FROM audit_events WHERE entity_id = $1 AND action = 'work_order.released'", [
    order.id,
  ]);
  assert.equal(audit.rowCount, 1);
  assert.ok(audit.rows[0].metadata.note.includes("Verification accepted"));

  // The original booking path still works after release (regression).
  actAs(USERS.member);
  const booking = await redirectOf(() =>
    bookings.createBookingAction(
      form({
        resource_id: R_C,
        date: istDay(2),
        start: "10:00",
        hours: "1",
        purpose: "Post-release regression booking",
        attendees: "1",
        request_key: `wo-after-release-${Date.now()}`,
      }),
    ),
  );
  assert.match(flash(booking).ok ?? "", /booked/i);
});

test("an expired calibration still blocks release after the repair is verified", async () => {
  const { order } = await createOrder(R_CAL);
  actAs(USERS.manager);
  await redirectOf(() =>
    actions.assignWorkOrderAction(form({ work_order_id: order.id, assignee_id: USERS.tech.id })),
  );
  actAs(USERS.tech);
  await redirectOf(() => actions.startWorkOrderAction(form({ work_order_id: order.id })));
  await redirectOf(() =>
    actions.completeRepairAction(
      form({ work_order_id: order.id, repair_notes: "Replaced the detector board and confirmed it powers on." }),
    ),
  );
  actAs(USERS.verifier);
  await redirectOf(() =>
    actions.verifyWorkOrderAction(
      form({ work_order_id: order.id, decision: "verify", verification_notes: "Board replacement checked against the manual." }),
    ),
  );

  actAs(USERS.manager);
  const blocked = flash(
    await redirectOf(() =>
      actions.releaseWorkOrderAction(
        form({ work_order_id: order.id, release_note: "Attempting release while calibration is out of date." }),
      ),
    ),
  );
  assert.match(blocked.error ?? "", /Release blocked/);
  assert.match(blocked.error ?? "", /Calibration expired/);

  const row = await admin.query("SELECT status FROM work_orders WHERE id = $1", [order.id]);
  assert.equal(row.rows[0].status, "verified", "the transaction rolled back");
  assert.equal(await activeHoldCount(order.id), 1, "the hold was not released");

  const verdict = await readiness.getResourceReadiness(ORG_A, R_CAL);
  assert.ok(verdict.blocked.some((reason) => reason.code === "calibration_expired"));
  assert.ok(verdict.blocked.some((reason) => reason.code === "active_hold"));
});

test("when policy does not require independent verification, release is still explicit", async () => {
  const { order } = await createOrder(R_NOVERIFY);
  actAs(USERS.manager);
  await redirectOf(() =>
    actions.assignWorkOrderAction(form({ work_order_id: order.id, assignee_id: USERS.tech.id })),
  );
  actAs(USERS.tech);
  await redirectOf(() => actions.startWorkOrderAction(form({ work_order_id: order.id })));
  await redirectOf(() =>
    actions.completeRepairAction(
      form({ work_order_id: order.id, repair_notes: "Replaced the extruder nozzle and calibrated the offset." }),
    ),
  );

  const row = await admin.query("SELECT status FROM work_orders WHERE id = $1", [order.id]);
  assert.equal(row.rows[0].status, "repair_completed");
  assert.equal(await activeHoldCount(order.id), 1, "still held after sign-off");

  actAs(USERS.manager);
  const released = flash(
    await redirectOf(() =>
      actions.releaseWorkOrderAction(
        form({ work_order_id: order.id, release_note: "Signed off, no independent verification required by policy." }),
      ),
    ),
  );
  assert.match(released.ok ?? `error=${released.error}`, /released/i);
});

test("two simultaneous release attempts cannot both close the work order", async () => {
  const { order } = await createOrder(R_NOVERIFY);
  actAs(USERS.manager);
  await redirectOf(() =>
    actions.assignWorkOrderAction(form({ work_order_id: order.id, assignee_id: USERS.tech.id })),
  );
  actAs(USERS.tech);
  await redirectOf(() => actions.startWorkOrderAction(form({ work_order_id: order.id })));
  await redirectOf(() =>
    actions.completeRepairAction(
      form({ work_order_id: order.id, repair_notes: "Replaced the feed gear and verified the drive train." }),
    ),
  );

  actAs(USERS.manager);
  const attempt = () =>
    redirectOf(() =>
      actions.releaseWorkOrderAction(
        form({ work_order_id: order.id, release_note: "Concurrent release attempt from the test harness." }),
      ),
    );

  const results = await Promise.allSettled([attempt(), attempt()]);
  const urls = results.map((result) =>
    result.status === "fulfilled" ? JSON.stringify(flash(result.value)) : `rejected: ${result.reason?.message}`,
  );
  const succeeded = results.filter(
    (result) => result.status === "fulfilled" && flash(result.value).ok,
  );
  const refused = results.filter(
    (result) => result.status === "fulfilled" && flash(result.value).error,
  );
  assert.equal(succeeded.length, 1, `exactly one release succeeds: ${urls.join(" | ")}`);
  assert.equal(refused.length, 1, "the loser is told it failed");

  const released = await admin.query(
    "SELECT count(*)::int AS n FROM resource_holds WHERE work_order_id = $1 AND status = 'released'",
    [order.id],
  );
  assert.equal(released.rows[0].n, 1, "only one hold release is recorded");
});

test("a reopened work order holds the asset again", async () => {
  // The previous test on R_C closed its job; reopen that one.
  const closed = await admin.query(
    "SELECT id FROM work_orders WHERE resource_id = $1 AND status = 'closed' ORDER BY created_at DESC LIMIT 1",
    [R_C],
  );
  const target = closed.rows[0].id;

  actAs(USERS.manager);
  const reopened = await redirectOf(() =>
    actions.reopenWorkOrderAction(
      form({ work_order_id: target, reason: "Same fault returned during the next session." }),
    ),
  );
  assert.match(flash(reopened).ok ?? "", /reopened/i);

  const row = await admin.query("SELECT status FROM work_orders WHERE id = $1", [target]);
  assert.equal(row.rows[0].status, "in_progress");
  assert.equal(await activeHoldCount(target), 1);

  const verdict = await readiness.getResourceReadiness(ORG_A, R_C);
  assert.equal(verdict.state, "blocked");

  // Release the reopened job again so later tests see a consistent asset.
  actAs(USERS.tech);
  await redirectOf(() =>
    actions.completeRepairAction(
      form({ work_order_id: target, repair_notes: "Replaced the pump seal a second time and leak-tested." }),
    ),
  );
  actAs(USERS.verifier);
  await redirectOf(() =>
    actions.verifyWorkOrderAction(
      form({ work_order_id: target, decision: "verify", verification_notes: "Second leak test passed." }),
    ),
  );
  actAs(USERS.manager);
  await redirectOf(() =>
    actions.releaseWorkOrderAction(
      form({ work_order_id: target, release_note: "Reopened job verified and released after rework." }),
    ),
  );
});

/* ------------------------------------------------------------------ */
/* 6. Emergency override                                               */
/* ------------------------------------------------------------------ */

test("a member or technician cannot record an emergency override", async () => {
  for (const who of [USERS.member, USERS.tech]) {
    actAs(who);
    const denied = flash(
      await redirectOf(() =>
        actions.createEmergencyOverrideAction(
          form({
            resource_id: R_FREE,
            action: "operational_exception",
            scope: "Lab access",
            reason: "Trying to record an override without the required role.",
          }),
        ),
      ),
    );
    assert.match(denied.error ?? "", /Only administrators and facility managers/);
  }
});

test("an override requires a real reason and an expiry where it changes access", async () => {
  actAs(USERS.manager);
  const shortReason = flash(
    await redirectOf(() =>
      actions.createEmergencyOverrideAction(
        form({ resource_id: R_FREE, action: "operational_exception", scope: "Hallway", reason: "too short" }),
      ),
    ),
  );
  assert.match(shortReason.error ?? "", /at least 20 characters/);

  const noExpiry = flash(
    await redirectOf(() =>
      actions.createEmergencyOverrideAction(
        form({
          resource_id: R_FREE,
          action: "restrict_resource",
          scope: "Suspended pending inspection",
          reason: "Vibration reported by a user; taking it out of service until checked.",
        }),
      ),
    ),
  );
  assert.match(noExpiry.error ?? "", /needs an expiry/);

  const pastExpiry = flash(
    await redirectOf(() =>
      actions.createEmergencyOverrideAction(
        form({
          resource_id: R_FREE,
          action: "restrict_resource",
          scope: "Suspended pending inspection",
          reason: "Vibration reported by a user; taking it out of service until checked.",
          expires_at: istInput(new Date(Date.now() - 3_600_000)),
        }),
      ),
    ),
  );
  assert.match(pastExpiry.error ?? "", /expiry must be in the future/);
});

test("a scheduling override cannot bypass an expired calibration", async () => {
  actAs(USERS.manager);
  const refused = flash(
    await redirectOf(() =>
      actions.createEmergencyOverrideAction(
        form({
          resource_id: R_CAL,
          action: "scheduling_exception",
          scope: "Allow one session despite the calibration date",
          reason: "A researcher needs the instrument tonight and asked for an exception.",
          expires_at: istInput(new Date(Date.now() + 86_400_000)),
        }),
      ),
    ),
  );
  assert.match(refused.error ?? "", /cannot bypass/);
  assert.match(refused.error ?? "", /calibration expired/);
});

test("restricting a resource through an override blocks readiness until it is revoked", async () => {
  actAs(USERS.manager);
  const created = await redirectOf(() =>
    actions.createEmergencyOverrideAction(
      form({
        resource_id: R_FREE,
        action: "restrict_resource",
        scope: "Emergency restriction for the next shift",
        reason: "Interlock fault found during a routine walkthrough; keeping the bay closed.",
        expires_at: istInput(new Date(Date.now() + 3_600_000)),
      }),
    ),
  );
  assert.match(flash(created).ok ?? "", /Override recorded/);

  const verdict = await readiness.getResourceReadiness(ORG_A, R_FREE);
  assert.equal(verdict.state, "blocked");
  assert.ok(verdict.blocked.some((reason) => reason.code === "emergency_restriction"));

  const { rows } = await admin.query(
    "SELECT id, previous_state, resulting_state, created_by FROM emergency_overrides WHERE resource_id = $1 ORDER BY created_at DESC LIMIT 1",
    [R_FREE],
  );
  const override = rows[0];
  assert.equal(override.created_by, USERS.manager.id);
  assert.equal(override.previous_state.resourceStatus, "ready");
  assert.equal(override.resulting_state.restrictionActive, true);

  const audit = await admin.query("SELECT action FROM audit_events WHERE entity_id = $1", [override.id]);
  assert.ok(audit.rows.some((row) => row.action === "emergency_override.created"));

  const revoked = await redirectOf(() =>
    actions.revokeEmergencyOverrideAction(
      form({ override_id: override.id, revoke_reason: "Inspection cleared the interlock fault." }),
    ),
  );
  assert.match(flash(revoked).ok ?? "", /revoked/i);

  const after = await readiness.getResourceReadiness(ORG_A, R_FREE);
  assert.equal(after.state, "ready");
});

test("cancelling bookings through an override records affected bookings and an honest delivery status", async () => {
  // A live booking on a healthy asset.
  const startsAt = new Date(Date.now() + 86_400_000);
  startsAt.setUTCHours(5, 30, 0, 0); // 11:00 IST, inside the 08:00–20:00 window
  const endsAt = new Date(startsAt.getTime() + 3_600_000);
  const inserted = await admin.query(
    `INSERT INTO bookings (organization_id, resource_id, user_id, starts_at, ends_at, status, purpose)
     VALUES ($1, $2, $3, $4, $5, 'confirmed', 'Booking cancelled by emergency override test')
     RETURNING id`,
    [ORG_A, R_FREE, USERS.member.id, startsAt, endsAt],
  );
  const bookingId = inserted.rows[0].id;

  actAs(USERS.manager);
  const created = await redirectOf(() =>
    actions.createEmergencyOverrideAction(
      form({
        resource_id: R_FREE,
        action: "cancel_bookings",
        scope: "Cancelling all sessions tonight after a water leak",
        reason: "Water ingress near the bay; sessions must move until the area is dried and checked.",
        expires_at: istInput(new Date(Date.now() + 2 * 86_400_000)),
      }),
    ),
  );
  assert.match(flash(created).ok ?? "", /affected booking/);

  const booking = await admin.query("SELECT status, cancel_reason FROM bookings WHERE id = $1", [bookingId]);
  assert.equal(booking.rows[0].status, "cancelled");
  assert.match(booking.rows[0].cancel_reason ?? "", /Water ingress/);

  const override = await admin.query(
    "SELECT id FROM emergency_overrides WHERE resource_id = $1 AND action = 'cancel_bookings' ORDER BY created_at DESC LIMIT 1",
    [R_FREE],
  );
  const affected = await admin.query(
    "SELECT status_before, status_after, notification_status, notification_note FROM emergency_override_bookings WHERE override_id = $1 AND booking_id = $2",
    [override.rows[0].id, bookingId],
  );
  assert.equal(affected.rowCount, 1);
  assert.equal(affected.rows[0].status_before, "confirmed");
  assert.equal(affected.rows[0].status_after, "cancelled");
  assert.equal(affected.rows[0].notification_status, "unavailable");
  assert.match(affected.rows[0].notification_note, /not configured/i);

  // Email is recorded as unavailable, never as sent; in-app delivery is real.
  const outbox = await admin.query(
    "SELECT status, last_error FROM notification_outbox WHERE related_id = $1",
    [override.rows[0].id],
  );
  assert.ok(outbox.rowCount > 0);
  for (const row of outbox.rows) {
    assert.equal(row.status, "unavailable");
    assert.match(row.last_error, /SMTP_URL/);
  }
  const inApp = await admin.query(
    "SELECT title FROM notifications WHERE user_id = $1 AND title LIKE '%booking cancelled%' ORDER BY created_at DESC LIMIT 1",
    [USERS.member.id],
  );
  assert.equal(inApp.rowCount, 1);
});

test("an override cannot be edited or deleted after the fact", async () => {
  const { rows } = await admin.query("SELECT id, reason FROM emergency_overrides ORDER BY created_at LIMIT 1");
  const overrideId = rows[0].id;

  await assert.rejects(
    () => admin.query("UPDATE emergency_overrides SET reason = 'rewritten' WHERE id = $1", [overrideId]),
    /only revocation fields may change/,
  );
  await assert.rejects(
    () => admin.query("DELETE FROM emergency_overrides WHERE id = $1", [overrideId]),
    /append-only/,
  );

  const events = await admin.query("SELECT id FROM work_order_events ORDER BY created_at LIMIT 1");
  await assert.rejects(
    () => admin.query("UPDATE work_order_events SET note = 'rewritten' WHERE id = $1", [events.rows[0].id]),
    /append-only/,
  );
});

/* ------------------------------------------------------------------ */
/* 7. Tenant isolation                                                 */
/* ------------------------------------------------------------------ */

test("another tenant cannot read or operate on these work orders or overrides", async () => {
  const { incidentId, order } = await createOrder(R_B, USERS.admin);
  actAs(USERS.adminB);

  const read = await queries.getWorkOrder(ORG_B, order.id);
  assert.equal(read, null, "cross-tenant read returns nothing");

  const list = await queries.listWorkOrders(ORG_B);
  assert.equal(list.some((row) => row.id === order.id), false);

  const assign = flash(
    await redirectOf(() =>
      actions.assignWorkOrderAction(form({ work_order_id: order.id, assignee_id: USERS.adminB.id })),
    ),
  );
  assert.match(assign.error ?? "", /not found in this workspace/);

  const release = flash(
    await redirectOf(() =>
      actions.releaseWorkOrderAction(
        form({ work_order_id: order.id, release_note: "Cross-tenant release attempt by another institution." }),
      ),
    ),
  );
  assert.match(release.error ?? "", /not found in this workspace/);

  const override = flash(
    await redirectOf(() =>
      actions.createEmergencyOverrideAction(
        form({
          resource_id: R_BETA,
          action: "operational_exception",
          scope: "Cross tenant attempt",
          reason: "Attempting to operate on another institution's asset from the wrong tenant.",
          condition: incidentId,
        }),
      ),
    ),
  );
  assert.match(override.error ?? `ok=${override.ok}`, /not recorded against this asset/);
});

test("row-level security hides work orders without tenant context", async () => {
  await appRoleClient.connect();
  const withoutContext = await appRoleClient.query(
    "SELECT (SELECT count(*)::int FROM work_orders) AS work_orders, (SELECT count(*)::int FROM emergency_overrides) AS overrides",
  );
  assert.equal(withoutContext.rows[0].work_orders, 0);
  assert.equal(withoutContext.rows[0].overrides, 0);

  await appRoleClient.query("BEGIN");
  await appRoleClient.query("SELECT set_config('app.current_organization_id', $1, true)", [ORG_A]);
  const scoped = await appRoleClient.query("SELECT count(*)::int AS n FROM work_orders");
  await appRoleClient.query("COMMIT");
  assert.ok(scoped.rows[0].n > 0);
});
