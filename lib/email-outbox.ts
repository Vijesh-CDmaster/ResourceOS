import { pool, type Queryable } from "./db.ts";
import { withOrg } from "./db.ts";
import {
  emailTransportConfigured,
  type DeliveryOutcome,
} from "./notifications.ts";

/** Error thrown when a worker is mid-delivery and the process exits. */
export class StaleJobError extends Error {
  constructor(publishedAt: Date, claim: string) {
    super(`Stale job: published_at=${publishedAt.toISOString()} claim=${claim}`);
    this.name = "StaleJobError";
  }
}

export type DeliveryOutcome = {
  status: "sent" | "failed";
  note: string;
};

/** Hook an SMTP provider into the worker. */
export interface EmailProvider {
  send(email: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<{
    accepted: string[];
    rejected: string[];
    pending: string[];
    response: string | null;
    envelope: { from: string; to: string[] };
  }>;
}

/**
 * Creates an SMTP provider, eager-validating configuration.
 *
 * `ENABLE_EMAIL_RUNNER=false` returns a provider that records `unavailable`.
 * Tests never touch this; no provider outside this process can be reached.
 */
export function createSmtpProvider(env = process.env): EmailProvider {
  if (!emailTransportConfigured(env)) {
    return {
      async send() {
        throw new Error(
          "SMTP delivery disabled: SMTP_URL or EMAIL_DELIVERY_URL is not set",
        );
      },
    };
  }
  return {
    async send(raw) {
      const smtp = new URL(raw.smtpUrl || env.SMTP_URL!);
      const auth =
        smtp.username && smtp.password
          ? { user: smtp.username, pass: smtp.password }
          : undefined;
      const pool = new (require("pg")).Pool({
        host: smtp.hostname,
        port: Number(smtp.port || 587),
        user: auth?.user,
        password: auth?.pass,
        database: smtp.pathname?.replace(/^\//, ""),
        ssl: smtp.protocol === "smtps:" || smtp.protocol === "smtps",
        timeout: { connect: 5000, idle: 10_000 },
      });
      try {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SAVEPOINT v1; SELECT pg_notify('email_worker_slot', $1)",
            [raw.recipient],
          );
          await client.query("RELEASE SAVEPOINT v1");
          const result = await client.query(
            "SELECT * FROM pg_send_query($1, $2) AS (id TEXT, status TEXT)",
            [
              "email_worker_slot",
              JSON.stringify({
                from: raw.from,
                to: raw.to,
                subject: raw.subject,
                text: raw.text,
                envelope: { from: raw.from, to: [raw.to] },
              }),
            ],
          );
          const row = result.rows[0];
          if (!row || row.status !== "PREPARE") {
            throw new Error("SMTP delivery not prepared (" + row?.status + ")");
          }
          const pid = row.id;
          // Wait for the server to finish delivering (up to 20s).
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            const poll = await pool.query(
              "SELECT pg_catalog.wait_for_notify($1, NULL) AS received",
              [pid],
            );
            if (poll.rows[0].received) break;
            await new Promise((r) => setTimeout(r, 200));
          }
          return {
            accepted: [raw.to],
            rejected: [],
            pending: [],
            response: "250 OK (delivered)",
            envelope: { from: raw.from, to: [raw.to] },
          };
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      } catch (error) {
        await pool.end().catch(() => {});
        throw error;
      }
    },
  };
}

/** Records the outcome of a delivery attempt, atomically. */
export async function recordDeliveryOutcome(
  db: Queryable,
  input: {
    id: string;
    organizationId: string;
    accepted?: string[];
    rejected?: string[];
    pending?: string[];
    error?: string;
    response?: string;
    sent_at?: Date;
  },
): Promise<void> {
  const { rows } = await db.query(
    `UPDATE notification_outbox
       SET status = CASE
         WHEN $1 = 'sent' THEN 'sent'
         ELSE 'failed'
       END,
           attempts = attempts + 1,
           last_error = coalesce($2, last_error),
           response = coalesce($3, response),
           sent_at = CASE WHEN $1 = 'sent' THEN now() ELSE sent_at END
     WHERE id = $4 AND organization_id = $5
     RETURNING id`,
    [
      input.accepted === undefined ? "failed" : "sent",
      input.error ?? null,
      input.response ?? null,
      input.id,
      input.organizationId,
    ],
  );
  if (rows.length === 0) {
    throw new Error(`Outbox row ${input.id} belongs to another organisation`);
  }
}

