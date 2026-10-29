// Server-action authorization tests for the integration foundation.
//
// The actions are real ("use server" functions), the database is real, and the
// role checks, RLS context and credential sealing are all exercised. Only the
// Next.js request plumbing is stubbed, because there is no HTTP server here:
//
//   next/headers    -> a mutable cookie store, so requireUser() reads a real
//                      session row out of the test database
//   next/navigation -> redirect() throws a marker instead of sending a response
//   next/cache      -> revalidatePath() is a no-op
//   server-only     -> empty module
//
// Builds a throwaway database (resourceos_actions_test). The demo database is
// never touched.
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

const adminUrl =
  process.env.ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/resourceos";
const appUrl =
  process.env.DATABASE_URL ?? "postgres://resourceos_app:app_dev_password@localhost:5432/resourceos";
const TEST_DB = process.env.ACTION_TEST_DATABASE_NAME ?? "resourceos_actions_test";

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

// lib/db.ts reads DATABASE_URL at import time, so point it at the test database
// before the actions (and their pool) are imported.
process.env.DATABASE_URL = withDatabase(appUrl, TEST_DB);
process.env.INTEGRATION_ENCRYPTION_KEY = "c".repeat(64);

const actions = await import("../lib/actions/integrations.ts");
const { pool } = await import("../lib/db.ts");

const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000c1";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000c2";

const USERS = {
  admin: { id: "aaaaaaaa-1111-4000-8000-0000000000c1", email: "admin.a@example.edu", name: "Admin A", org: ORG_A, role: "admin" },
  manager: { id: "aaaaaaaa-2222-4000-8000-0000000000c2", email: "manager.a@example.edu", name: "Manager A", org: ORG_A, role: "manager" },
  member: { id: "aaaaaaaa-3333-4000-8000-0000000000c3", email: "member.a@example.edu", name: "Member A", org: ORG_A, role: "member" },
  adminB: { id: "bbbbbbbb-1111-4000-8000-0000000000c4", email: "admin.b@example.edu", name: "Admin B", org: ORG_B, role: "admin" },
};

const SECRET = "act-secret-5c19d7";

const adminMain = new Client({ connectionString: withDatabase(adminUrl, "postgres") });
const admin = new Client({ connectionString: withDatabase(adminUrl, TEST_DB) });

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** Switches the stubbed session cookie to the given user. */
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

/** Runs an action and returns the redirect it produced (actions always redirect). */
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
  return {
    url,
    path: parsed.pathname,
    ok: parsed.searchParams.get("ok"),
    error: parsed.searchParams.get("error"),
  };
}

async function connectionRow(name) {
  const { rows } = await admin.query(
    "SELECT id, status, credentials_ciphertext FROM integration_connections WHERE name = $1",
    [name],
  );
  return rows[0] ?? null;
}

