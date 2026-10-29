// Capital-decision tests: calculations, tenant isolation, record persistence and
// the end-to-end workflow (evidence → recommendation → human decision → record).
//
// Two layers:
//   1. Pure model tests. lib/capital/model.ts does no I/O, so scenarios are
//      constructed directly and the arithmetic is asserted exactly.
//   2. Real-database tests. A throwaway database (resourceos_capital_test) is
//      built from the real baseline + migrations, then the real server actions
//      and tenant-scoped queries are exercised through a stubbed Next.js request
//      layer (cookies / redirect / revalidatePath only).
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
const TEST_DB = process.env.CAPITAL_TEST_DATABASE_NAME ?? "resourceos_capital_test";

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

// lib/db.ts reads DATABASE_URL at import time, so point it at the test database
// before the queries and actions (and their pool) are imported.
process.env.DATABASE_URL = withDatabase(appUrl, TEST_DB);

const model = await import("../lib/capital/model.ts");
const actions = await import("../lib/actions/decisions.ts");
const queries = await import("../lib/queries/capital.ts");
const { pool } = await import("../lib/db.ts");

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000ca01";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000ca02";

const DEPT_A1 = "aaaaaaaa-0000-4000-8000-00000000da01";
const DEPT_A2 = "aaaaaaaa-0000-4000-8000-00000000da02";

const USERS = {
  admin: { id: "aaaaaaaa-1111-4000-8000-00000000cb01", email: "admin.ca@example.edu", name: "Capital Admin", org: ORG_A, role: "admin", dept: DEPT_A1 },
  manager: { id: "aaaaaaaa-2222-4000-8000-00000000cb02", email: "manager.ca@example.edu", name: "Capital Manager", org: ORG_A, role: "manager", dept: DEPT_A1 },
  member: { id: "aaaaaaaa-3333-4000-8000-00000000cb03", email: "member.ca@example.edu", name: "Capital Member", org: ORG_A, role: "member", dept: DEPT_A1 },
  otherDeptMember: { id: "aaaaaaaa-4444-4000-8000-00000000cb04", email: "other.ca@example.edu", name: "Other Department Member", org: ORG_A, role: "member", dept: DEPT_A2 },
  adminB: { id: "bbbbbbbb-1111-4000-8000-00000000cb05", email: "admin.cb@example.edu", name: "Beta Admin", org: ORG_B, role: "admin", dept: null },
};

const R_SHARE = "aaaaaaaa-0000-4000-8000-00000000cc01"; // under-used, wanted elsewhere
const R_PEER = "aaaaaaaa-0000-4000-8000-00000000cc02"; // busy peer in the same category
const R_BETA = "bbbbbbbb-0000-4000-8000-00000000cc03";

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
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
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

function readFlash({ url }) {
  const parsed = new URL(url, "http://localhost");
  return { url, path: parsed.pathname, ok: parsed.searchParams.get("ok"), error: parsed.searchParams.get("error") };
}

/** A date `daysAgo` days back, at the given UTC hour. Stays inside the 180-day window. */
function recent(daysAgo, hour = 9) {
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}

const adminMain = new Client({ connectionString: withDatabase(adminUrl, "postgres") });
const admin = new Client({ connectionString: withDatabase(adminUrl, TEST_DB) });

// ---------------------------------------------------------------------------
// 1. Pure calculation tests
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-31T00:00:00Z");

function baseInput(overrides = {}) {
  return {
    asset: {
      id: "asset-1",
      code: "IMG-01",
      name: "Imaging Instrument",
      category: "Imaging",
      status: "ready",
      condition: "excellent",
      departmentId: "dept-1",
      departmentName: "Biosciences",
      facilityName: "Central Lab",
      location: "Block B",
      acquiredAt: "2020-01-01",
      acquisitionCost: 1_000_000,
      replacementCost: 1_200_000,
      warrantyExpiresAt: "2022-01-01",
      expectedLifeYears: 10,
    },
    bookings: [],
    sessions: [],
    unmet: [],
    maintenance: [],
    peers: [],
    openIncidents: 0,
    windowDays: 180,
    openHour: 8,
    closeHour: 18,
    now: NOW,
    ...overrides,
  };
}

