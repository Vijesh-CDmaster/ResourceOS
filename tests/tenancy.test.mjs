// Tenant-isolation and booking-concurrency tests against a real PostgreSQL server.
//
// Each run builds a throwaway database from db/schema.sql, connects as the
// non-superuser application role, and asserts the guarantees the product depends
// on: RLS scoping, cross-tenant write rejection, and one winner per time range.
//
//   npm test
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client, Pool } from "pg";

const adminUrl =
  process.env.ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/resourceos";
const appUrl = process.env.DATABASE_URL ?? "postgres://resourceos_app:app_dev_password@localhost:5432/resourceos";
const TEST_DB = process.env.TEST_DATABASE_NAME ?? "resourceos_test";

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RESOURCE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RESOURCE_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const SLOT_DAY = "2027-03-01"; // a Monday, far enough ahead to stay out of "past" checks

// adminMain owns create/drop of the test database; admin connects to that database itself.
const adminMain = new Client({ connectionString: withDatabase(adminUrl, "postgres") });
const admin = new Client({ connectionString: withDatabase(adminUrl, TEST_DB) });
const app = new Client({ connectionString: withDatabase(appUrl, TEST_DB) });
let pool;

async function asTenant(client, organizationId, fn) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_organization_id', $1, true)", [organizationId]);
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function insertBooking(client, { organizationId, resourceId, userId, startsAt, endsAt, status = "confirmed", idempotencyKey = null }) {
  return client.query(
    `INSERT INTO bookings (organization_id, resource_id, user_id, starts_at, ends_at, status, purpose, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'test', $7)
     RETURNING id`,
    [organizationId, resourceId, userId, startsAt, endsAt, status, idempotencyKey],
  );
}

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

  // Apply the real schema, exactly as db/migrate.mjs does in production.
  const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
  await admin.query(schema);
  await admin.query(
    `GRANT USAGE ON SCHEMA public TO ${appRole};
     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole};
     ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole};`,
  );

  await admin.query(
    `INSERT INTO organizations (id, name, slug, timezone) VALUES
       ($1, 'Alpha Institute', 'alpha', 'Asia/Kolkata'),
       ($2, 'Beta Institute', 'beta', 'Asia/Kolkata')`,
    [ORG_A, ORG_B],
  );
  await admin.query(
    `INSERT INTO users (id, email, name, password_hash) VALUES
       ($1, 'alpha@example.edu', 'Alpha Member', 'x'),
       ($2, 'beta@example.edu', 'Beta Member', 'x')`,
    [USER_A, USER_B],
  );
  await admin.query(
    `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'member'), ($3, $4, 'member')`,
    [ORG_A, USER_A, ORG_B, USER_B],
  );
  await admin.query(
    `INSERT INTO resources (id, organization_id, code, name) VALUES
       ($1, $2, 'A-1', 'Alpha Microscope'),
       ($3, $4, 'B-1', 'Beta Microscope')`,
    [RESOURCE_A, ORG_A, RESOURCE_B, ORG_B],
  );

  await app.connect();
  pool = new Pool({ connectionString: withDatabase(appUrl, TEST_DB), max: 10 });

  // One committed booking and one audit row for the read/immutability tests.
  await asTenant(app, ORG_A, () =>
    insertBooking(app, {
      organizationId: ORG_A,
      resourceId: RESOURCE_A,
      userId: USER_A,
      startsAt: `${SLOT_DAY}T04:00:00Z`,
      endsAt: `${SLOT_DAY}T05:00:00Z`,
    }),
  );
  await asTenant(app, ORG_B, () =>
    insertBooking(app, {
      organizationId: ORG_B,
      resourceId: RESOURCE_B,
      userId: USER_B,
      startsAt: `${SLOT_DAY}T04:00:00Z`,
      endsAt: `${SLOT_DAY}T05:00:00Z`,
    }),
  );
});

after(async () => {
  await pool?.end();
  await app.end().catch(() => {});
  await admin.end().catch(() => {});
  await adminMain.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
  await adminMain.end();
});

test("without a tenant context the application role sees no tenant rows", async () => {
  const bookings = await app.query("SELECT count(*)::int AS n FROM bookings");
  const resources = await app.query("SELECT count(*)::int AS n FROM resources");
  assert.equal(bookings.rows[0].n, 0);
  assert.equal(resources.rows[0].n, 0);
});

test("a tenant context scopes unfiltered reads to that organization", async () => {
  await asTenant(app, ORG_A, async () => {
    const all = await app.query("SELECT organization_id FROM bookings");
    assert.equal(all.rowCount, 1, "only Alpha's booking should be visible");
    assert.equal(all.rows[0].organization_id, ORG_A);

    const neighbour = await app.query("SELECT count(*)::int AS n FROM bookings WHERE organization_id = $1", [ORG_B]);
    assert.equal(neighbour.rows[0].n, 0, "Beta's booking must not be readable from Alpha's context");

    const foreignResource = await app.query("SELECT id FROM resources WHERE id = $1", [RESOURCE_B]);
    assert.equal(foreignResource.rowCount, 0, "another tenant's resource must look absent");
  });
});