before(async () => {
  await adminMain.connect();
  await adminMain.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await adminMain.query(`CREATE DATABASE ${TEST_DB}`);

  const appRole = new URL(appUrl).username;
  const roleExists = await adminMain.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [appRole]);
  if (roleExists.rowCount === 0) {
    const password = decodeURIComponent(new URL(appUrl).password);
    await adminMain
      .query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${password.replace(/'/g, "''")}'`)
      .catch((error) => {
        if (error.code !== "42710") throw error;
      });
  }

  await admin.connect();
  await applyBaseline(admin);
  await applyMigrations(admin);
  await grantAppRole(admin, appUrl);

  await admin.query(
    `INSERT INTO organizations (id, name, slug, timezone) VALUES
       ($1, 'Alpha Institute', 'alpha-actions', 'Asia/Kolkata'),
       ($2, 'Beta Institute', 'beta-actions', 'Asia/Kolkata')`,
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
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [user.id, hashToken(`token-${user.email}`)],
    );
  }
});

after(async () => {
  await pool.end().catch(() => {});
  await admin.end().catch(() => {});
  await adminMain.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
  await adminMain.end();
});

const FEED_CONFIG = JSON.stringify({
  records: [
    { entityType: "resource", externalId: "ACT-R1", payload: { code: "ACT-01", name: "Action Probe" } },
  ],
});

test("a member cannot create, revoke or sync integrations", async () => {
  actAs(USERS.member);

  const create = readFlash(
    await redirectOf(() =>
      actions.createConnectionAction(
        form({ provider: "reference-feed", name: "member-attempt", config: FEED_CONFIG }),
      ),
    ),
  );
  assert.equal(create.path, "/integrations");
  assert.match(create.error, /Only administrators can create integrations/);
  assert.equal(await connectionRow("member-attempt"), null, "no connection may be created for a member");

  const fixtureId = await createFixtureConnection("member-target");
  const revoke = readFlash(
    await redirectOf(() => actions.revokeConnectionAction(form({ connection_id: fixtureId }))),
  );
  assert.match(revoke.error, /Only administrators can revoke integrations/);
  assert.equal((await connectionRow("member-target")).status, "active");

  const sync = readFlash(
    await redirectOf(() => actions.syncConnectionAction(form({ connection_id: fixtureId, mode: "incremental" }))),
  );
  assert.match(sync.error, /Only administrators and facility managers can run a sync/);

  const runs = await admin.query("SELECT count(*)::int AS n FROM integration_sync_runs WHERE connection_id = $1", [
    fixtureId,
  ]);
  assert.equal(runs.rows[0].n, 0, "a refused sync must not open a run");
});

test("a manager can sync but cannot create or revoke", async () => {
  actAs(USERS.manager);

  const create = readFlash(
    await redirectOf(() =>
      actions.createConnectionAction(
        form({ provider: "reference-feed", name: "manager-attempt", config: FEED_CONFIG }),
      ),
    ),
  );
  assert.match(create.error, /Only administrators can create integrations/);
  assert.equal(await connectionRow("manager-attempt"), null);

  const fixtureId = await createFixtureConnection("manager-target");

  const revoke = readFlash(
    await redirectOf(() => actions.revokeConnectionAction(form({ connection_id: fixtureId }))),
  );
  assert.match(revoke.error, /Only administrators can revoke integrations/);
  assert.equal((await connectionRow("manager-target")).status, "active");

  const sync = readFlash(
    await redirectOf(() => actions.syncConnectionAction(form({ connection_id: fixtureId, mode: "incremental" }))),
  );
  assert.match(sync.ok ?? "", /Sync complete: 1 imported/);
  assert.equal(sync.error, null);

  const imported = await admin.query(
    "SELECT count(*)::int AS n FROM integration_entity_map WHERE connection_id = $1 AND entity_type = 'resource'",
    [fixtureId],
  );
  assert.equal(imported.rows[0].n, 1, "the manager's sync imported the record");
});

test("an administrator can create, sync and revoke", async () => {
  actAs(USERS.admin);

  const create = readFlash(
    await redirectOf(() =>
      actions.createConnectionAction(
        form({
          provider: "reference-feed",
          name: "admin-owned",
          config: JSON.stringify({
            records: [
              { entityType: "resource", externalId: "ADM-R1", payload: { code: "ADM-01", name: "Admin Probe" } },
            ],
          }),
          credentials: JSON.stringify({ apiKey: SECRET }),
        }),
      ),
    ),
  );
  assert.match(create.ok, /Connection "admin-owned" created/);
  assert.equal(create.error, null);

  const stored = await connectionRow("admin-owned");
  assert.equal(stored.status, "active");
  assert.ok(stored.credentials_ciphertext.startsWith("v1:"), "credentials are sealed before storage");
  assert.ok(!stored.credentials_ciphertext.includes(SECRET), "the ciphertext must not embed the secret");
  assert.ok(!create.url.includes(SECRET), "the success flash must not contain the secret");

  const sync = readFlash(
    await redirectOf(() => actions.syncConnectionAction(form({ connection_id: stored.id, mode: "incremental" }))),
  );
  assert.match(sync.ok, /Sync complete: 1 imported/);

  const revoke = readFlash(
    await redirectOf(() => actions.revokeConnectionAction(form({ connection_id: stored.id }))),
  );
  assert.match(revoke.ok, /Connection revoked/);

  const after = await connectionRow("admin-owned");
  assert.equal(after.status, "revoked");
  assert.equal(after.credentials_ciphertext, null, "revocation deletes stored credentials");
});

test("a connection belonging to another tenant cannot be operated on", async () => {
  const foreignId = await createFixtureConnection("beta-owned", ORG_B);

  actAs(USERS.admin); // administrator of Alpha
  const sync = readFlash(
    await redirectOf(() => actions.syncConnectionAction(form({ connection_id: foreignId, mode: "incremental" }))),
  );
  assert.match(sync.error, /does not exist for this institution/);
  assert.equal(sync.ok, null);

  const revoke = readFlash(
    await redirectOf(() => actions.revokeConnectionAction(form({ connection_id: foreignId }))),
  );
  assert.ok(revoke.error, "revoking a foreign connection must fail");
  assert.equal(revoke.ok, null);

  const foreign = await connectionRow("beta-owned");
  assert.equal(foreign.status, "active", "the other institution's connection is untouched");

  const runs = await admin.query("SELECT count(*)::int AS n FROM integration_sync_runs WHERE connection_id = $1", [
    foreignId,
  ]);
  assert.equal(runs.rows[0].n, 0, "no run may be opened against a foreign connection");
});

test("failed operations do not leak credentials", async () => {
  actAs(USERS.admin);
  await createFixtureConnection("duplicate-name");

  // A duplicate name fails inside the action; the surfaced error is Postgres's
  // constraint message and must not echo the credentials that were submitted.
  const duplicate = readFlash(
    await redirectOf(() =>
      actions.createConnectionAction(
        form({
          provider: "reference-feed",
          name: "duplicate-name",
          config: FEED_CONFIG,
          credentials: JSON.stringify({ apiKey: SECRET }),
        }),
      ),
    ),
  );
  assert.ok(duplicate.error, "the duplicate name must be reported as an error");
  assert.ok(!duplicate.url.includes(SECRET), "the error flash must not contain the secret");

  // A secret submitted in the non-secret settings field is refused outright.
  const misplaced = readFlash(
    await redirectOf(() =>
      actions.createConnectionAction(
        form({
          provider: "reference-feed",
          name: "misplaced-secret",
          config: JSON.stringify({ records: [], apiKey: SECRET }),
        }),
      ),
    ),
  );
  assert.match(misplaced.error, /must go in the credentials field/);
  assert.ok(!misplaced.url.includes(SECRET));
  assert.equal(await connectionRow("misplaced-secret"), null);

  const leaked = await admin.query(
    "SELECT count(*)::int AS n FROM integration_connections WHERE coalesce(credentials_ciphertext, '') LIKE $1 OR config::text LIKE $1",
    [`%${SECRET}%`],
  );
  assert.equal(leaked.rows[0].n, 0, "no row may contain the plaintext secret");
});

let fixtureCounter = 0;

/** Creates an active connection directly, bypassing the action under test. */
async function createFixtureConnection(name, organizationId = ORG_A) {
  fixtureCounter += 1;
  const { rows } = await admin.query(
    `INSERT INTO integration_connections (organization_id, provider, name, config)
     VALUES ($1, 'reference-feed', $2, $3) RETURNING id`,
    [
      organizationId,
      name,
      JSON.stringify({
        pageSize: 50,
        records: [
          {
            entityType: "resource",
            externalId: `FIX-${fixtureCounter}`,
            payload: { code: `FIX-${fixtureCounter}`, name: `Fixture ${fixtureCounter}` },
          },
        ],
      }),
    ],
  );
  return rows[0].id;
}