test("utilisation is computed from usage hours and available hours, not stored", () => {
  const evidence = model.computeEvidence(
    baseInput({
      sessions: [{ hours: 2 }, { hours: 3 }, { hours: 5 }],
      bookings: [
        { status: "completed", startsAt: "2026-09-01T04:00:00Z", endsAt: "2026-09-01T06:00:00Z", userId: "u1", departmentId: "dept-1" },
      ],
    }),
  );

  // 180 days x (18 - 8) opening hours, no downtime.
  assert.equal(evidence.capacity.grossAvailableHours, 1800);
  assert.equal(evidence.demand.usedHours, 10);
  assert.equal(evidence.capacity.utilisation, 0.0056);
  assert.equal(evidence.demand.sessionsRecorded, 3);
});

test("downtime reduces available hours rather than inflating utilisation", () => {
  const withoutDowntime = model.computeEvidence(baseInput({ sessions: [{ hours: 90 }] }));
  const withDowntime = model.computeEvidence(
    baseInput({
      sessions: [{ hours: 90 }],
      maintenance: [
        {
          title: "Cooling failure",
          faultCategory: "Cooling",
          cost: 50_000,
          downtimeHours: 100,
          status: "resolved",
          resolvedAt: "2026-09-10T00:00:00Z",
          scheduledStart: "2026-09-05T00:00:00Z",
        },
      ],
    }),
  );

  assert.ok(withDowntime.capacity.availableHours < withoutDowntime.capacity.availableHours);
  assert.equal(withDowntime.capacity.downtimeHours, 100);
  assert.ok(
    withDowntime.capacity.utilisation > withoutDowntime.capacity.utilisation,
    "the same usage over fewer available hours is a higher utilisation",
  );
});

test("missing cost and life data is reported instead of silently assumed", () => {
  const evidence = model.computeEvidence(
    baseInput({
      asset: {
        ...baseInput().asset,
        acquisitionCost: null,
        replacementCost: null,
        expectedLifeYears: null,
        condition: null,
        acquiredAt: null,
      },
    }),
  );

  assert.equal(evidence.facts.replacementCost, null);
  assert.equal(evidence.facts.ageYears, null);
  assert.equal(evidence.coverage.hasAcquisitionCost, false);
  const text = evidence.missingData.join(" ");
  assert.match(text, /Acquisition cost is not recorded/);
  assert.match(text, /Expected useful life is not recorded/);
  assert.match(text, /Condition is not recorded/);
  assert.match(text, /No maintenance history/);
});

test("an under-used asset wanted by other departments is recommended for sharing", () => {
  const input = baseInput({
    sessions: [{ hours: 4 }, { hours: 4 }],
    unmet: [
      { reason: "conflict", departmentId: "dept-2", departmentName: "Electronics" },
      { reason: "no_training", departmentId: "dept-2", departmentName: "Electronics" },
      { reason: "quota", departmentId: "dept-3", departmentName: "Design" },
    ],
    peers: [
      { id: "peer-1", code: "IMG-02", departmentId: "dept-2", departmentName: "Electronics", usedHours: 900, unmetCount: 2 },
    ],
    maintenance: [
      {
        title: "Lamp replacement",
        faultCategory: "Optics alignment",
        cost: 15_000,
        downtimeHours: 6,
        status: "resolved",
        resolvedAt: "2026-09-01T00:00:00Z",
        scheduledStart: "2026-08-30T00:00:00Z",
      },
    ],
  });

  const { evidence, alternatives, recommendation } = model.buildCapitalAssessment(input);
  assert.equal(evidence.demand.unmetFromOtherDepartments, 3);
  assert.equal(evidence.peers.busyPeers, 1);
  assert.equal(recommendation.option, "share");
  assert.equal(recommendation.confidence, "low", "8 usage hours is below the evidence minimum");

  const share = alternatives.find((option) => option.option === "share");
  assert.ok(share.supportingEvidence.some((line) => /Other departments record unmet demand/.test(line)));
  // Every one of the five alternatives is always assessed and explained.
  assert.deepEqual(alternatives.map((option) => option.option), model.OPTION_ORDER);
  assert.ok(alternatives.every((option) => option.summary.length > 0));
});

