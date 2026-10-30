"use server";

import { revalidatePath } from "next/cache";
import { withOrg } from "../db";
import { requireUser } from "../auth";
import { canManage, isStaff } from "../roles";
import { notifyManagers, notifyUser, recordAudit } from "../audit";
import { fail, field, ok, parseDateInput, errorMessage } from "../action-utils";

export async function createMaintenanceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!isStaff(user.role)) fail("/operations", "Only facility staff can schedule maintenance.");
  const resourceId = field(formData, "resource_id");
  const title = field(formData, "title");
  const description = field(formData, "description");
  const start = parseDateInput(field(formData, "starts_at"));
  const end = parseDateInput(field(formData, "ends_at"));
  const force = field(formData, "force") === "yes";
  if (!resourceId || !title) fail("/operations", "Resource and title are required.");
  if (!start || !end) fail("/operations", "Choose a valid maintenance window.");
  if (end <= start) fail("/operations", "The maintenance window must end after it starts.");

  try {
    await withOrg(user.organizationId, async (db) => {
      const resource = await db.query<{ id: string; name: string }>(
        "SELECT id, name FROM resources WHERE id = $1",
        [resourceId],
      );
      if (!resource.rows[0]) throw new Error("Resource not found.");

      const conflicts = await db.query<{ id: string; user_id: string; starts_at: Date }>(
        `SELECT id, user_id, starts_at FROM bookings
          WHERE resource_id = $1 AND status IN ('requested','confirmed')
            AND tstzrange(starts_at, ends_at) && tstzrange($2, $3)`,
        [resourceId, start, end],
      );
      if (conflicts.rows.length > 0 && !force) {
        throw new Error(`__conflicts__${conflicts.rows.length}`);
      }

      const maintenance = await db.query<{ id: string }>(
        `INSERT INTO maintenance_records (organization_id, resource_id, title, description, status,
           scheduled_start, scheduled_end, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [user.organizationId, resourceId, title, description,
          start.getTime() <= Date.now() ? "in_progress" : "scheduled", start, end, user.userId],
      );

      await db.query(
        `INSERT INTO blackout_periods (organization_id, resource_id, maintenance_id, starts_at, ends_at, reason, kind, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'maintenance', $7)`,
        [user.organizationId, resourceId, maintenance.rows[0].id, start, end, title, user.userId],
      );

      if (start.getTime() <= Date.now() + 60 * 60_000) {
        await db.query("UPDATE resources SET status = 'maintenance' WHERE id = $1", [resourceId]);
      }

      for (const booking of conflicts.rows) {
        await notifyUser(db, {
          organizationId: user.organizationId,
          userId: booking.user_id,
          title: `Maintenance scheduled: ${resource.rows[0].name}`,
          body: `${title}. Your booking overlaps this window and may be moved. The facility team will contact you.`,
          link: "/bookings",
        });
      }

      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "maintenance.created",
        entityType: "maintenance",
        entityId: maintenance.rows[0].id,
        summary: `${user.name} scheduled "${title}" for ${resource.rows[0].name}`,
        metadata: { start, end, conflictingBookings: conflicts.rows.length, forced: force },
      });
    });
  } catch (error) {
    const message = errorMessage(error, "");
    const conflictMatch = message.match(/^__conflicts__(\d+)$/);
    if (conflictMatch) {
      fail(
        "/operations",
        `${conflictMatch[1]} open booking(s) overlap this window. Review them, then tick the override box to proceed.`,
      );
    }
    fail("/operations", message || "Could not schedule maintenance.");
  }

  revalidatePath("/operations");
  revalidatePath("/resources");
  ok("/operations", "Maintenance scheduled and bookings blocked.");
}

export async function resolveMaintenanceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!isStaff(user.role)) fail("/operations", "Only facility staff can close maintenance.");
  const maintenanceId = field(formData, "maintenance_id");

  try {
    await withOrg(user.organizationId, async (db) => {
      const record = await db.query<{ id: string; resource_id: string; title: string; status: string }>(
        "SELECT id, resource_id, title, status FROM maintenance_records WHERE id = $1 FOR UPDATE",
        [maintenanceId],
      );
      const maintenance = record.rows[0];
      if (!maintenance) throw new Error("Maintenance record not found.");
      if (maintenance.status === "resolved") throw new Error("This maintenance record is already closed.");

      await db.query(
        "UPDATE maintenance_records SET status = 'resolved', resolved_at = now() WHERE id = $1",
        [maintenanceId],
      );
      await db.query(
        `UPDATE blackout_periods SET ends_at = LEAST(ends_at, now())
          WHERE maintenance_id = $1 AND ends_at > now() AND starts_at <= now()`,
        [maintenanceId],
      );
      await db.query(
        "DELETE FROM blackout_periods WHERE maintenance_id = $1 AND starts_at > now()",
        [maintenanceId],
      );
      await db.query("UPDATE resources SET status = 'ready' WHERE id = $1 AND status = 'maintenance'", [
        maintenance.resource_id,
      ]);
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "maintenance.resolved",
        entityType: "maintenance",
        entityId: maintenanceId,
        summary: `${user.name} resolved "${maintenance.title}" and released the resource`,
      });
    });
  } catch (error) {
    fail("/operations", errorMessage(error, "Could not close maintenance."));
  }

  revalidatePath("/operations");
  revalidatePath("/resources");
  ok("/operations", "Maintenance closed and resource released.");
}

export async function reportIncidentAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const resourceId = field(formData, "resource_id");
  const title = field(formData, "title");
  const description = field(formData, "description");
  const severity = field(formData, "severity") || "medium";
  const bookingId = field(formData, "booking_id");
  if (!resourceId || !title) fail("/operations", "Resource and summary are required.");
  if (!["low", "medium", "high"].includes(severity)) fail("/operations", "Invalid severity.");

  try {
    await withOrg(user.organizationId, async (db) => {
      const resource = await db.query<{ name: string }>("SELECT name FROM resources WHERE id = $1", [resourceId]);
      if (!resource.rows[0]) throw new Error("Resource not found.");
      const incident = await db.query<{ id: string }>(
        `INSERT INTO incidents (organization_id, resource_id, booking_id, reported_by, severity, title, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [user.organizationId, resourceId, bookingId || null, user.userId, severity, title, description],
      );
      await notifyManagers(db, {
        organizationId: user.organizationId,
        title: `Incident reported: ${resource.rows[0].name}`,
        body: `${severity.toUpperCase()} — ${title}`,
        link: "/operations",
        excludeUserId: user.userId,
      });
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "incident.reported",
        entityType: "incident",
        entityId: incident.rows[0].id,
        summary: `${user.name} reported "${title}" on ${resource.rows[0].name}`,
        metadata: { severity },
      });
    });
  } catch (error) {
    fail("/operations", errorMessage(error, "Could not report the incident."));
  }

  revalidatePath("/operations");
  ok("/operations", "Incident reported. Facility staff have been notified.");
}

