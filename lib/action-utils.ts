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
