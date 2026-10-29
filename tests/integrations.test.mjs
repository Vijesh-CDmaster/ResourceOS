// Integration-foundation tests against a real PostgreSQL server.
//
// Builds a throwaway database (resourceos_int_test) from db/schema.sql plus
// db/migrations, connects as the non-superuser application role, and drives the
// real sync engine (lib/integrations/engine.ts) through the connector contract.
//
//   npm test
//
// The demo database is never touched: this file only creates and drops its own
// database, and never runs db/reset.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Client, Pool } from "pg";
import { applyBaseline, applyMigrations, grantAppRole } from "../db/migration-runner.mjs";

// Node strips the TypeScript types but resolves specifiers literally, so the
// application's bundler-style extensionless imports need help here. `server-only`
// is a Next.js alias with no on-disk package; map it to an empty module.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export{}", shortCircuit: true };
    }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

// Loaded after the hooks are registered, because static imports would resolve first.
const { runSync } = await import("../lib/integrations/engine.ts");
const { referenceConnector } = await import("../lib/integrations/connectors/reference.ts");
const { ConnectorError } = await import("../lib/integrations/types.ts");

const adminUrl =
  process.env.ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/resourceos";
const appUrl =
  process.env.DATABASE_URL ?? "postgres://resourceos_app:app_dev_password@localhost:5432/resourceos";
const TEST_DB = process.env.INTEGRATION_TEST_DATABASE_NAME ?? "resourceos_int_test";

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const USER_A = "aaaaaaaa-1111-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-1111-4000-8000-00000000000b";

const SLOT_DAY = "2027-04-01"; // well outside any "past" policy window

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const adminMain = new Client({ connectionString: withDatabase(adminUrl, "postgres") });
const admin = new Client({ connectionString: withDatabase(adminUrl, TEST_DB) });
const app = new Client({ connectionString: withDatabase(appUrl, TEST_DB) });
let pool;

/** Runs a unit of work with the tenant GUC set, the way lib/db.ts withOrg does. */
async function withTenantOn(client, organizationId, fn) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_organization_id', $1, true)", [organizationId]);
    const result = await fn({ query: (text, params) => client.query(text, params) });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/** Tenant runner for the sync engine: one pooled connection per unit of work. */
function tenantRunner(organizationId) {
  return async (fn) => {
    const client = await pool.connect();
    try {
      return await withTenantOn(client, organizationId, fn);
    } finally {
      client.release();
    }
  };
}

async function scope(organizationId, fn) {
  return withTenantOn(app, organizationId, fn);
}

async function sync(
  connectionId,
  { organizationId = ORG_A, connector = referenceConnector, mode = "incremental", maxPages } = {},
) {
  return runSync({
    organizationId,
    connectionId,
    actorId: null,
    connector,
    withTenant: tenantRunner(organizationId),
    mode,
    maxPages,
    retryDelayMs: 5,
    pullAttempts: 2,
  });
}