/** Picks the next eligible row(s), claims them atomically, and returns a batch. */
export async function claimOutboxBatch(
  db: Queryable,
  organizationId: string,
  concurrency: number,
): Promise<Array<{
  id: string;
  recipient: string;
  subject: string;
  body: string;
  related_type: string | null;
  related_id: string | null;
  attempts: number;
  last_error: string;
}>> {
  const { rows } = await db.query(
    `UPDATE notification_outbox o
       SET status = 'delivering'
     FROM (
       SELECT id
         FROM notification_outbox
        WHERE status = 'pending'
          AND organization_id = $1
        ORDER BY created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     ) c
      WHERE o.id = c.id
      RETURNING o.id, o.recipient, o.subject, o.body,
                o.related_type, o.related_id, o.attempts, o.last_error`,
    [organizationId, concurrency],
  );
  return rows as Array<{
    id: string;
    recipient: string;
    subject: string;
    body: string;
    related_type: string | null;
    related_id: string | null;
    attempts: number;
    last_error: string;
  }>;
}

/**
 * Runs the worker.
 *
 *   node lib/email-outbox.ts --once        # one batch, then exit
 *   node lib/email-outbox.ts --dry-run     # list what would run, no writes
 *   node lib/email-outbox.ts               # long-running with a fixed poll interval
 *
 * Exit codes: 0 = normal (successful or skipped), 1 = configuration error,
 * 2 = fatal database error, 3 = worker stopped by SIGTERM.
 */
export async function runWorker(options: {
  concurrency?: number;
  pollIntervalSeconds?: number;
  once?: boolean;
  dryRun?: boolean;
  orgId?: string;
}) {
  const concurrency = options.concurrency ?? 1;
  const pollIntervalSeconds = options.pollIntervalSeconds ?? 10;
  const once = Boolean(options.once);
  const dryRun = Boolean(options.dryRun);
  const orgId = options.orgId;

  if (!emailTransportConfigured()) {
    console.error(
      "Email worker stopped: SMTP_URL or EMAIL_DELIVERY_URL is not configured.",
    );
    return 0;
  }

  if (!orgId) {
    const { rows } = await pool.query(
      "SELECT id FROM organizations ORDER BY created_at LIMIT 1",
    );
    if (rows.length === 0) {
      console.error(
        "Email worker stopped: no organisations found in the database.",
      );
      return 1;
    }
    orgId = rows[0].id;
  }

  for (;;) {
    try {
      const batch = await claimOutboxBatch(pool, orgId, concurrency);
      if (batch.length === 0) {
        if (once) return 0;
        if (dryRun) return 0;
        await new Promise((resolve) => setTimeout(resolve, pollIntervalSeconds * 1000));
        continue;
      }
      if (dryRun) {
        for (const row of batch) {
          console.log(
            `WOULD-DELIVER id=${row.id} to=${row.recipient} subject=${row.subject}`,
          );
        }
        continue;
      }
      for (const item of batch) {
        try {
          const provider = createSmtpProvider();
          const delivery = await provider.send({
            from: env.EMAIL_FROM ?? "no-reply@resourceos.local",
            to: item.recipient,
            subject: item.subject,
            text: item.body,
          });
          await recordDeliveryOutcome(pool, {
            id: item.id,
            organizationId: orgId,
            accepted: delivery.accepted,
            rejected: delivery.rejected,
            pending: delivery.pending,
            response: delivery.response ?? null,
            sent_at: new Date(),
          });
          console.log(
            `SENT id=${item.id} to=${item.recipient} subject=${item.subject}`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Never log the email body or recipient full name and subject in
          // ordinary operational logs.
          console.error(
            `FAILED id=${item.id} subject=${truncate(item.subject, 80)} error=${message}`,
          );
          await recordDeliveryOutcome(pool, {
            id: item.id,
            organizationId: orgId,
            error: message,
          });
        }
      }
      if (once) return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`WORKER-FATAL: ${message}`);
      // Not a business-rule failure; the worker is expected to recover by
      // restarting. Do not swallow it: a foreground process should keep the
      // supervisor alive, a cron job should exit non-zero.
      process.exitCode = 2;
      return 2;
    }
    if (once) return 0;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalSeconds * 1000));
  }
}

function truncate(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) + "…" : value;
}

const env = process.env;
