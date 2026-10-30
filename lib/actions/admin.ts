"use server";

import { revalidatePath } from "next/cache";
import { withOrg } from "../db";
import { requireUser } from "../auth";
import { canManage } from "../roles";
import { hashPassword } from "../password";
import { notifyUser, recordAudit } from "../audit";
import { fail, field, ok, errorMessage } from "../action-utils";

const ROLES = ["admin", "manager", "technician", "member"];

export async function inviteMemberAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (user.role !== "admin") fail("/admin", "Only administrators can invite members.");
  const email = field(formData, "email").toLowerCase();
  const name = field(formData, "name");
  const role = field(formData, "role");
  const departmentId = field(formData, "department_id") || null;
  const tempPassword = field(formData, "temp_password");
  if (!email.includes("@") || !name) fail("/admin", "Name and a valid email are required.");
  if (!ROLES.includes(role)) fail("/admin", "Choose a valid role.");
  if (tempPassword.length < 8) fail("/admin", "The temporary password must be at least 8 characters.");

  try {
    await withOrg(user.organizationId, async (db) => {
      const existing = await db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1", [email]);
      let userId = existing.rows[0]?.id;
      if (!userId) {
        const passwordHash = await hashPassword(tempPassword);
        const created = await db.query<{ id: string }>(
          "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id",
          [email, name, passwordHash],
        );
        userId = created.rows[0].id;
      }

      const membership = await db.query<{ id: string }>(
        `INSERT INTO memberships (organization_id, user_id, role, department_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, user_id) DO NOTHING
         RETURNING id`,
        [user.organizationId, userId, role, departmentId],
      );
      if (!membership.rows[0]) throw new Error("That person is already a member of this organization.");

      await notifyUser(db, {
        organizationId: user.organizationId,
        userId,
        title: `Welcome to ${user.organizationName}`,
        body: "Your account is ready. Reset your password with an administrator if needed.",
        link: "/dashboard",
      });
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "member.invited",
        entityType: "membership",
        entityId: membership.rows[0].id,
        summary: `${user.name} added ${name} as ${role}`,
        metadata: { email, role, departmentId },
      });
    });
  } catch (error) {
    fail("/admin", errorMessage(error, "Could not invite the member."));
  }

  revalidatePath("/admin");
  ok("/admin", `${name} added as ${role}.`);
}

export async function grantTrainingAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!canManage(user.role)) fail("/admin", "Only facility managers can record training.");
  const userId = field(formData, "user_id");
  const courseId = field(formData, "course_id");
  const months = Number(field(formData, "months") || 12);
  if (!userId || !courseId) fail("/admin", "Choose a member and a course.");
  if (!Number.isFinite(months) || months <= 0 || months > 60) fail("/admin", "Validity must be 1–60 months.");

  try {
    await withOrg(user.organizationId, async (db) => {
      const member = await db.query<{ name: string }>(
        "SELECT u.name FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.id = $1",
        [userId],
      );
      const course = await db.query<{ name: string }>(
        "SELECT name FROM training_courses WHERE id = $1",
        [courseId],
      );
      if (!member.rows[0] || !course.rows[0]) throw new Error("Unknown member or course.");

      await db.query(
        `INSERT INTO training_records (organization_id, user_id, course_id, granted_by, granted_at, expires_at)
         VALUES ($1, $2, $3, $4, now(), now() + ($5 || ' months')::interval)`,
        [user.organizationId, userId, courseId, user.userId, String(months)],
      );
      await notifyUser(db, {
        organizationId: user.organizationId,
        userId,
        title: `Training recorded: ${course.rows[0].name}`,
        body: `Valid for ${months} months. You can now book equipment that requires it.`,
        link: "/resources",
      });
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "training.granted",
        entityType: "training_record",
        entityId: null,
        summary: `${user.name} certified ${member.rows[0].name} for ${course.rows[0].name}`,
        metadata: { months },
      });
    });
  } catch (error) {
    fail("/admin", errorMessage(error, "Could not record training."));
  }

  revalidatePath("/admin");
  ok("/admin", "Training recorded.");
}