async function createConnection(organizationId, { provider = "reference-feed", name, records, credentials = null }) {
  const inserted = await scope(organizationId, (db) =>
    db.query(
      `INSERT INTO integration_connections (organization_id, provider, name, config, credentials_ciphertext)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [organizationId, provider, name, JSON.stringify({ records }), credentials],
    ),
  );
  return inserted.rows[0].id;
}

async function setRecords(organizationId, connectionId, records) {
  await scope(organizationId, (db) =>
    db.query("UPDATE integration_connections SET config = jsonb_set(config, '{records}', $2::jsonb) WHERE id = $1", [
      connectionId,
      JSON.stringify(records),
    ]),
  );
}

async function counts(organizationId, connectionId) {
  return scope(organizationId, async (db) => {
    const resources = await db.query(
      "SELECT count(*)::int AS n FROM resources WHERE source_connection_id = $1",
      [connectionId],
    );
    const bookings = await db.query("SELECT count(*)::int AS n FROM bookings WHERE source_connection_id = $1", [
      connectionId,
    ]);
    const mapped = await db.query("SELECT count(*)::int AS n FROM integration_entity_map WHERE connection_id = $1", [
      connectionId,
    ]);
    return { resources: resources.rows[0].n, bookings: bookings.rows[0].n, mapped: mapped.rows[0].n };
  });
}

const RESOURCE_RECORD = (externalId, code, name) => ({
  entityType: "resource",
  externalId,
  payload: { code, name },
});

let alphaFeed; // connection with one resource and one booking
let quarantineFeed; // connection used for validation/conflict tests
let failingFeed; // connection used for the transport-failure test
let betaFeed; // another institution's connection

before(async () => {
  await adminMain.connect();
  await adminMain.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await adminMain.query(`CREATE DATABASE ${TEST_DB}`);

  const appRole = new URL(appUrl).username;
  const roleExists = await adminMain.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [appRole]);
  if (roleExists.rowCount === 0) {
    const password = decodeURIComponent(new URL(appUrl).password);
    // A parallel test file may create the same role; losing that race is fine.
    await adminMain
      .query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${password.replace(/'/g, "''")}'`)
      .catch((error) => {
        if (error.code !== "42710") throw error;
      });
  }

  await admin.connect();
  // Same path as db/migrate.mjs: baseline schema, then every migration.
  await applyBaseline(admin);
  await applyMigrations(admin);
  await grantAppRole(admin, appUrl);

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

  await app.connect();
  pool = new Pool({ connectionString: withDatabase(appUrl, TEST_DB), max: 8 });
});

after(async () => {
  await pool?.end();
  await app.end().catch(() => {});
  await admin.end().catch(() => {});
  await adminMain.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
  await adminMain.end();
});

test("without a tenant context the application role sees no integration rows", async () => {
  const connections = await app.query("SELECT count(*)::int AS n FROM integration_connections");
  const runs = await app.query("SELECT count(*)::int AS n FROM integration_sync_runs");
  assert.equal(connections.rows[0].n, 0);
  assert.equal(runs.rows[0].n, 0);
});

test("importing the same feed twice does not duplicate records", async () => {
  alphaFeed = await createConnection(ORG_A, {
    name: "Alpha central feed",
    records: [
      RESOURCE_RECORD("R-1", "SEM-01", "Scanning Electron Microscope"),
      {
        entityType: "booking",
        externalId: "B-1",
        payload: {
          resourceExternalId: "R-1",
          userEmail: "alpha@example.edu",
          startsAt: `${SLOT_DAY}T04:00:00Z`,
          endsAt: `${SLOT_DAY}T05:00:00Z`,
          purpose: "Imported session",
        },
      },
    ],
  });

  const first = await sync(alphaFeed);
  assert.equal(first.status, "succeeded");
  assert.equal(first.imported, 2);
  assert.equal(first.duplicates, 0);
  assert.deepEqual(await counts(ORG_A, alphaFeed), { resources: 1, bookings: 1, mapped: 2 });

  const second = await sync(alphaFeed, { mode: "full" });
  assert.equal(second.status, "succeeded");
  assert.equal(second.imported, 0, "a replayed feed must not import anything new");
  assert.equal(second.duplicates, 1, "the booking is recognised as an already-ingested event");
  assert.equal(second.updated, 1, "the resource is refreshed in place, not duplicated");
  assert.deepEqual(
    await counts(ORG_A, alphaFeed),
    { resources: 1, bookings: 1, mapped: 2 },
    "a replayed feed must not create new rows or new mappings",
  );
});

