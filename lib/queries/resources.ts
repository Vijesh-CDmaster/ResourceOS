import "server-only";
import { withOrg } from "../db";
import { getDayAvailability, type DayAvailability } from "../availability";

export type ResourceRow = {
  id: string;
  code: string;
  name: string;
  category: string;
  description: string;
  location: string;
  capacity: number;
  status: "ready" | "maintenance" | "suspended" | "retired";
  requiresApproval: boolean;
  trainingName: string | null;
  trainingCourseId: string | null;
  facilityName: string | null;
  departmentName: string | null;
  maxHours: number;
  specs: Record<string, string>;
  upcomingCount: number;
};

type RawResource = {
  id: string;
  code: string;
  name: string;
  category: string;
  description: string;
  location: string;
  capacity: number;
  status: ResourceRow["status"];
  requires_approval: boolean;
  training_name: string | null;
  training_course_id: string | null;
  facility_name: string | null;
  department_name: string | null;
  max_hours_per_booking: string;
  specs: Record<string, string>;
  upcoming_count: number;
};

function mapResource(row: RawResource): ResourceRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    description: row.description,
    location: row.location,
    capacity: row.capacity,
    status: row.status,
    requiresApproval: row.requires_approval,
    trainingName: row.training_name,
    trainingCourseId: row.training_course_id,
    facilityName: row.facility_name,
    departmentName: row.department_name,
    maxHours: Number(row.max_hours_per_booking),
    specs: row.specs ?? {},
    upcomingCount: row.upcoming_count,
  };
}

export async function listResources(
  organizationId: string,
  options: { search?: string; category?: string; status?: string; facilityId?: string } = {},
): Promise<ResourceRow[]> {
  return withOrg(organizationId, async (db) => {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (options.search) {
      params.push(`%${options.search}%`);
      conditions.push(
        `(r.name ILIKE $${params.length} OR r.code ILIKE $${params.length} OR r.description ILIKE $${params.length} OR r.location ILIKE $${params.length})`,
      );
    }
    if (options.category) {
      params.push(options.category);
      conditions.push(`r.category = $${params.length}`);
    }
    if (options.status) {
      params.push(options.status);
      conditions.push(`r.status = $${params.length}`);
    }
    if (options.facilityId) {
      params.push(options.facilityId);
      conditions.push(`r.facility_id = $${params.length}`);
    }

    const { rows } = await db.query<RawResource>(
      `SELECT r.id, r.code, r.name, r.category, r.description, r.location, r.capacity, r.status,
              r.requires_approval, r.training_course_id, r.max_hours_per_booking, r.specs,
              f.name AS facility_name, d.name AS department_name, tc.name AS training_name,
              (SELECT count(*)::int FROM bookings b
                WHERE b.resource_id = r.id AND b.status IN ('requested','confirmed')
                  AND b.starts_at > now()) AS upcoming_count
         FROM resources r
         LEFT JOIN facilities f ON f.id = r.facility_id
         LEFT JOIN departments d ON d.id = r.department_id
         LEFT JOIN training_courses tc ON tc.id = r.training_course_id
        ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY CASE r.status WHEN 'ready' THEN 0 ELSE 1 END, r.name`,
      params,
    );
    return rows.map(mapResource);
  });
}

export type ResourceDetail = ResourceRow & {
  rules: Array<{ weekday: number; opensAt: string; closesAt: string }>;
  blackouts: Array<{ id: string; startsAt: Date; endsAt: Date; reason: string; kind: string }>;
  upcoming: Array<{
    id: string;
    startsAt: Date;
    endsAt: Date;
    status: string;
    userId: string;
    userName: string;
  }>;
  trainingValid: boolean;
  trainingExpiresAt: Date | null;
  openIncidents: number;
  availability: DayAvailability;
};