export async function createCourseAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!canManage(user.role)) fail("/admin", "Only facility managers can add training courses.");
  const name = field(formData, "name");
  const months = Number(field(formData, "validity_months") || 12);
  if (!name) fail("/admin", "Course name is required.");

  try {
    await withOrg(user.organizationId, async (db) => {
      const course = await db.query<{ id: string }>(
        `INSERT INTO training_courses (organization_id, name, description, validity_months)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [user.organizationId, name, field(formData, "description"), Math.max(1, months)],
      );
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "training_course.created",
        entityType: "training_course",
        entityId: course.rows[0].id,
        summary: `${user.name} created training course ${name}`,
      });
    });
  } catch (error) {
    fail("/admin", errorMessage(error, "Could not create the course."));
  }

  revalidatePath("/admin");
  ok("/admin", "Training course created.");
}

export async function createDepartmentAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!canManage(user.role)) fail("/admin", "Only facility managers can add departments.");
  const name = field(formData, "name");
  if (!name) fail("/admin", "Department name is required.");
  try {
    await withOrg(user.organizationId, async (db) => {
      await db.query("INSERT INTO departments (organization_id, name) VALUES ($1, $2)", [user.organizationId, name]);
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "department.created",
        entityType: "department",
        entityId: null,
        summary: `${user.name} added department ${name}`,
      });
    });
  } catch {
    fail("/admin", "That department already exists.");
  }
  revalidatePath("/admin");
  ok("/admin", "Department added.");
}

export async function createFacilityAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!canManage(user.role)) fail("/admin", "Only facility managers can add facilities.");
  const name = field(formData, "name");
  if (!name) fail("/admin", "Facility name is required.");
  try {
    await withOrg(user.organizationId, async (db) => {
      await db.query("INSERT INTO facilities (organization_id, name, location) VALUES ($1, $2, $3)", [
        user.organizationId,
        name,
        field(formData, "location"),
      ]);
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "facility.created",
        entityType: "facility",
        entityId: null,
        summary: `${user.name} added facility ${name}`,
      });
    });
  } catch {
    fail("/admin", "That facility already exists.");
  }
  revalidatePath("/admin");
  ok("/admin", "Facility added.");
}

export async function updateOrgPolicyAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (user.role !== "admin") fail("/admin", "Only administrators can change booking policy.");
  const maxActive = Number(field(formData, "max_active_bookings"));
  const horizon = Number(field(formData, "max_horizon_days"));
  const grace = Number(field(formData, "no_show_grace_minutes"));
  const open = Number(field(formData, "open_hour"));
  const close = Number(field(formData, "close_hour"));
  if (!Number.isFinite(maxActive) || maxActive < 1 || maxActive > 20) fail("/admin", "Active booking limit must be 1–20.");
  if (!Number.isFinite(horizon) || horizon < 1 || horizon > 365) fail("/admin", "Horizon must be 1–365 days.");
  if (!Number.isFinite(grace) || grace < 0 || grace > 180) fail("/admin", "Grace period must be 0–180 minutes.");
  if (!Number.isFinite(open) || !Number.isFinite(close) || open < 0 || close > 24 || close <= open) {
    fail("/admin", "Facility hours must be a valid same-day range.");
  }

  await withOrg(user.organizationId, async (db) => {
    await db.query(
      `UPDATE organizations
          SET max_active_bookings = $2, max_horizon_days = $3, no_show_grace_minutes = $4,
              open_hour = $5, close_hour = $6
        WHERE id = $1`,
      [user.organizationId, maxActive, horizon, grace, open, close],
    );
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "organization.policy_updated",
      entityType: "organization",
      entityId: user.organizationId,
      summary: `${user.name} updated booking policy`,
      metadata: { maxActive, horizon, grace, open, close },
    });
  });

  revalidatePath("/admin");
  revalidatePath("/dashboard");
  ok("/admin", "Booking policy updated.");
}

export async function markNotificationsReadAction(): Promise<void> {
  const user = await requireUser();
  await withOrg(user.organizationId, async (db) => {
    await db.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [user.userId]);
  });
  revalidatePath("/dashboard");
}