test("invalid and conflicting records are quarantined while valid ones still import", async () => {
  quarantineFeed = await createConnection(ORG_A, {
    name: "Alpha second feed",
    records: [
      RESOURCE_RECORD("R-2", "R-2", "Confocal Microscope"),
      { entityType: "resource", externalId: "R-bad", payload: { code: "R-BAD" } }, // name missing
      RESOURCE_RECORD("R-dup", "SEM-01", "Clashes with a local code"), // code already used
    ],
  });

  const result = await sync(quarantineFeed);
  assert.equal(result.status, "succeeded", "one bad record must not fail the whole run");
  assert.equal(result.imported, 1);
  assert.equal(result.quarantined, 2);
  assert.deepEqual(await counts(ORG_A, quarantineFeed), { resources: 1, bookings: 0, mapped: 1 });

  const held = await scope(ORG_A, (db) =>
    db.query(
      "SELECT external_id, reason, message FROM integration_quarantine WHERE connection_id = $1 ORDER BY external_id",
      [quarantineFeed],
    ),
  );
  assert.equal(held.rowCount, 2);
  assert.deepEqual(
    held.rows.map((row) => [row.external_id, row.reason]),
    [
      ["R-bad", "validation"],
      ["R-dup", "conflict"],
    ],
  );
  for (const row of held.rows) assert.ok(row.message.length > 0, "a quarantine row must explain the failure");
});

test("a corrected source retries quarantined records without touching imported data", async () => {
  await setRecords(ORG_A, quarantineFeed, [
    RESOURCE_RECORD("R-2", "R-2", "Confocal Microscope"),
    RESOURCE_RECORD("R-bad", "R-BAD", "Now named"),
    RESOURCE_RECORD("R-dup", "R-DUP", "Now uses a free code"),
  ]);

  const retry = await sync(quarantineFeed, { mode: "full" });
  assert.equal(retry.status, "succeeded");
  assert.equal(retry.quarantined, 0);
  assert.equal(retry.imported, 2);
  assert.equal(retry.updated, 1, "the already-imported record is refreshed, not re-created");
  assert.deepEqual(await counts(ORG_A, quarantineFeed), { resources: 3, bookings: 0, mapped: 3 });

  const open = await scope(ORG_A, (db) =>
    db.query("SELECT count(*)::int AS n FROM integration_quarantine WHERE connection_id = $1 AND resolved_at IS NULL", [
      quarantineFeed,
    ]),
  );
  assert.equal(open.rows[0].n, 0, "successful retries close the quarantine rows");
});

test("a failed pull is recorded, corrupts nothing, and can be retried", async () => {
  failingFeed = await createConnection(ORG_A, {
    name: "Alpha flaky feed",
    records: [RESOURCE_RECORD("R-3", "R-3", "PCR Machine")],
  });

  const brokenConnector = {
    ...referenceConnector,
    async pull() {
      throw new Error("upstream responded 503");
    },
  };

  const failed = await sync(failingFeed, { connector: brokenConnector });
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /503/);
  assert.deepEqual(await counts(ORG_A, failingFeed), { resources: 0, bookings: 0, mapped: 0 });

  const run = await scope(ORG_A, (db) =>
    db.query("SELECT status, error FROM integration_sync_runs WHERE id = $1", [failed.runId]),
  );
  assert.equal(run.rows[0].status, "failed");

  const audit = await scope(ORG_A, (db) =>
    db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'integration.sync_failed' AND entity_id = $1", [
      failingFeed,
    ]),
  );
  assert.ok(audit.rows[0].n >= 1, "a failed sync must be auditable");

  const retried = await sync(failingFeed);
  assert.equal(retried.status, "succeeded");
  assert.equal(retried.imported, 1);
  assert.deepEqual(await counts(ORG_A, failingFeed), { resources: 1, bookings: 0, mapped: 1 });
});

