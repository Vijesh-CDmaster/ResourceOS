import "server-only";
import type { Queryable } from "./db";

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