test("an old, expensive-to-repair, heavily used asset is recommended for replacement", () => {
  const sessions = Array.from({ length: 60 }, () => ({ hours: 6 })); // 360 used hours
  const repairs = [
    { title: "Spindle rebuild", faultCategory: "Mechanical wear", cost: 40_000, downtimeHours: 40 },
    { title: "Controller board", faultCategory: "Software/controller", cost: 36_000, downtimeHours: 30 },
    { title: "Power supply", faultCategory: "Power supply", cost: 38_000, downtimeHours: 25 },
  ].map((record) => ({ ...record, status: "resolved", resolvedAt: "2026-09-01T00:00:00Z", scheduledStart: "2026-08-20T00:00:00Z" }));

  const input = baseInput({
    // 30-day window so 360 hours is a realistic 120% booked load.
    windowDays: 30,
    asset: {
      ...baseInput().asset,
      acquiredAt: "2014-01-01",
      acquisitionCost: 260_000,
      replacementCost: 60_000,
      expectedLifeYears: 8,
      condition: "poor",
    },
    sessions,
    maintenance: repairs,
  });

  const { evidence, alternatives, recommendation } = model.buildCapitalAssessment(input);

  assert.ok(evidence.facts.remainingLifeYears !== null && evidence.facts.remainingLifeYears <= 1);
  assert.ok((evidence.risk.downtimeShare ?? 0) >= 0.1);
  assert.ok(evidence.risk.repairToReplacementShare !== null && evidence.risk.repairToReplacementShare >= 0.5);
  assert.equal(recommendation.option, "buy_new");

  const repair = alternatives.find((option) => option.option === "repair");
  const buy = alternatives.find((option) => option.option === "buy_new");
  assert.ok(buy !== undefined && repair !== undefined);
  assert.ok(buy.score > repair.score, `buy ${buy.score} should outrank repair ${repair.score}`);
  assert.ok(repair.missingEvidence.length === 0 || Array.isArray(repair.missingEvidence));
});

test("a poor, barely used asset past its life is recommended for retirement", () => {
  const input = baseInput({
    asset: {
      ...baseInput().asset,
      acquiredAt: "2008-01-01",
      expectedLifeYears: 6,
      condition: "poor",
    },
    sessions: [{ hours: 3 }],
    maintenance: [
      { title: "Seal failure", faultCategory: "Seals and gaskets", cost: 90_000, downtimeHours: 60, status: "resolved", resolvedAt: "2026-09-01T00:00:00Z", scheduledStart: "2026-08-25T00:00:00Z" },
    ],
  });

  const { recommendation } = model.buildCapitalAssessment(input);
  assert.equal(recommendation.option, "retire");
});

test("a recommendation never claims a guarantee and always names its weak spots", () => {
  const { recommendation } = model.buildCapitalAssessment(
    baseInput({
      sessions: [{ hours: 40 }],
      asset: { ...baseInput().asset, replacementCost: null, acquisitionCost: null },
    }),
  );

  assert.match(recommendation.reason, /scored \d\.\d{2}/);
  assert.doesNotMatch(recommendation.reason, /guarantee|saving/i);
  assert.ok(recommendation.confidenceReasons.length > 0);
  for (const assessment of model.assessOptions(model.computeEvidence(baseInput()))) {
    assert.ok(Array.isArray(assessment.missingEvidence));
    assert.ok(Array.isArray(assessment.caveats));
  }
});