test("a revoked connection cannot start a new sync", async () => {
  await scope(ORG_A, (db) =>
    db.query(
      `UPDATE integration_connections
          SET status = 'revoked', revoked_at = now(), credentials_ciphertext = NULL, checkpoint = NULL
        WHERE id = $1`,
      [alphaFeed],
    ),
  );

  const runsBefore = await scope(ORG_A, (db) =>
    db.query("SELECT count(*)::int AS n FROM integration_sync_runs WHERE connection_id = $1", [alphaFeed]),
  );

  await assert.rejects(
    sync(alphaFeed),
    (error) => error.code === "connection_revoked",
  );

  const runsAfter = await scope(ORG_A, (db) =>
    db.query("SELECT count(*)::int AS n FROM integration_sync_runs WHERE connection_id = $1", [alphaFeed]),
  );
  assert.equal(runsAfter.rows[0].n, runsBefore.rows[0].n, "a revoked connection must not open a sync run");
});

test("one institution cannot read another institution's connection, credentials, mappings or history", async () => {
  betaFeed = await createConnection(ORG_B, {
    name: "Beta feed",
    records: [RESOURCE_RECORD("BR-1", "BR-1", "Beta Spectrometer")],
    credentials: "v1:fake-iv:fake-tag:fake-ciphertext",
  });
  const betaRun = await sync(betaFeed, { organizationId: ORG_B });
  assert.equal(betaRun.status, "succeeded");

  await scope(ORG_A, async (db) => {
    const connection = await db.query("SELECT id FROM integration_connections WHERE id = $1", [betaFeed]);
    assert.equal(connection.rowCount, 0, "a foreign connection id must look absent");

    const secrets = await db.query("SELECT credentials_ciphertext FROM integration_connections WHERE id = $1", [
      betaFeed,
    ]);
    assert.equal(secrets.rowCount, 0, "sealed credentials must not be readable across tenants");

    const mapping = await db.query("SELECT id FROM integration_entity_map WHERE connection_id = $1", [betaFeed]);
    assert.equal(mapping.rowCount, 0);

    const history = await db.query("SELECT id FROM integration_sync_runs WHERE connection_id = $1", [betaFeed]);
    assert.equal(history.rowCount, 0);

    const quarantine = await db.query("SELECT id FROM integration_quarantine WHERE connection_id = $1", [betaFeed]);
    assert.equal(quarantine.rowCount, 0);
  });

  // Writing a row for the other tenant through this tenant's context is rejected.
  await assert.rejects(
    scope(ORG_A, (db) =>
      db.query(
        `INSERT INTO integration_connections (organization_id, provider, name, config)
         VALUES ($1, 'reference-feed', 'Smuggled', '{}'::jsonb)`,
        [ORG_B],
      ),
    ),
    (error) => error.code === "42501",
  );

  const stillActive = await scope(ORG_B, (db) =>
    db.query("SELECT status FROM integration_connections WHERE id = $1", [betaFeed]),
  );
  assert.equal(stillActive.rows[0].status, "active");
});

test("a sync for one tenant never counts or writes another tenant's records", async () => {
  const before = await scope(ORG_A, (db) =>
    db.query("SELECT count(*)::int AS n FROM resources WHERE organization_id = $1", [ORG_A]),
  );

  await setRecords(ORG_B, betaFeed, [
    RESOURCE_RECORD("BR-1", "BR-1", "Beta Spectrometer"),
    RESOURCE_RECORD("BR-2", "BR-2", "Beta Diffractometer"),
  ]);
  const betaSync = await sync(betaFeed, { organizationId: ORG_B, mode: "full" });
  assert.equal(betaSync.status, "succeeded");
  assert.equal(betaSync.imported, 1, "only the new record is imported");
  assert.equal(betaSync.updated, 1);

  const afterCount = await scope(ORG_A, (db) =>
    db.query("SELECT count(*)::int AS n FROM resources WHERE organization_id = $1", [ORG_A]),
  );
  assert.equal(afterCount.rows[0].n, before.rows[0].n, "Beta's sync must not add rows to Alpha");

  const betaResources = await scope(ORG_B, (db) =>
    db.query("SELECT code FROM resources WHERE organization_id = $1 ORDER BY code", [ORG_B]),
  );
  assert.deepEqual(
    betaResources.rows.map((row) => row.code),
    ["BR-1", "BR-2"],
  );
});

