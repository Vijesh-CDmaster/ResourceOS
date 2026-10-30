"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes } from "node:crypto";
import { pool } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { createSession, destroySession } from "@/lib/auth";
import {
  checkLoginAllowed,
  clearLoginFailures,
  loginIdentifiers,
  recordLoginFailure,
} from "@/lib/login-throttle";

export type LoginState = { error?: string } | null;

// A syntactically valid hash for a password nobody knows. Verifying against it
// gives a miss exactly the same cost as a hit, so response time does not reveal
// whether an email address has an account.
const DUMMY_HASH = `scrypt$16384$8$1$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}`;

/**
 * Best-effort client address for the address-based budget. Behind a proxy this
 * is the first forwarded hop; when the header is absent or spoofed, the
 * per-account budget still applies.
 */
async function clientAddress(): Promise<string | null> {
  const store = await headers();
  const forwarded = store.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = store.get("x-real-ip")?.trim();
  const address = forwarded || realIp;
  return address ? address.slice(0, 64) : null;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };

  const identifiers = loginIdentifiers({ email, address: await clientAddress() });
  const verdict = await checkLoginAllowed(identifiers);
  if (!verdict.allowed) {
    const minutes = Math.max(1, Math.ceil(verdict.retryAfterSeconds / 60));
    return { error: `Too many sign-in attempts. Try again in ${minutes} minute(s).` };
  }

  const { rows } = await pool.query<{ id: string; name: string; password_hash: string; member: boolean }>(
    `SELECT u.id, u.name, u.password_hash,
            EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id) AS member
       FROM users u
      WHERE lower(u.email) = $1`,
    [email],
  );
  const user = rows[0];
  const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !valid) {
    await recordLoginFailure(identifiers);
    return { error: "Email or password is incorrect." };
  }
  if (!user.member) {
    // No workspace means no access; the password was still correct, so this is
    // not counted as a failure but it is also not a session.
    return { error: "This account is not attached to a workspace yet." };
  }

  await clearLoginFailures(identifiers);
  await createSession(user.id);
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}