export async function resolveIncidentAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!canManage(user.role)) fail("/operations", "Only facility managers can close incidents.");
  const incidentId = field(formData, "incident_id");
  const resolution = field(formData, "resolution");
  const releaseResource = field(formData, "release_resource") === "yes";
  if (!resolution) fail("/operations", "Record the resolution before closing.");

  try {
    await withOrg(user.organizationId, async (db) => {
      const incident = await db.query<{ id: string; resource_id: string; title: string; status: string }>(
        "SELECT id, resource_id, title, status FROM incidents WHERE id = $1 FOR UPDATE",
        [incidentId],
      );
      if (!incident.rows[0]) throw new Error("Incident not found.");
      if (incident.rows[0].status === "resolved") throw new Error("This incident is already closed.");

      await db.query(
        `UPDATE incidents SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now()
          WHERE id = $1`,
        [incidentId, resolution, user.userId],
      );
      if (releaseResource) {
        await db.query("UPDATE resources SET status = 'ready' WHERE id = $1 AND status <> 'retired'", [
          incident.rows[0].resource_id,
        ]);
      }
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "incident.resolved",
        entityType: "incident",
        entityId: incidentId,
        summary: `${user.name} closed "${incident.rows[0].title}"`,
        metadata: { resolution, releasedResource: releaseResource },
      });
    });
  } catch (error) {
    fail("/operations", errorMessage(error, "Could not close the incident."));
  }

  revalidatePath("/operations");
  revalidatePath("/resources");
  ok("/operations", "Incident closed and evidence chain updated.");
}
