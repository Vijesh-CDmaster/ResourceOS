"use server";

import { redirect } from "next/navigation";
import { pool } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { createSession, destroySession } from "@/lib/auth";

export type LoginState = { error?: string } | null;

type Attempt = { count: number; resetAt: number };
const attempts = new Map<string, Attempt>();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 8;

function throttled(key: string): boolean {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < Date.now()) {
    attempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  if (throttled(email)) {
    return { error: "Too many sign-in attempts. Wait a few minutes and try again." };
  }

  const { rows } = await pool.query<{ id: string; name: string; password_hash: string; member: boolean }>(
    `SELECT u.id, u.name, u.password_hash,
            EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id) AS member
       FROM users u
      WHERE lower(u.email) = $1`,
    [email],
  );
  const user = rows[0];
  const valid = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !valid) return { error: "Email or password is incorrect." };
  if (!user.member) return { error: "This account is not attached to a workspace yet." };

  attempts.delete(email);
  await createSession(user.id);
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}
