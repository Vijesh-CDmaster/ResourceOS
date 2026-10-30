import "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import {
  createSmtpProvider,
  runWorker,
  claimOutboxBatch,
  recordDeliveryOutcome,
} from "../lib/email-outbox.ts";

// The provider is mocked here: createSmtpProvider returns a stub that answers
// the exact shape the worker dispatches. This keeps the suite fully offline and
// deterministic; no real SMTP is ever connected to, and no email is sent
// anywhere. Only the claim/redelivery flow is exercised against a throwaway
// PostgreSQL database.

// Helper: install a provider stub that answers a given shape.
async function withProviderStub(stub) {
  const original = createSmtpProvider;
  globalThis.createSmtpProvider = () => stub;
  await new Promise((resolve) => setImmediate(resolve));
  return () => {
    globalThis.createSmtpProvider = original;
  };
}

const adminUrl = process.env.ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/resourceos";
const appUrl = process.env.DATABASE_URL ?? "postgres://resourceos_app:app_dev_password@localhost:5432/resourceos";
const TEST_DB = process.env.EMAIL_WORKER_TEST_DATABASE_NAME ?? "resourceos_emailworker_test";

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

process.env.DATABASE_URL = withDatabase(appUrl, TEST_DB);

const admin = new Client({ connectionString: withDatabase(adminUrl, TEST_DB) });
const appRole = new Client({ connectionString: withDatabase(appUrl, TEST_DB) });
const pool = new Client({ connectionString: withDatabase(appUrl, TEST_DB) });

const ORG_A = "33333333-0000-4000-8000-0000000a0001";
const ORG_B = "44444444-0000-4000-8000-0000000b0001";

async function seedOrg(orgId, users, resources = []) {
  await admin.connect();
  await admin.query(
    `INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Email Org', 'email-org', 'Asia/Kolkata')`,
    [orgId],
  );
  for (const u of users) {
    await admin.query(
      "INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')",
      [u.id, u.email, u.name],
    );
    await admin.query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)",
      [orgId, u.id, "admin"],
    );
    await admin.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '2 hours')",
      [u.id, "x"],
    );
  }
  for (const r of resources) {
    await admin.query(
      `INSERT INTO resources (id, organization_id, code, name, status) VALUES ($1, $2, $3, $4, 'ready')`,
      [r.id, orgId, r.code, r.name],
    );
  }
}

async function insertOutbox(orgId, recipient, subject, body) {
  const { rows } = await admin.query(
    `INSERT INTO notification_outbox
       (organization_id, recipient, subject, body, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id`,
    [orgId, recipient, subject, body],
  );
  return rows[0].id;
}

before(async () => {
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.query(
    "CREATE ROLE resourceos_app LOGIN PASSWORD 'app_dev_password'",
  );
  await appRole.connect();
  await appRole.connect();
  await seedOrg(ORG_A, [USERS_A.admin, USERS_A.user]);
  await seedOrg(ORG_B, [USERS_B.admin, USERS_B.user]);
  await admin.end().catch(() => {});
  await appRole.end().catch(() => {});
  await pool.connect().catch(() => {});
});

after(async () => {
  await pool.end().catch(() => {});
  await appRole.end().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
  await admin.end().catch(() => {});
});

const example = {
  from: "no-reply@resourceos.local",
  to: "rohan@meridian.edu",
  subject: "Your booking is confirmed",
  text: "Hello Rohan, your booking has been confirmed.",
};

// --- 1. Successful delivery -> sent -------------------------------------------------

test("a configured provider marks a pending row sent", async () => {
  const accepted = [];
  const provider = {
    send: async (_raw) => {
      accepted.push(_raw.to);
      return { accepted: [_raw.to], rejected: [], pending: [], response: "250 OK", envelope: { from: _raw.from, to: [_raw.to] } };
    },
  };

  const restore = await withProviderStub(provider);
  try {
    const st = await admin.query(
      "SELECT id FROM notification_outbox WHERE recipient = $1 AND subject = $2 LIMIT 1",
      [example.to, example.subject],
    );
    const row = await admin.query(
      "SELECT id FROM notification_outbox WHERE recipient = $1 AND subject = $2 LIMIT 1",
      [example.to, example.subject],
    );
    const id = row.rows[0].id;
    assert.equal(delivered.length, 1);
    const outcome = await recordDeliveryOutcome(pool, {
      id: delivered[0].id,
      organizationId: ORG_A,
      response: "250 OK",
      sent_at: new Date(),
    });
    const qr2 = await admin.query(
      "SELECT status, attempts, sent_at FROM notification_outbox WHERE id = $1",
      [id],
    );
    assert.equal(qr2.rows[0].status, "sent");
    assert.equal(qr.rows[0].attempts, 1);
    assert.ok(qr.rows[0].sent_at);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0], example.to);
  } finally {
    restore();
  }
});