test("the tenant context does not survive a pooled connection", async () => {
  const client = await pool.connect();
  try {
    const seen = await withTenantOn(client, ORG_A, async (db) => {
      const { rows } = await db.query("SELECT current_setting('app.current_organization_id', true) AS ctx");
      return rows[0].ctx;
    });
    assert.equal(seen, ORG_A);

    const leaked = await client.query("SELECT current_setting('app.current_organization_id', true) AS ctx");
    assert.ok(
      leaked.rows[0].ctx === null || leaked.rows[0].ctx === "",
      "set_config(..., true) must reset with the transaction so a pooled client cannot inherit a tenant",
    );

    const visible = await client.query("SELECT count(*)::int AS n FROM integration_connections");
    assert.equal(visible.rows[0].n, 0, "no tenant context means no rows, even on a reused client");
  } finally {
    client.release();
  }
});

test("a permanent connector error is neither retried nor allowed to advance the checkpoint", async () => {
  const feed = await createConnection(ORG_A, {
    name: "Alpha permanent failure",
    records: [RESOURCE_RECORD("R-9", "R-9", "Lathe")],
  });

  let calls = 0;
  const refusedConnector = {
    ...referenceConnector,
    async pull() {
      calls += 1;
      throw new ConnectorError("cursor expired", false);
    },
  };

  const result = await runSync({
    organizationId: ORG_A,
    connectionId: feed,
    actorId: null,
    connector: refusedConnector,
    withTenant: tenantRunner(ORG_A),
    retryDelayMs: 1,
    pullAttempts: 3,
  });

  assert.equal(result.status, "failed");
  assert.equal(calls, 1, "a ConnectorError marked non-retryable must be attempted once");
  assert.equal(result.error, "cursor expired");

  const state = await scope(ORG_A, (db) =>
    db.query("SELECT checkpoint FROM integration_connections WHERE id = $1", [feed]),
  );
  assert.equal(state.rows[0].checkpoint, null, "a failed first page must not write a cursor");
});

