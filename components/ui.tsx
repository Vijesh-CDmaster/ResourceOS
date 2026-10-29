import Link from "next/link";
import type { ReactNode } from "react";

const TONES = {
  green: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-800 border-amber-200",
  red: "bg-red-50 text-red-700 border-red-200",
  slate: "bg-slate-100 text-slate-600 border-slate-200",
  brand: "bg-brand-50 text-brand-700 border-brand-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function BookingBadge({ status }: { status: string }) {
  const tone: Record<string, Tone> = {
    requested: "amber",
    confirmed: "green",
    completed: "slate",
    cancelled: "slate",
    rejected: "red",
    no_show: "red",
  };
  return <Badge tone={tone[status] ?? "slate"}>{status.replace("_", " ")}</Badge>;
}

export function ResourceBadge({ status }: { status: string }) {
  const tone: Record<string, Tone> = {
    ready: "green",
    maintenance: "amber",
    suspended: "red",
    retired: "slate",
  };
  return <Badge tone={tone[status] ?? "slate"}>{status}</Badge>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const tone: Record<string, Tone> = { high: "red", medium: "amber", low: "slate" };
  return <Badge tone={tone[severity] ?? "slate"}>{severity}</Badge>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow ? (
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-600">{eyebrow}</p>
        ) : null}
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "brand",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
}) {
  const bar = {
    green: "bg-emerald-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
    slate: "bg-slate-400",
    brand: "bg-brand-600",
    violet: "bg-violet-500",
  }[tone];
  return (
    <div className="card-pad relative overflow-hidden">
      <div className={`absolute inset-x-0 top-0 h-0.5 ${bar}`} />
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight text-ink">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-white/60 px-6 py-12 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description ? <p className="mt-1 max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Flash({ error, ok }: { error?: string; ok?: string }) {
  if (!error && !ok) return null;
  return (
    <div
      role="status"
      className={`mb-5 flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${
        error
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-emerald-200 bg-emerald-50 text-emerald-800"
      }`}
    >
      <span aria-hidden className="mt-0.5 text-base leading-none">
        {error ? "!" : "✓"}
      </span>
      <span>{error ?? ok}</span>
    </div>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description ? <p className="text-xs text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Meter({ value, tone = "brand" }: { value: number; tone?: Tone }) {
  const color = {
    green: "bg-emerald-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
    slate: "bg-slate-400",
    brand: "bg-brand-600",
    violet: "bg-violet-500",
  }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06]">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-sm font-medium text-brand-700 hover:underline">
      {children}
    </Link>
  );
}