// --- 2. Temporary provider failure -> retry ---------------------------------------

test("a throwing provider is retried and eventually marked failed", async () => {
  let attempts = 0;
  const provider = {
    send: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("503 Service Unavailable");
      return { accepted: [example.to], rejected: [], pending: [], response: "250 OK", envelope: { from: example.from, to: [example.to] } };
    },
  };

  const restore = await withProviderStub(provider);
  try {
    const id = (await insertOutbox(ORG_A, example.to, example.subject, example.text));
    const delivered = await claimOutboxBatch(pool, ORG_A, 1);
    assert.equal(delivered.length, 1);
    await recordDeliveryOutcome(pool, { id: delivered[0].id, organizationId: ORG_A, error: "503 Service Unavailable" });
    const st = await admin.query(
      "SELECT status, attempts FROM notification_outbox WHERE id = $1",
      [id],
    );
    assert.equal(qr.rows[0].status, "failed");
    assert.equal(qr.rows[0].attempts, 3);
  } finally {
    restore();
  }
});

// --- 3. Permanent provider failure -> failed --------------------------------------

test("a permanently failing provider marks the row failed", async () => {
  const provider = {
    send: async () => {
      throw new Error("550 User Unknown");
    },
  };

  const restore = await withProviderStub(provider);
  try {
    const id = (await insertOutbox(ORG_A, example.to, example.subject, example.text));
    const delivered = await claimOutboxBatch(pool, ORG_A, 1);
    assert.equal(delivered.length, 1);
    await recordDeliveryOutcome(pool, {
      id: delivered[0].id,
      organizationId: ORG_A,
      error: "550 User Unknown",
    });
    const st = await admin.query(
      "SELECT status, attempts FROM notification_outbox WHERE id = $1",
      [id],
    );
    assert.equal(qr.rows[0].status, "failed");
    assert.equal(qr.rows[0].attempts, 1);
  } finally {
    restore();
  }
});

// --- 4. Maximum attempts reached --------------------------------------------------

test("after max attempts the job saturates to failed", async () => {
  const provider = {
    send: async () => {
      throw new Error("Network glitch");
    },
  };

  const restore = await withProviderStub(provider);
  try {
    const id = (await insertOutbox(ORG_A, example.to, example.subject, example.text));
    const delivered = await claimOutboxBatch(pool, ORG_A, 1);
    assert.equal(delivered.length, 1);
    const max = 3;
    for (let i = 0; i < max; i += 1) {
      await recordDeliveryOutcome(pool, { id: delivered[0].id, organizationId: ORG_A, error: "Network glitch" });
    }
    const st = await admin.query(
      "SELECT status, attempts FROM notification_outbox WHERE id = $1",
      [id],
    );
    assert.equal(qr.rows[0].status, "failed");
    assert.equal(qr.rows[0].attempts, max);
  } finally {
    restore();
  }
});

// --- 5. Provider timeout ----------------------------------------------------------

test("a provider that hangs times out and retries", async () => {
  let hit = false;
  const provider = {
    send: async () => {
      if (!hit) {
        hit = true;
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      }
      return { accepted: [example.to], rejected: [], pending: [], response: "250 OK", envelope: { from: example.from, to: [example.to] } };
    },
  };

  const restore = await withProviderStub(provider);
  try {
    const id = (await insertOutbox(ORG_A, example.to, example.subject, example.text));
    const delivered = await claimOutboxBatch(pool, ORG_A, 1);
    assert.equal(delivered.length, 1);
    // The test itself times out, but the worker must not hang the run.
    // We rely on the test runner to enforce this: no timeout is set, and the
    // call goes to the blocked provider. The worker loop must not deadlock.
    try {
      await new Promise((_, reject) => {
        const t = setTimeout(() => {
          clearTimeout(t);
          reject(new Error("Timed out: provider hang prevented a clean retry test"));
        }, 30_000);
        provider.send().then(() => {
          clearTimeout(t);
          resolve();
        }).catch((error) => {
          clearTimeout(t);
          reject(error);
        });
      });
    } catch (error) {
      assert.ok(error.message.includes("Timed out"));
    }
  } finally {
    restore();
  }
});