test("a transient error is retried within the configured bound", async () => {
  const feed = await createConnection(ORG_A, {
    name: "Alpha transient failure",
    records: [RESOURCE_RECORD("R-10", "R-10", "Mill")],
  });

  let calls = 0;
  const flakyConnector = {
    ...referenceConnector,
    async pull(context, cursor) {
      calls += 1;
      if (calls < 2) throw new ConnectorError("upstream reset");
      return referenceConnector.pull(context, cursor);
    },
  };

  const result = await runSync({
    organizationId: ORG_A,
    connectionId: feed,
    actorId: null,
    connector: flakyConnector,
    withTenant: tenantRunner(ORG_A),
    retryDelayMs: 1,
    pullAttempts: 2,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(calls, 2, "the retry must succeed on the second attempt");
  assert.equal(result.imported, 1);
});

test("a failure on a later page keeps the last good checkpoint, and the retry does not duplicate", async () => {
  const feed = await createConnection(ORG_A, {
    name: "Alpha paged feed",
    records: [
      RESOURCE_RECORD("P-1", "PAGE-1", "Page one alpha"),
      RESOURCE_RECORD("P-2", "PAGE-2", "Page one beta"),
      RESOURCE_RECORD("P-3", "PAGE-3", "Page two gamma"),
    ],
  });
  await scope(ORG_A, (db) =>
    db.query("UPDATE integration_connections SET config = jsonb_set(config, '{pageSize}', '2'::jsonb) WHERE id = $1", [
      feed,
    ]),
  );

  let failPageTwo = true;
  const pagedConnector = {
    ...referenceConnector,
    async pull(context, cursor) {
      if (failPageTwo && cursor === "2") throw new ConnectorError("upstream 503 on page 2");
      return referenceConnector.pull(context, cursor);
    },
  };

  const failed = await sync(feed, { connector: pagedConnector });
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /503/);
  assert.deepEqual(
    await counts(ORG_A, feed),
    { resources: 2, bookings: 0, mapped: 2 },
    "the page that succeeded must be kept",
  );

  const state = await scope(ORG_A, (db) =>
    db.query("SELECT checkpoint FROM integration_connections WHERE id = $1", [feed]),
  );
  assert.equal(state.rows[0].checkpoint, "2", "the checkpoint must sit at the last fully ingested page");

  failPageTwo = false;
  const resumed = await sync(feed, { connector: pagedConnector });
  assert.equal(resumed.status, "succeeded");
  assert.equal(resumed.imported, 1, "only the page that had failed is imported on resume");
  assert.equal(resumed.duplicates, 0);

  const replay = await sync(feed, { connector: pagedConnector, mode: "full" });
  assert.equal(replay.imported, 0);
  assert.equal(replay.updated, 3);
  assert.deepEqual(
    await counts(ORG_A, feed),
    { resources: 3, bookings: 0, mapped: 3 },
    "resuming and replaying an interrupted sync must not corrupt or duplicate records",
  );
});

test("a feed larger than the page cap is partial, resumes, and never duplicates", async () => {
  const feed = await createConnection(ORG_A, {
    name: "Alpha oversized feed",
    records: Array.from({ length: 5 }, (_, index) =>
      RESOURCE_RECORD(`BIG-${index + 1}`, `BIG-${index + 1}`, `Oversized ${index + 1}`),
    ),
  });
  // Two records per page, two pages per run: the feed needs three pages.
  await scope(ORG_A, (db) =>
    db.query("UPDATE integration_connections SET config = jsonb_set(config, '{pageSize}', '2'::jsonb) WHERE id = $1", [
      feed,
    ]),
  );

  const first = await sync(feed, { maxPages: 2 });
  assert.equal(first.status, "partial", "a capped run must not be reported as succeeded");
  assert.equal(first.imported, 4, "both completed pages are committed");
  assert.match(first.note, /page limit/i, "the operator is told why the run stopped");
  assert.deepEqual(await counts(ORG_A, feed), { resources: 4, bookings: 0, mapped: 4 });

  const state = await scope(ORG_A, (db) =>
    db.query("SELECT checkpoint FROM integration_connections WHERE id = $1", [feed]),
  );
  assert.equal(state.rows[0].checkpoint, "4", "the last committed checkpoint is preserved");

  const run = await scope(ORG_A, (db) =>
    db.query("SELECT status, note, cursor_after FROM integration_sync_runs WHERE id = $1", [first.runId]),
  );
  assert.equal(run.rows[0].status, "partial");
  assert.ok(run.rows[0].note.length > 0);
  assert.equal(run.rows[0].cursor_after, "4");

  const audit = await scope(ORG_A, (db) =>
    db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'integration.sync_partial' AND entity_id = $1", [
      feed,
    ]),
  );
  assert.ok(audit.rows[0].n >= 1, "an incomplete run must be auditable as partial");

  // A full re-sync after a partial run continues from the checkpoint rather than
  // restarting and hitting the same cap forever.
  const resumed = await sync(feed, { maxPages: 2, mode: "full" });
  assert.equal(resumed.status, "succeeded");
  assert.equal(resumed.imported, 1, "only the unread tail is imported");
  assert.equal(resumed.duplicates, 0);

  const resumedRun = await scope(ORG_A, (db) =>
    db.query("SELECT cursor_before FROM integration_sync_runs WHERE id = $1", [resumed.runId]),
  );
  assert.equal(resumedRun.rows[0].cursor_before, "4", "the continuation starts at the checkpoint, not the beginning");
  assert.deepEqual(
    await counts(ORG_A, feed),
    { resources: 5, bookings: 0, mapped: 5 },
    "the whole feed is ingested exactly once",
  );

  // Nothing is left pending, so a full sync genuinely restarts from the beginning.
  // The whole feed needs three pages at this cap, so that pass is partial too —
  // and continuing from its checkpoint finishes without re-importing anything.
  const replay = await sync(feed, { maxPages: 2, mode: "full" });
  assert.equal(replay.status, "partial", "a full restart that cannot finish is still not called successful");
  assert.equal(replay.imported, 0, "every record is already mapped");

  const finished = await sync(feed, { maxPages: 2, mode: "full" });
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.imported, 0);
  assert.equal(finished.duplicates, 0);
  assert.deepEqual(
    await counts(ORG_A, feed),
    { resources: 5, bookings: 0, mapped: 5 },
    "repeated passes converge without duplicates or lost records",
  );

  const totals = await scope(ORG_A, (db) =>
    db.query(
      "SELECT coalesce(sum(imported), 0)::int AS imported, count(*)::int AS runs FROM integration_sync_runs WHERE connection_id = $1",
      [feed],
    ),
  );
  assert.equal(totals.rows[0].imported, 5, "each record is imported exactly once across every run");
});

