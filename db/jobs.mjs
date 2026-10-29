// Background worker: no-show detection and overdue session closure.
// Intended to run from cron every 5 minutes:
//   */5 * * * * cd /srv/resourceos && node --env-file=.env.local db/jobs.mjs >> /var/log/resourceos-jobs.log 2>&1
import { Client } from "pg";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://resourceos_app:app_dev_password@localhost:5432/resourceos";
const client = new Client({ connectionString });

await client.connect();

let noShows = 0;
let closedSessions = 0;

try {
  const orgs = await client.query(
    "SELECT id, no_show_grace_minutes FROM organizations ORDER BY created_at",
  );

  for (const org of orgs.rows) {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_organization_id', $1, true)", [org.id]);

    const stale = await client.query(
      `SELECT b.id, b.user_id, b.resource_id, b.starts_at, b.ends_at,
              r.name AS resource_name, r.code AS resource_code
         FROM bookings b
         JOIN resources r ON r.id = b.resource_id
        WHERE b.organization_id = $1
          AND b.status = 'confirmed'
          AND b.starts_at + make_interval(mins => $2) < now()
          AND NOT EXISTS (SELECT 1 FROM usage_sessions us WHERE us.booking_id = b.id)`,
      [org.id, org.no_show_grace_minutes],
    );

    for (const booking of stale.rows) {
      await client.query("UPDATE bookings SET status = 'no_show' WHERE id = $1", [booking.id]);
      await client.query(
        `INSERT INTO usage_sessions (organization_id, booking_id, started_at, ended_at, condition_note)
         VALUES ($1, $2, $3, $3, 'Auto-closed: no check-in within grace period')`,
        [org.id, booking.id, booking.starts_at],
      );
      await client.query(
        `INSERT INTO notifications (organization_id, user_id, title, body, link)
         VALUES ($1, $2, $3, $4, '/bookings')`,
        [
          org.id,
          booking.user_id,
          `No-show recorded: ${booking.resource_name}`,
          "No check-in was recorded within the grace period. Speak to the facility team if this is incorrect.",
        ],
      );
      await client.query(
        `INSERT INTO audit_events (organization_id, actor_id, action, entity_type, entity_id, summary, metadata)
         VALUES ($1, NULL, 'booking.no_show', 'booking', $2, $3, $4)`,
        [
          org.id,
          booking.id,
          `System marked ${booking.resource_code} as no-show after grace period`,
          JSON.stringify({ startsAt: booking.starts_at }),
        ],
      );
      noShows++;
    }

    const overdue = await client.query(
      `SELECT us.id, b.id AS booking_id, b.ends_at, r.name AS resource_name
         FROM usage_sessions us
         JOIN bookings b ON b.id = us.booking_id
         JOIN resources r ON r.id = b.resource_id
        WHERE us.ended_at IS NULL AND b.ends_at < now() AND b.status = 'confirmed'`,
    );
    for (const session of overdue.rows) {
      await client.query("UPDATE usage_sessions SET ended_at = $2 WHERE id = $1", [
        session.id,
        session.ends_at,
      ]);
      await client.query("UPDATE bookings SET status = 'completed' WHERE id = $1", [session.booking_id]);
      await client.query(
        `INSERT INTO audit_events (organization_id, actor_id, action, entity_type, entity_id, summary, metadata)
         VALUES ($1, NULL, 'booking.auto_completed', 'booking', $2, $3, $4)`,
        [
          org.id,
          session.booking_id,
          `System closed ${session.resource_name} at its scheduled end`,
          JSON.stringify({ endedAt: session.ends_at }),
        ],
      );
      closedSessions++;
    }

    await client.query("COMMIT");
  }

  console.log(
    `[jobs] ${new Date().toISOString()} — no-shows marked: ${noShows}, overdue sessions closed: ${closedSessions}`,
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("[jobs] failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