export async function getResourceDetail(
  organizationId: string,
  userId: string,
  resourceId: string,
  dateKey: string,
): Promise<ResourceDetail | null> {
  const row = await withOrg(organizationId, async (db) => {
    const resourceResult = await db.query<RawResource>(
      `SELECT r.id, r.code, r.name, r.category, r.description, r.location, r.capacity, r.status,
              r.requires_approval, r.training_course_id, r.max_hours_per_booking, r.specs,
              f.name AS facility_name, d.name AS department_name, tc.name AS training_name,
              (SELECT count(*)::int FROM bookings b
                WHERE b.resource_id = r.id AND b.status IN ('requested','confirmed')
                  AND b.starts_at > now()) AS upcoming_count
         FROM resources r
         LEFT JOIN facilities f ON f.id = r.facility_id
         LEFT JOIN departments d ON d.id = r.department_id
         LEFT JOIN training_courses tc ON tc.id = r.training_course_id
        WHERE r.id = $1`,
      [resourceId],
    );
    const resource = resourceResult.rows[0];
    if (!resource) return null;

    const [rules, blackouts, upcoming, training, incidents] = await Promise.all([
      db.query<{ weekday: number; opens_at: string; closes_at: string }>(
        "SELECT weekday, opens_at, closes_at FROM availability_rules WHERE resource_id = $1 ORDER BY weekday",
        [resourceId],
      ),
      db.query<{ id: string; starts_at: Date; ends_at: Date; reason: string; kind: string }>(
        `SELECT id, starts_at, ends_at, reason, kind FROM blackout_periods
          WHERE resource_id = $1 AND ends_at > now() ORDER BY starts_at LIMIT 10`,
        [resourceId],
      ),
      db.query<{ id: string; starts_at: Date; ends_at: Date; status: string; user_id: string; user_name: string }>(
        `SELECT b.id, b.starts_at, b.ends_at, b.status, b.user_id, u.name AS user_name
           FROM bookings b JOIN users u ON u.id = b.user_id
          WHERE b.resource_id = $1 AND b.ends_at > now() AND b.status IN ('requested','confirmed')
          ORDER BY b.starts_at LIMIT 12`,
        [resourceId],
      ),
      resource.training_course_id
        ? db.query<{ expires_at: Date }>(
            `SELECT expires_at FROM training_records
              WHERE user_id = $1 AND course_id = $2 AND expires_at > now()
              ORDER BY expires_at DESC LIMIT 1`,
            [userId, resource.training_course_id],
          )
        : Promise.resolve({ rows: [] as Array<{ expires_at: Date }> }),
      db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM incidents WHERE resource_id = $1 AND status <> 'resolved'",
        [resourceId],
      ),
    ]);

    return {
      resource,
      rules: rules.rows,
      blackouts: blackouts.rows,
      upcoming: upcoming.rows,
      trainingExpiresAt: training.rows[0]?.expires_at ?? null,
      trainingValid: !resource.training_course_id || training.rows.length > 0,
      openIncidents: incidents.rows[0]?.count ?? 0,
    };
  });

  if (!row) return null;
  const availability = await getDayAvailability(organizationId, resourceId, dateKey);

  return {
    ...mapResource(row.resource),
    rules: row.rules.map((r) => ({
      weekday: r.weekday,
      opensAt: r.opens_at.slice(0, 5),
      closesAt: r.closes_at.slice(0, 5),
    })),
    blackouts: row.blackouts.map((b) => ({
      id: b.id,
      startsAt: b.starts_at,
      endsAt: b.ends_at,
      reason: b.reason,
      kind: b.kind,
    })),
    upcoming: row.upcoming.map((b) => ({
      id: b.id,
      startsAt: b.starts_at,
      endsAt: b.ends_at,
      status: b.status,
      userId: b.user_id,
      userName: b.user_name,
    })),
    trainingValid: row.trainingValid,
    trainingExpiresAt: row.trainingExpiresAt,
    openIncidents: row.openIncidents,
    availability,
  };
}

export async function getResourceOptions(organizationId: string): Promise<Array<{ id: string; code: string; name: string }>> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{ id: string; code: string; name: string }>(
      "SELECT id, code, name FROM resources WHERE status <> 'retired' ORDER BY name",
    );
    return rows;
  });
}

export async function getResourceLookups(organizationId: string) {
  return withOrg(organizationId, async (db) => {
    const [facilities, departments, courses] = await Promise.all([
      db.query<{ id: string; name: string; location: string }>("SELECT id, name, location FROM facilities ORDER BY name"),
      db.query<{ id: string; name: string }>("SELECT id, name FROM departments ORDER BY name"),
      db.query<{ id: string; name: string; validity_months: number }>(
        "SELECT id, name, validity_months FROM training_courses ORDER BY name",
      ),
    ]);
    return {
      facilities: facilities.rows,
      departments: departments.rows,
      courses: courses.rows,
    };
  });
}
