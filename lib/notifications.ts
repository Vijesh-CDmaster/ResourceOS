import "server-only";
import type { Queryable } from "./db";

/**
 * Outbound communication.
 *
 * In-app notifications are stored in `notifications` and are genuinely delivered
 * (they render in the shell). Email is a separate channel with no transport wired
 * in this build, so it is recorded honestly in `notification_outbox` as
 * `unavailable` (not configured) or `pending` (queued for a worker that does not
 * exist yet). Nothing here ever reports an email as sent.
 *
 * Setup path for real delivery: set SMTP_URL (or EMAIL_DELIVERY_URL) for the
 * deployment and run a worker that drains `notification_outbox` rows whose status
 * is `pending`, setting `sent`/`failed`, `attempts` and `sent_at`.
 */

export type DeliveryStatus = "pending" | "sent" | "unavailable" | "failed";

export type DeliveryOutcome = { status: DeliveryStatus; note: string };

export function emailTransportConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SMTP_URL || env.EMAIL_DELIVERY_URL);
}

export const EMAIL_SETUP_PATH =
  "Email is not configured, so recipients were notified in-app only. To enable email, set SMTP_URL (or EMAIL_DELIVERY_URL) and run the outbox worker.";

/**
 * Records an outbound email row. Does not send anything: the row is the durable
 * evidence of what the operator was told would happen.
 */
export async function queueEmail(
  db: Queryable,
  input: {
    organizationId: string;
    recipient: string | null;
    subject: string;
    body: string;
    relatedType?: string;
    relatedId?: string | null;
    configured?: boolean;
  },
): Promise<DeliveryOutcome> {
  const configured = input.configured ?? emailTransportConfigured();
  const status: DeliveryStatus = configured ? "pending" : "unavailable";
  const note = configured
    ? "Queued in notification_outbox. No sender is implemented in this build, so this row has not been sent."
    : EMAIL_SETUP_PATH;

  if (!input.recipient) {
    return { status: "unavailable", note: "Recipient has no email address on record." };
  }

  await db.query(
    `INSERT INTO notification_outbox
       (organization_id, channel, recipient, subject, body, related_type, related_id, status, last_error)
     VALUES ($1, 'email', $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.organizationId,
      input.recipient,
      input.subject,
      input.body,
      input.relatedType ?? null,
      input.relatedId ?? null,
      status,
      status === "unavailable" ? note : "",
    ],
  );

  return { status, note };
}
