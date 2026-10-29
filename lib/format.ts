export const IST_OFFSET = "+05:30";

export function formatDate(value: Date | string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

export function formatDateTime(value: Date | string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value));
}

export function formatTime(value: Date | string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value));
}

export function formatRange(startsAt: Date | string, endsAt: Date | string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const sameDay =
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(start) ===
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(end);
  return sameDay
    ? `${formatDate(start)} · ${formatTime(start)} – ${formatTime(end)}`
    : `${formatDateTime(start)} → ${formatDateTime(end)}`;
}

export function istDateKey(value: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

export function shiftDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00${IST_OFFSET}`);
  date.setUTCDate(date.getUTCDate() + days);
  return istDateKey(date);
}

/** Parses a date + time entered in institute local time into an absolute instant. */
export function parseInstituteTime(dateKey: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const parsed = new Date(`${dateKey}T${time}:00${IST_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function minutesFromMidnight(value: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(value);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function istWeekday(value: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short" }).format(value);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

export function hoursBetween(start: Date | string, end: Date | string): number {
  return (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
}

export function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`;
}

export function timeAgo(value: Date | string): string {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

/** Indian-format currency, e.g. ₹8,20,000. Null/undefined render as a dash. */
export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

/** Compact Indian currency, e.g. ₹14.5L or ₹1.2Cr. Used in dense tables. */
export function formatMoneyCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 1_00_00_000) return `₹${(value / 1_00_00_000).toFixed(2)}Cr`;
  if (absolute >= 1_00_000) return `₹${(value / 1_00_000).toFixed(1)}L`;
  if (absolute >= 1_000) return `₹${(value / 1_000).toFixed(0)}k`;
  return `₹${Math.round(value)}`;
}

/** Formats a ratio (0.42) as a percentage string; null renders as "unknown". */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "unknown";
  return `${(value * 100).toFixed(digits)}%`;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n");
}
