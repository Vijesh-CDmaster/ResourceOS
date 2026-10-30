import "server-only";
import { redirect } from "next/navigation";

export function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

export function optionalField(formData: FormData, name: string): string | null {
  const value = field(formData, name);
  return value.length ? value : null;
}

export function fail(path: string, message: string): never {
  const separator = path.includes("?") ? "&" : "?";
  redirect(`${path}${separator}error=${encodeURIComponent(message)}`);
}

export function ok(path: string, message: string): never {
  const separator = path.includes("?") ? "&" : "?";
  redirect(`${path}${separator}ok=${encodeURIComponent(message)}`);
}

/**
 * Turns a thrown error into an operator-facing message. PostgreSQL errors carry a
 * five-character SQLSTATE (`23505`, `22P02`, `23P01`…) and often embed table,
 * constraint and column names; those are logged by the caller and replaced with
 * the action's own wording so internals never reach the browser.
 */
export function errorMessage(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return fallback;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

export function requireFields(values: Record<string, string>): void {
  for (const [label, value] of Object.entries(values)) {
    if (!value) throw new Error(`${label} is required.`);
  }
}

export function parseDateInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+05:30`);
  return Number.isNaN(date.getTime()) ? null : date;
}
