import "server-only";
import { cache } from "react";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { pool } from "./db";
import type { Role } from "./roles";

export const SESSION_COOKIE = "ros_session";
const SESSION_DAYS = 7;

export type SessionUser = {
  userId: string;
  name: string;
  email: string;
  role: Role;
  organizationId: string;
  organizationName: string;
  departmentId: string | null;
  timezone: string;
  openHour: number;
  closeHour: number;
  maxActiveBookings: number;
  maxHorizonDays: number;
  noShowGraceMinutes: number;
};

type SessionRow = {
  user_id: string;
  name: string;
  email: string;
  role: Role;
  organization_id: string;
  organization_name: string;
  department_id: string | null;
  timezone: string;
  open_hour: number;
  close_hour: number;
  max_active_bookings: number;
  max_horizon_days: number;
  no_show_grace_minutes: number;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const { rows } = await pool.query<SessionRow>(
    `SELECT u.id AS user_id, u.name, u.email, m.role, m.organization_id, m.department_id,
            o.name AS organization_name, o.timezone, o.open_hour, o.close_hour,
            o.max_active_bookings, o.max_horizon_days, o.no_show_grace_minutes
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN memberships m ON m.user_id = u.id
       JOIN organizations o ON o.id = m.organization_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
      ORDER BY m.created_at
      LIMIT 1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    departmentId: row.department_id,
    timezone: row.timezone,
    openHour: row.open_hour,
    closeHour: row.close_hour,
    maxActiveBookings: row.max_active_bookings,
    maxHorizonDays: row.max_horizon_days,
    noShowGraceMinutes: row.no_show_grace_minutes,
  };
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect("/dashboard?denied=1");
  return user;
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, hashToken(token), expiresAt],
  );
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]).catch(() => {});
  }
  store.delete(SESSION_COOKIE);
}