// ---------------------------------------------------------------------------
// 2. Database-backed tests
// ---------------------------------------------------------------------------

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
    `INSERT INTO organizations (id, name, slug, timezone, open_hour, close_hour, is_demo) VALUES
       ($1, 'Capital Alpha Institute', 'capital-alpha', 'Asia/Kolkata', 8, 18, false),
       ($2, 'Capital Beta Institute', 'capital-beta', 'Asia/Kolkata', 8, 18, false)`,
    [ORG_A, ORG_B],
  );
  await admin.query(
    `INSERT INTO departments (id, organization_id, name) VALUES
       ($1, $2, 'Biosciences'),
       ($3, $2, 'Electronics')`,
    [DEPT_A1, ORG_A, DEPT_A2],
  );

  for (const user of Object.values(USERS)) {
    await admin.query("INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')", [
      user.id,
      user.email,
      user.name,
    ]);
    await admin.query(
      "INSERT INTO memberships (organization_id, user_id, role, department_id) VALUES ($1, $2, $3, $4)",
      [user.org, user.id, user.role, user.dept],
    );
    await admin.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [user.id, hashToken(`token-${user.email}`)],
    );
  }

  // The asset the workflow test uses: under-used, excellent condition, no
  // current quote (so replacement cost is derived and flagged), wanted by another
  // department.
  await admin.query(
    `INSERT INTO resources
       (id, organization_id, department_id, code, name, category, status, condition,
        acquired_at, acquisition_cost, replacement_cost, expected_life_years, is_demo)
     VALUES ($1, $2, $3, 'IMG-01', 'Confocal Microscope', 'Imaging', 'ready', 'excellent',
             '2020-03-01', 1100000, NULL, 10, false)`,
    [R_SHARE, ORG_A, DEPT_A1],
  );
  await admin.query(
    `INSERT INTO resources
       (id, organization_id, department_id, code, name, category, status, condition,
        acquired_at, acquisition_cost, replacement_cost, expected_life_years)
     VALUES ($1, $2, $3, 'IMG-02', 'Light Sheet Microscope', 'Imaging', 'ready', 'good',
             '2021-06-01', 1500000, 1600000, 10)`,
    [R_PEER, ORG_A, DEPT_A2],
  );
  await admin.query(
    `INSERT INTO resources (id, organization_id, code, name, category, status)
     VALUES ($1, $2, 'BETA-01', 'Beta Only Instrument', 'Imaging', 'ready')`,
    [R_BETA, ORG_B],
  );

  let day = 40;
  for (let index = 0; index < 4; index += 1) {
    const start = recent(day, 9);
    const end = new Date(start.getTime() + 2 * 3_600_000);
    const booking = await admin.query(
      `INSERT INTO bookings (organization_id, resource_id, user_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, 'completed') RETURNING id`,
      [ORG_A, R_SHARE, USERS.member.id, start, end],
    );
    await admin.query(
      `INSERT INTO usage_sessions (organization_id, booking_id, started_at, ended_at)
       VALUES ($1, $2, $3, $4)`,
      [ORG_A, booking.rows[0].id, start, end],
    );
    day -= 3;
  }

  // A busy peer so the reallocation comparison has something to compare against.
  for (let index = 0; index < 6; index += 1) {
    const start = recent(30 - index, 10);
    const end = new Date(start.getTime() + 5 * 3_600_000);
    const booking = await admin.query(
      `INSERT INTO bookings (organization_id, resource_id, user_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, 'completed') RETURNING id`,
      [ORG_A, R_PEER, USERS.otherDeptMember.id, start, end],
    );
    await admin.query(
      `INSERT INTO usage_sessions (organization_id, booking_id, started_at, ended_at)
       VALUES ($1, $2, $3, $4)`,
      [ORG_A, booking.rows[0].id, start, end],
    );
  }

  await admin.query(
    `INSERT INTO maintenance_records
       (organization_id, resource_id, title, status, scheduled_start, resolved_at, cost, downtime_hours, fault_category)
     VALUES ($1, $2, 'Laser module replaced', 'resolved', $3, $4, 18000, 6, 'Optics alignment')`,
    [ORG_A, R_SHARE, recent(22, 8), recent(20, 8)],
  );

  for (const days of [18, 15, 12]) {
    const start = recent(days, 9);
    await admin.query(
      `INSERT INTO unmet_demand_events (organization_id, resource_id, user_id, starts_at, ends_at, reason)
       VALUES ($1, $2, $3, $4, $5, 'conflict')`,
      [ORG_A, R_SHARE, USERS.otherDeptMember.id, start, new Date(start.getTime() + 2 * 3_600_000)],
    );
  }
});

