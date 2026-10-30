"use server";

import { revalidatePath } from "next/cache";
import { withOrg } from "../db";
import { requireUser } from "../auth";
import { canManage, isStaff } from "../roles";
import { notifyManagers, recordAudit } from "../audit";
import { fail, field, ok, errorMessage } from "../action-utils";

const STATUSES = ["ready", "maintenance", "suspended", "retired"];

async function insertAvailability(
  db: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  organizationId: string,
  resourceId: string,
  openHour: number,
  closeHour: number,
) {
  for (let weekday = 1; weekday <= 6; weekday++) {
    await db.query(
      `INSERT INTO availability_rules (organization_id, resource_id, weekday, opens_at, closes_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        organizationId,
        resourceId,
        weekday,
        `${String(openHour).padStart(2, "0")}:00`,
        `${String(closeHour).padStart(2, "0")}:00`,
      ],
    );
  }
}

export async function createResourceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!canManage(user.role)) fail("/admin", "Only administrators and facility managers can add resources.");
  const code = field(formData, "code").toUpperCase();
  const name = field(formData, "name");
  if (!code || !name) fail("/admin", "Resource code and name are required.");

  try {
    await withOrg(user.organizationId, async (db) => {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO resources (organization_id, facility_id, department_id, code, name, category,
           description, location, capacity, status, requires_approval, training_course_id,
           max_hours_per_booking)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [
          user.organizationId,
          field(formData, "facility_id") || null,
          field(formData, "department_id") || null,
          code,
          name,
          field(formData, "category") || "General",
          field(formData, "description"),
          field(formData, "location"),
          Math.max(1, Number(field(formData, "capacity") || 1)),
          STATUSES.includes(field(formData, "status")) ? field(formData, "status") : "ready",
          field(formData, "requires_approval") === "yes",
          field(formData, "training_course_id") || null,
          Math.max(0.5, Number(field(formData, "max_hours") || 4)),
        ],
      );
      await insertAvailability(db, user.organizationId, inserted.rows[0].id, user.openHour, user.closeHour);
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "resource.created",
        entityType: "resource",
        entityId: inserted.rows[0].id,
        summary: `${user.name} added ${code} — ${name}`,
      });
    });
  } catch (error) {
    fail("/admin", errorMessage(error, "Could not create the resource."));
  }

  revalidatePath("/admin");
  revalidatePath("/resources");
  ok("/admin", `${code} created with Mon–Sat availability.`);
}

export async function updateResourceStatusAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!isStaff(user.role)) fail("/resources", "Only facility staff can change resource status.");
  const resourceId = field(formData, "resource_id");
  const status = field(formData, "status");
  const note = field(formData, "note");
  if (!STATUSES.includes(status)) fail("/resources", "Unknown status.");
  if ((status === "retired" || status === "suspended") && !canManage(user.role)) {
    fail("/resources", "Only managers can suspend or retire a resource.");
  }
  const backTo = field(formData, "back_to") || "/resources";

  try {
    await withOrg(user.organizationId, async (db) => {
      const resource = await db.query<{ name: string; status: string }>(
        "SELECT name, status FROM resources WHERE id = $1 FOR UPDATE",
        [resourceId],
      );
      if (!resource.rows[0]) throw new Error("Resource not found.");
      await db.query("UPDATE resources SET status = $2 WHERE id = $1", [resourceId, status]);
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "resource.status_changed",
        entityType: "resource",
        entityId: resourceId,
        summary: `${user.name} set ${resource.rows[0].name} to ${status}`,
        metadata: { from: resource.rows[0].status, to: status, note },
      });
      if (status !== "ready") {
        await notifyManagers(db, {
          organizationId: user.organizationId,
          title: `${resource.rows[0].name} is now ${status}`,
          body: note || "New bookings are blocked for this resource.",
          link: `/resources/${resourceId}`,
          excludeUserId: user.userId,
        });
      }
    });
  } catch (error) {
    fail(backTo, errorMessage(error, "Could not update the resource."));
  }

  revalidatePath(backTo);
  revalidatePath("/resources");
  ok(backTo, `Resource marked ${status}.`);
}

const IMPORT_COLUMNS = [
  "code",
  "name",
  "category",
  "facility",
  "department",
  "description",
  "capacity",
  "requires_approval",
  "training",
  "max_hours",
  "location",
] as const;

export async function importResourcesAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!canManage(user.role)) fail("/admin", "Only administrators and facility managers can import resources.");
  const csv = field(formData, "csv");
  if (!csv) fail("/admin", "Paste CSV rows before importing.");

  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0]?.toLowerCase().startsWith("code")) lines.shift();

  let result: { imported: number; errors: string[] };
  try {
    result = await withOrg(user.organizationId, async (db) => {
      const lookups = await Promise.all([
        db.query<{ id: string; name: string }>("SELECT id, name FROM facilities"),
        db.query<{ id: string; name: string }>("SELECT id, name FROM departments"),
        db.query<{ id: string; name: string }>("SELECT id, name FROM training_courses"),
      ]);
      const facilities = new Map(lookups[0].rows.map((row) => [row.name.toLowerCase(), row.id]));
      const departments = new Map(lookups[1].rows.map((row) => [row.name.toLowerCase(), row.id]));
      const courses = new Map(lookups[2].rows.map((row) => [row.name.toLowerCase(), row.id]));

      let imported = 0;
      const errors: string[] = [];

      for (const [index, line] of lines.entries()) {
        const cells = line.split(",").map((cell) => cell.trim());
        const row = Object.fromEntries(IMPORT_COLUMNS.map((column, i) => [column, cells[i] ?? ""]));
        if (!row.code || !row.name) {
          errors.push(`Row ${index + 1}: code and name are required`);
          continue;
        }
        const facilityId = row.facility ? facilities.get(row.facility.toLowerCase()) : null;
        const departmentId = row.department ? departments.get(row.department.toLowerCase()) : null;
        if (row.facility && !facilityId) {
          errors.push(`Row ${index + 1}: unknown facility "${row.facility}"`);
          continue;
        }
        if (row.department && !departmentId) {
          errors.push(`Row ${index + 1}: unknown department "${row.department}"`);
          continue;
        }
        const courseId = row.training ? courses.get(row.training.toLowerCase()) : null;
        if (row.training && !courseId) {
          errors.push(`Row ${index + 1}: unknown training course "${row.training}"`);
          continue;
        }

        const inserted = await db.query<{ id: string }>(
          `INSERT INTO resources (organization_id, facility_id, department_id, code, name, category, description,
             location, capacity, requires_approval, training_course_id, max_hours_per_booking)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (organization_id, code) DO NOTHING
           RETURNING id`,
          [
            user.organizationId,
            facilityId,
            departmentId,
            row.code.toUpperCase(),
            row.name,
            row.category || "General",
            row.description,
            row.location,
            Math.max(1, Number(row.capacity || 1)),
            ["yes", "true", "1"].includes(row.requires_approval.toLowerCase()),
            courseId,
            Math.max(0.5, Number(row.max_hours || 4)),
          ],
        );
        if (inserted.rows[0]) {
          await insertAvailability(db, user.organizationId, inserted.rows[0].id, user.openHour, user.closeHour);
          imported++;
        } else {
          errors.push(`Row ${index + 1}: code ${row.code.toUpperCase()} already exists`);
        }
      }

      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "resource.imported",
        entityType: "resource",
        entityId: null,
        summary: `${user.name} imported ${imported} resource(s) from CSV`,
        metadata: { imported, skipped: errors.length },
      });
      return { imported, errors };
    });
  } catch (error) {
    fail("/admin", errorMessage(error, "Import failed."));
  }

  revalidatePath("/admin");
  revalidatePath("/resources");
  if (result.errors.length) {
    fail(
      "/admin",
      `Imported ${result.imported}; ${result.errors.length} row(s) skipped — ${result.errors.slice(0, 3).join("; ")}`,
    );
  }
  ok("/admin", `Imported ${result.imported} resource(s).`);
}
