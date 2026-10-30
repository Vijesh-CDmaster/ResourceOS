import "server-only";
import { withOrg } from "../db";

export type UtilizationRow = {
  resourceId: string;
  code: string;
  name: string;
  status: string;
  availableHours: number;
  downtimeHours: number;
  bookedHours: number;
  actualHours: number;
  noShows: number;
  completed: number;
  cancelled: number;
  requested: number;
  utilizationPct: number;
};

export type UnmetDemandRow = {
  resourceCode: string;
  resourceName: string;
  reason: string;
  count: number;
};

export type UserUsageRow = {
  userId: string;
  userName: string;
  email: string;
  department: string | null;
  bookings: number;
  hours: number;
  noShows: number;
};

export type ReportBundle = {
  from: string;
  to: string;
  utilization: UtilizationRow[];
  totals: {
    availableHours: number;
    bookedHours: number;
    actualHours: number;
    utilizationPct: number;
    bookings: number;
    noShows: number;
    noShowRate: number;
    unmetDemand: number;
  };
  unmetDemand: UnmetDemandRow[];
  topUsers: UserUsageRow[];
  incidents: { open: number; investigating: number; resolved: number; high: number };
  weekly: Array<{ week: string; bookings: number; noShows: number }>;
};

export async function getReports(organizationId: string, fromKey: string, toKey: string): Promise<ReportBundle> {
  const from = new Date(`${fromKey}T00:00:00+05:30`);
  const to = new Date(`${toKey}T00:00:00+05:30`);
  const rangeStart = from.toISOString();
  const rangeEnd = to.toISOString();

  return withOrg(organizationId, async (db) => {
    const [utilization, unmet, users, incidents, weekly] = await Promise.all([
      db.query<{
        resource_id: string;
        code: string;
        name: string;
        status: string;
        available_hours: string;
        downtime_hours: string;
        booked_hours: string;
        actual_hours: string;
        no_shows: number;
        completed: number;
        cancelled: number;
        requested: number;
      }>(
        `         WITH days AS (
           SELECT generate_series(
             ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date,
             ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date - 1,
             interval '1 day'
           )::date AS day
         ),
         available AS (
           SELECT r.id,
                  coalesce(sum(extract(epoch FROM (ar.closes_at - ar.opens_at)) / 3600), 0) AS available_hours
             FROM resources r
             LEFT JOIN availability_rules ar ON ar.resource_id = r.id
             LEFT JOIN days ON extract(dow FROM days.day) = ar.weekday
            GROUP BY r.id
         ),
         downtime AS (
           SELECT resource_id,
                  coalesce(sum(extract(epoch FROM (least(ends_at, $3::timestamptz) - greatest(starts_at, $2::timestamptz))) / 3600), 0) AS downtime_hours
             FROM blackout_periods
            WHERE tstzrange(starts_at, ends_at) && tstzrange($2::timestamptz, $3::timestamptz)
            GROUP BY resource_id
         ),
         bookings_agg AS (
           SELECT resource_id,
                  count(*) FILTER (WHERE status = 'requested')::int AS requested,
                  count(*) FILTER (WHERE status = 'completed')::int AS completed,
                  count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                  count(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
                  coalesce(sum(extract(epoch FROM (least(ends_at, $3::timestamptz) - greatest(starts_at, $2::timestamptz))) / 3600)
                    FILTER (WHERE status IN ('requested','confirmed','completed')), 0) AS booked_hours
             FROM bookings
            WHERE tstzrange(starts_at, ends_at) && tstzrange($2::timestamptz, $3::timestamptz)
            GROUP BY resource_id
         ),
         actual AS (
           SELECT b.resource_id,
                  coalesce(sum(extract(epoch FROM (coalesce(us.ended_at, least(b.ends_at, now())) - us.started_at)) / 3600), 0) AS actual_hours
             FROM usage_sessions us
             JOIN bookings b ON b.id = us.booking_id
            WHERE us.started_at >= $2::timestamptz AND us.started_at < $3::timestamptz
            GROUP BY b.resource_id
         )
         SELECT r.id AS resource_id, r.code, r.name, r.status,
                coalesce(av.available_hours, 0)::text AS available_hours,
                coalesce(dt.downtime_hours, 0)::text AS downtime_hours,
                coalesce(ba.booked_hours, 0)::text AS booked_hours,
                coalesce(ac.actual_hours, 0)::text AS actual_hours,
                coalesce(ba.no_shows, 0) AS no_shows,
                coalesce(ba.completed, 0) AS completed,
                coalesce(ba.cancelled, 0) AS cancelled,
                coalesce(ba.requested, 0) AS requested
           FROM resources r
           LEFT JOIN available av ON av.id = r.id
           LEFT JOIN downtime dt ON dt.resource_id = r.id
           LEFT JOIN bookings_agg ba ON ba.resource_id = r.id
           LEFT JOIN actual ac ON ac.resource_id = r.id
          WHERE r.status <> 'retired' AND r.organization_id = $1::uuid
          ORDER BY r.name`,
        [organizationId, rangeStart, rangeEnd],
      ),
      db.query<{ resource_code: string; resource_name: string; reason: string; count: number }>(
        `SELECT r.code AS resource_code, r.name AS resource_name, e.reason, count(*)::int AS count
           FROM unmet_demand_events e
           JOIN resources r ON r.id = e.resource_id
          WHERE e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz
          GROUP BY r.code, r.name, e.reason
          ORDER BY count DESC, r.name`,
        [rangeStart, rangeEnd],
      ),
      db.query<{
        user_id: string;
        user_name: string;
        email: string;
        department: string | null;
        bookings: number;
        hours: string;
        no_shows: number;
      }>(
        `SELECT u.id AS user_id, u.name AS user_name, u.email, d.name AS department,
                count(*)::int AS bookings,
                coalesce(sum(extract(epoch FROM (least(b.ends_at, $2::timestamptz) - greatest(b.starts_at, $1::timestamptz))) / 3600), 0)::text AS hours,
                count(*) FILTER (WHERE b.status = 'no_show')::int AS no_shows
           FROM bookings b
           JOIN users u ON u.id = b.user_id
           LEFT JOIN memberships m ON m.user_id = u.id AND m.organization_id = b.organization_id
           LEFT JOIN departments d ON d.id = m.department_id
          WHERE b.starts_at >= $1::timestamptz AND b.starts_at < $2::timestamptz
            AND b.status IN ('requested','confirmed','completed','no_show')
          GROUP BY u.id, u.name, u.email, d.name
          ORDER BY hours DESC
          LIMIT 8`,
        [rangeStart, rangeEnd],
      ),
      db.query<{ open: number; investigating: number; resolved: number; high: number }>(
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
                count(*) FILTER (WHERE status = 'investigating')::int AS investigating,
                count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
                count(*) FILTER (WHERE severity = 'high')::int AS high
           FROM incidents
          WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`,
        [rangeStart, rangeEnd],
      ),
      db.query<{ week: Date; bookings: number; no_shows: number }>(
        `SELECT date_trunc('week', starts_at) AS week,
                count(*)::int AS bookings,
                count(*) FILTER (WHERE status = 'no_show')::int AS no_shows
           FROM bookings
          WHERE starts_at >= $1::timestamptz AND starts_at < $2::timestamptz
            AND status IN ('completed','no_show','cancelled')
          GROUP BY 1 ORDER BY 1`,
        [rangeStart, rangeEnd],
      ),
    ]);

    const utilizationRows: UtilizationRow[] = utilization.rows.map((row) => {
      const availableHours = Number(row.available_hours);
      const downtimeHours = Number(row.downtime_hours);
      const capacity = Math.max(0.01, availableHours - downtimeHours);
      const bookedHours = Number(row.booked_hours);
      return {
        resourceId: row.resource_id,
        code: row.code,
        name: row.name,
        status: row.status,
        availableHours,
        downtimeHours,
        bookedHours,
        actualHours: Number(row.actual_hours),
        noShows: row.no_shows,
        completed: row.completed,
        cancelled: row.cancelled,
        requested: row.requested,
        utilizationPct: Math.min(100, (bookedHours / capacity) * 100),
      };
    });

    const totalAvailable = utilizationRows.reduce((sum, row) => sum + Math.max(0, row.availableHours - row.downtimeHours), 0);
    const totalBooked = utilizationRows.reduce((sum, row) => sum + row.bookedHours, 0);
    const totalActual = utilizationRows.reduce((sum, row) => sum + row.actualHours, 0);
    const totalBookings = utilizationRows.reduce(
      (sum, row) => sum + row.completed + row.cancelled + row.requested + row.noShows,
      0,
    );
    const totalNoShows = utilizationRows.reduce((sum, row) => sum + row.noShows, 0);

    return {
      from: fromKey,
      to: toKey,
      utilization: utilizationRows,
      totals: {
        availableHours: totalAvailable,
        bookedHours: totalBooked,
        actualHours: totalActual,
        utilizationPct: totalAvailable > 0 ? Math.min(100, (totalBooked / totalAvailable) * 100) : 0,
        bookings: totalBookings,
        noShows: totalNoShows,
        noShowRate: totalBookings > 0 ? (totalNoShows / totalBookings) * 100 : 0,
        unmetDemand: unmet.rows.reduce((sum, row) => sum + row.count, 0),
      },
      unmetDemand: unmet.rows.map((row) => ({
        resourceCode: row.resource_code,
        resourceName: row.resource_name,
        reason: row.reason,
        count: row.count,
      })),
      topUsers: users.rows.map((row) => ({
        userId: row.user_id,
        userName: row.user_name,
        email: row.email,
        department: row.department,
        bookings: row.bookings,
        hours: Number(row.hours),
        noShows: row.no_shows,
      })),
      incidents: incidents.rows[0] ?? { open: 0, investigating: 0, resolved: 0, high: 0 },
      weekly: weekly.rows.map((row) => ({
        week: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(row.week)),
        bookings: row.bookings,
        noShows: row.no_shows,
      })),
    };
  });
}