test("a credential echoed by a failing provider is redacted before it is stored", async () => {
  const secret = "sk-live-acceptance-9f2c41";
  const feed = await createConnection(ORG_A, {
    name: "Alpha secret echo",
    records: [RESOURCE_RECORD("S-1", "SEC-1", "Secret probe")],
    credentials: "v1:placeholder:placeholder:placeholder",
  });

  const leakyConnector = {
    ...referenceConnector,
    async pull() {
      throw new Error(`401 unauthorized for token ${secret}`);
    },
  };

  const result = await runSync({
    organizationId: ORG_A,
    connectionId: feed,
    actorId: null,
    connector: leakyConnector,
    withTenant: tenantRunner(ORG_A),
    decryptCredentials: () => ({ apiKey: secret }),
    retryDelayMs: 1,
    pullAttempts: 1,
  });

  assert.equal(result.status, "failed");
  assert.ok(!result.error.includes(secret), "the returned error must not contain the credential");
  assert.match(result.error, /\[redacted\]/);

  const run = await scope(ORG_A, (db) =>
    db.query("SELECT error FROM integration_sync_runs WHERE id = $1", [result.runId]),
  );
  assert.ok(!run.rows[0].error.includes(secret), "the stored run error must not contain the credential");

  const audit = await scope(ORG_A, (db) =>
    db.query(
      "SELECT summary FROM audit_events WHERE action = 'integration.sync_failed' AND entity_id = $1",
      [feed],
    ),
  );
  assert.equal(audit.rowCount, 1);
  assert.ok(!audit.rows[0].summary.includes(secret), "the audit summary must not contain the credential");
});

test("provider credentials are sealed with AES-256-GCM and cannot be read or tampered with", async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = "a".repeat(64);
  const { encryptCredentials, decryptCredentials, CredentialEncryptionError } = await import(
    "../lib/integrations/crypto.ts"
  );

  const sealed = encryptCredentials({ apiKey: "super-secret-token" });
  assert.ok(!sealed.includes("super-secret-token"), "ciphertext must not embed the plaintext");
  assert.match(sealed, /^v1:/);
  assert.deepEqual(decryptCredentials(sealed), { apiKey: "super-secret-token" });

  // Each call uses a fresh IV.
  assert.notEqual(sealed, encryptCredentials({ apiKey: "super-secret-token" }));

  const parts = sealed.split(":");
  const tampered = [parts[0], parts[1], parts[2], Buffer.from("tampered").toString("base64")].join(":");
  assert.throws(() => decryptCredentials(tampered), CredentialEncryptionError);

  // A different server key cannot open the payload.
  process.env.INTEGRATION_ENCRYPTION_KEY = "b".repeat(64);
  assert.throws(() => decryptCredentials(sealed), CredentialEncryptionError);

  process.env.INTEGRATION_ENCRYPTION_KEY = "not-a-key";
  assert.throws(() => decryptCredentials(sealed), CredentialEncryptionError);

  delete process.env.INTEGRATION_ENCRYPTION_KEY;
});