after(async () => {
  await pool.end().catch(() => {});
  await admin.end().catch(() => {});
  await adminMain.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
  await adminMain.end();
});

let decisionId = null;

test("the evidence workspace reads only this tenant's records", async () => {
  const alpha = await queries.listAssetSummaries(ORG_A, 8, 18, 180);
  const beta = await queries.listAssetSummaries(ORG_B, 8, 18, 180);

  assert.deepEqual(alpha.map((asset) => asset.code).sort(), ["IMG-01", "IMG-02"]);
  assert.deepEqual(beta.map((asset) => asset.code), ["BETA-01"]);

  const inputs = await queries.getAssetCapitalInputs(ORG_A, R_SHARE, 180);
  assert.equal(inputs.bookings.length, 4);
  assert.equal(inputs.sessions.length, 4);
  assert.equal(inputs.unmet.length, 3);
  assert.equal(inputs.maintenance.length, 1);
  assert.equal(inputs.asset.departmentName, "Biosciences");

  // Another institution cannot read the asset even with the exact UUID.
  assert.equal(await queries.getAssetCapitalInputs(ORG_B, R_SHARE, 180), null);
});

test("a member cannot generate a capital decision", async () => {
  actAs(USERS.member);
  const flash = readFlash(
    await redirectOf(() => actions.generateDecisionAction(form({ resource_id: R_SHARE, window_days: "180" }))),
  );

  assert.match(flash.error, /Only administrators and facility managers/);
  const rows = await admin.query("SELECT count(*)::int AS n FROM capital_decisions WHERE resource_id = $1", [R_SHARE]);
  assert.equal(rows.rows[0].n, 0, "no record may be created for a member");
});

