import { withOrg } from "./db.ts";
import {
  type DeliveryOutcome,
  queueEmail,
  EMAIL_SETUP_PATH,
} from "./notifications.ts";

/**
 * Records an outbound email row.
 *
 * If `ENABLE_EMAIL_RUNNER=true` the row is inserted as `pending` so the worker
 * can claim and deliver it. Otherwise the row is recorded as `unavailable` and
 * the worker skips it — never `sent`.
 */
export async function queueEmail(
  db: Parameters<typeof queueEmail>[0],
  input: {
    organizationId: string;
    recipient: string | null;
    subject: string;
    body: string;
    relatedType?: string;
    relatedId?: string | null;
  },
): Promise<DeliveryOutcome> {
  const configured = emailTransportConfigured();
  const status: DeliveryOutcome["status"] = configured
    ? "pending"
    : "unavailable";
  const note = configured
    ? "Queued for delivery to the email worker."
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

  if (configured && process.env.ENABLE_EMAIL_RUNNER === "true") {
    return { status: "pending", note: "Queued for the outbox worker." };
  }

  return { status, note };
}