test("a cross-tenant insert is rejected by row-level security", async () => {
  await assert.rejects(
    asTenant(app, ORG_A, () =>
      insertBooking(app, {
        organizationId: ORG_B,
        resourceId: RESOURCE_B,
        userId: USER_B,
        startsAt: `${SLOT_DAY}T06:00:00Z`,
        endsAt: `${SLOT_DAY}T07:00:00Z`,
      }),
    ),
    (error) => error.code === "42501",
  );

  await asTenant(app, ORG_B, async () => {
    const leaked = await app.query("SELECT count(*)::int AS n FROM bookings WHERE starts_at = $1", [`${SLOT_DAY}T06:00:00Z`]);
    assert.equal(leaked.rows[0].n, 0, "the rejected row must not exist for Beta either");
  });
});

test("simultaneous overlapping bookings: exactly one wins, the rest get a conflict", async () => {
  const startsAt = `${SLOT_DAY}T08:00:00Z`;
  const endsAt = `${SLOT_DAY}T09:00:00Z`;
  const clients = await Promise.all(Array.from({ length: 8 }, () => pool.connect()));

  try {
    const outcomes = await Promise.all(
      clients.map(async (client) => {
        try {
          await asTenant(client, ORG_A, () =>
            insertBooking(client, {
              organizationId: ORG_A,
              resourceId: RESOURCE_A,
              userId: USER_A,
              startsAt,
              endsAt,
              status: "requested",
            }),
          );
          return { ok: true };
        } catch (error) {
          return { ok: false, code: error.code };
        }
      }),
    );

    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    assert.equal(winners.length, 1, "exactly one concurrent request may hold the slot");
    assert.equal(losers.length, 7);
    for (const loser of losers) {
      // 23P01 is the overlap constraint; 40P01 is PostgreSQL aborting the
      // transaction under contention. Either way the slot is not double-booked.
      assert.ok(
        ["23P01", "40P01"].includes(loser.code),
        `losing request failed with ${loser.code}; expected an overlap or deadlock abort`,
      );
    }

    const stored = await asTenant(app, ORG_A, () =>
      app.query("SELECT count(*)::int AS n FROM bookings WHERE starts_at = $1 AND ends_at = $2", [startsAt, endsAt]),
    );
    assert.equal(stored.rows[0].n, 1);
  } finally {
    clients.forEach((client) => client.release());
  }
});

test("a back-to-back window on the same resource is allowed", async () => {
  await asTenant(app, ORG_A, () =>
    insertBooking(app, {
      organizationId: ORG_A,
      resourceId: RESOURCE_A,
      userId: USER_A,
      startsAt: `${SLOT_DAY}T09:00:00Z`,
      endsAt: `${SLOT_DAY}T10:00:00Z`,
    }),
  );
});

test("a repeated idempotency key cannot create a second booking", async () => {
  const key = "submit-0001";
  await asTenant(app, ORG_A, () =>
    insertBooking(app, {
      organizationId: ORG_A,
      resourceId: RESOURCE_A,
      userId: USER_A,
      startsAt: `${SLOT_DAY}T11:00:00Z`,
      endsAt: `${SLOT_DAY}T12:00:00Z`,
      idempotencyKey: key,
    }),
  );

  await assert.rejects(
    asTenant(app, ORG_A, () =>
      insertBooking(app, {
        organizationId: ORG_A,
        resourceId: RESOURCE_A,
        userId: USER_A,
        startsAt: `${SLOT_DAY}T13:00:00Z`,
        endsAt: `${SLOT_DAY}T14:00:00Z`,
        idempotencyKey: key,
      }),
    ),
    (error) => error.code === "23505",
  );
});

test("the audit trail refuses updates and deletes", async () => {
  const inserted = await asTenant(app, ORG_A, () =>
    app.query(
      `INSERT INTO audit_events (organization_id, actor_id, action, entity_type, summary)
       VALUES ($1, $2, 'test.event', 'test', 'immutable row') RETURNING id`,
      [ORG_A, USER_A],
    ),
  );
  const auditId = inserted.rows[0].id;

  await assert.rejects(
    asTenant(app, ORG_A, () => app.query("UPDATE audit_events SET summary = 'rewritten' WHERE id = $1", [auditId])),
    /append-only/,
  );
  await assert.rejects(
    asTenant(app, ORG_A, () => app.query("DELETE FROM audit_events WHERE id = $1", [auditId])),
    /append-only/,
  );

  const stored = await asTenant(app, ORG_A, () =>
    app.query("SELECT summary FROM audit_events WHERE id = $1", [auditId]),
  );
  assert.equal(stored.rows[0].summary, "immutable row");
});