test("dashboard → evidence → recommendation → decision → saved record", async () => {
  // A manager opens the asset workspace and generates the recommendation.
  actAs(USERS.manager);
  const generated = readFlash(
    await redirectOf(() => actions.generateDecisionAction(form({ resource_id: R_SHARE, window_days: "180" }))),
  );
  assert.equal(generated.error, null);
  assert.match(generated.ok, /Recommendation saved/);
  assert.match(generated.path, /^\/capital\/decisions\//);

  decisionId = generated.path.split("/").pop();
  assert.ok(decisionId);

  // The stored record contains the full evidence snapshot, all five alternatives
  // and the system recommendation — and it is pending until a human decides.
  const stored = await queries.getDecision(ORG_A, decisionId);
  assert.ok(stored);
  assert.equal(stored.status, "pending");
  assert.equal(stored.decisionOption, null);
  assert.equal(stored.assetCode, "IMG-01");
  assert.equal(stored.createdByName, "Capital Manager");
  assert.equal(stored.alternatives.length, 5);
  assert.equal(stored.recommendationReason.includes("scored"), true);

  const snapshot = stored.evidence;
  assert.equal(snapshot.demand.usedHours, 8);
  assert.equal(snapshot.demand.unmetFromOtherDepartments, 3);
  assert.equal(snapshot.maintenance.cost, 18_000);
  assert.equal(snapshot.facts.replacementCostSource, "derived", "no quote on file, so cost is derived and flagged");
  assert.equal(stored.windowDays, 180);
  assert.ok(model.OPTION_ORDER.includes(stored.recommendedOption));

  // The snapshot is a point-in-time record: changing the asset later must not
  // rewrite history.
  await admin.query("UPDATE resources SET name = 'Renamed Microscope', acquisition_cost = 999999 WHERE id = $1", [R_SHARE]);
  const afterRename = await queries.getDecision(ORG_A, decisionId);
  assert.equal(afterRename.assetName, "Confocal Microscope");
  assert.equal(afterRename.evidence.facts.acquisitionCost, 1_100_000);
  await admin.query("UPDATE resources SET name = 'Confocal Microscope', acquisition_cost = 1100000 WHERE id = $1", [R_SHARE]);

  const list = await queries.listDecisions(ORG_A, 10);
  assert.ok(list.some((decision) => decision.id === decisionId));
  assert.equal((await queries.listDecisions(ORG_B, 10)).length, 0, "the other institution sees no decision records");

  const audit = await admin.query(
    "SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'capital.recommendation_generated'",
    [decisionId],
  );
  assert.equal(audit.rowCount, 1, "generating a record is audited");
});

test("the human decision is recorded with its author and rationale", async () => {
  actAs(USERS.manager);

  const short = readFlash(
    await redirectOf(() => actions.recordDecisionAction(form({ decision_id: decisionId, option: "repair", rationale: "too short" }))),
  );
  assert.match(short.error, /at least 12 characters/);
  assert.equal((await queries.getDecision(ORG_A, decisionId)).status, "pending");

  const badOption = readFlash(
    await redirectOf(() => actions.recordDecisionAction(form({ decision_id: decisionId, option: "outsource", rationale: "Valid rationale text here." }))),
  );
  assert.match(badOption.error, /one of the five options/);

  const recorded = readFlash(
    await redirectOf(() =>
      actions.recordDecisionAction(
        form({
          decision_id: decisionId,
          option: "reallocate",
          rationale: "Electronics logged repeated unmet demand and Biosciences uses this twice a month.",
        }),
      ),
    ),
  );
  assert.equal(recorded.error, null);
  assert.match(recorded.ok, /overriding the recommendation/);

  const decided = await queries.getDecision(ORG_A, decisionId);
  assert.equal(decided.status, "decided");
  assert.equal(decided.decisionOption, "reallocate");
  assert.equal(decided.recommendedOption, "share");
  assert.equal(decided.decidedByName, "Capital Manager");
  assert.ok(decided.decidedAt instanceof Date);
  assert.match(decided.decisionRationale, /unmet demand/);

  const again = readFlash(
    await redirectOf(() => actions.recordDecisionAction(form({ decision_id: decisionId, option: "repair", rationale: "A second attempt at deciding." }))),
  );
  assert.match(again.error, /already been recorded/);

  const audit = await admin.query(
    "SELECT metadata FROM audit_events WHERE entity_id = $1 AND action = 'capital.decision_recorded'",
    [decisionId],
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].metadata.agreed, false, "the override is recorded as such");
});

test("another institution cannot operate on or read the decision record", async () => {
  actAs(USERS.adminB);
  assert.equal(await queries.getDecision(ORG_B, decisionId), null);

  const foreign = readFlash(
    await redirectOf(() => actions.generateDecisionAction(form({ resource_id: R_SHARE, window_days: "180" }))),
  );
  assert.match(foreign.error, /does not exist for this institution/);

  const decide = readFlash(
    await redirectOf(() =>
      actions.recordDecisionAction(form({ decision_id: decisionId, option: "retire", rationale: "Attempting a foreign decision." })),
    ),
  );
  assert.ok(decide.error, "a foreign decision record must not be decidable");
  assert.equal((await queries.getDecision(ORG_A, decisionId)).decisionOption, "reallocate");
});

test("decision records cannot be deleted from the database", async () => {
  await assert.rejects(
    admin.query("DELETE FROM capital_decisions WHERE id = $1", [decisionId]),
    /append-only/,
  );
  assert.ok(await queries.getDecision(ORG_A, decisionId), "the record still exists");
});