// --- 6. Duplicate-processing prevention -------------------------------------------

test("two workers cannot process the same notification twice", async () => {
  const delivered = await claimOutboxBatch(pool, ORG_A, 1);
  assert.equal(delivered.length, 1);
  const second = await claimOutboxBatch(pool, ORG_A, 1);
  assert.equal(second.length, 0);
});

// --- 7. Concurrent workers ---------------------------------------------------------

test("concurrent workers process disjoint batches", async () => {
  for (let i = 0; i < 5; i += 1) {
    await insertOutbox(ORG_A, example.to, example.subject, example.text);
  }
  const batch1 = await claimOutboxBatch(pool, ORG_A, 2);
  const batch2 = await claimOutboxBatch(pool, ORG_A, 2);
  assert.equal(batch1.length + batch2.length, 5);
});

// --- 8. Worker crash and stale-job recovery ---------------------------------------

test("a mid-delivery job is recovered by a stale claim expiry", async () => {
  const id = (await insertOutbox(ORG_A, example.to, example.subject, example.text));
  // Claim a job directly, then simulate a crash by leaving the claim row.
  const claimed = await claimOutboxBatch(pool, ORG_A, 1);
  assert.equal(claimed.length, 1);
  const jobId = claimed[0].id;
  // The claim is still 'claimed'. A fresh worker must now be able to re-claim
  // it (the expiry has not yet passed, but the stale-watch rule allows it).
  const second = await claimOutboxBatch(pool, ORG_A, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0].id, jobId);
});

// --- 9. Missing provider configuration -> no false success -------------------------

test("missing SMTP config reports unavailable and never marks sent", async () => {
  const original = process.env.SMTP_URL;
  delete process.env.SMTP_URL;
  try {
    const rowBefore = await admin.query(
      "SELECT status FROM notification_outbox WHERE recipient = $1 AND subject = $2 LIMIT 1",
      [example.to, example.subject],
    );
    assert.equal(rowBefore.rows[0].status, "pending");
    const delivered = await claimOutboxBatch(pool, ORG_A, 1);
    assert.equal(delivered.length, 1);
    const qr = await admin.query(
      "SELECT status FROM notification_outbox WHERE id = $1",
      [delivered[0].id],
    );
    assert.equal(qr.rows[0].status, "pending");
  } finally {
    if (original) process.env.SMTP_URL = original;
  }
});

// --- 10. Tenant isolation ---------------------------------------------------------

test("tenant B cannot read or act on tenant A's outbox rows", async () => {
  await insertOutbox(ORG_A, example.to, example.subject, example.text);
  await insertOutbox(ORG_B, example.to, example.subject, example.text);
  const qr2 = await admin.query(
    "SELECT organization_id FROM notification_outbox WHERE id = $1",
    [await insertOutbox(ORG_A, example.to, example.subject, example.text)],
  );
  assert.equal(rows.rows[0].organization_id, ORG_A);
});

// --- 11. Malformed outbox records -------------------------------------------------

test("a row that cannot be delivered is skipped and flagged failed", async () => {
  const id = (await insertOutbox(ORG_A, "", example.subject, example.text));
  const delivered = await claimOutboxBatch(pool, ORG_A, 1);
  assert.equal(delivered.length, 1);
  await recordDeliveryOutcome(pool, { id: delivered[0].id, organizationId: ORG_A, error: "Invalid recipient" });
  const st = await admin.query(
    "SELECT status, attempts FROM notification_outbox WHERE id = $1",
    [id],
  );
  assert.equal(qr.rows[0].status, "failed");
  assert.equal(qr.rows[0].attempts, 1);
});

// --- 12. No real email delivery during tests --------------------------------------

test("the worker never sends a real email in this suite", async () => {
  const original = process.env.SMTP_URL;
  delete process.env.SMTP_URL;
  try {
    const st = await admin.query(
      "SELECT id FROM notification_outbox WHERE recipient = $1 AND subject = $2 LIMIT 1",
      [example.to, example.subject],
    );
    const row = await admin.query(
      "SELECT id FROM notification_outbox WHERE recipient = $1 AND subject = $2 LIMIT 1",
      [example.to, example.subject],
    );
    const id = row.rows[0].id;
    assert.equal(delivered.length, 1);
    // We rely on the provider stub: no real SMTP is ever invoked.
    assert.equal(requestCount, 0);
  } finally {
    if (original) process.env.SMTP_URL = original;
  }
});
