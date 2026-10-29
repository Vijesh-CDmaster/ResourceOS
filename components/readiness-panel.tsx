import type { ReadinessResult } from "@/lib/readiness";

const STATE_COPY = {
  blocked: {
    label: "Blocked",
    heading: "This asset cannot be booked right now",
    tone: "border-red-200 bg-red-50/70",
    chip: "bg-red-600 text-white",
    dot: "bg-red-600",
  },
  warnings: {
    label: "Ready with warnings",
    heading: "Bookable, with conditions to watch",
    tone: "border-amber-200 bg-amber-50/70",
    chip: "bg-amber-500 text-night",
    dot: "bg-amber-500",
  },
  ready: {
    label: "Ready",
    heading: "All readiness checks pass",
    tone: "border-emerald-200 bg-emerald-50/60",
    chip: "bg-emerald-600 text-white",
    dot: "bg-emerald-600",
  },
} as const;

/**
 * Readiness verdict, shown wherever an asset is booked or inspected.
 * Status is always carried by a word as well as colour, and every blocking
 * reason states the corrective action rather than just the failure.
 */
export function ReadinessPanel({
  result,
  title = "Operational readiness",
  showWhenReady = true,
}: {
  result: ReadinessResult;
  title?: string;
  showWhenReady?: boolean;
}) {
  const copy = STATE_COPY[result.state];
  if (result.state === "ready" && !showWhenReady) return null;

  return (
    <section className={`rounded-2xl border ${copy.tone} p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{title}</p>
          <h2 className="mt-1 text-base font-semibold text-ink">{copy.heading}</h2>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${copy.chip}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" aria-hidden />
          {copy.label}
        </span>
      </div>

      {result.reasons.length === 0 ? (
        <p className="mt-3 text-sm text-ink/70">
          No blocking conditions, no open incidents, no stock or calibration problems were found.
        </p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {result.reasons.map((reason) => (
            <li
              key={reason.code}
              className="rounded-xl border border-white/70 bg-white/80 px-3.5 py-3"
            >
              <div className="flex items-start gap-2.5">
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    reason.severity === "block" ? "bg-red-600" : "bg-amber-500"
                  }`}
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">
                    {reason.title}
                    <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
                      {reason.severity === "block" ? "blocks booking" : "warning"}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-ink/75">{reason.detail}</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-brand-700">
                    <span className="font-semibold">Next step:</span> {reason.action}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-[11px] text-muted">
        Evaluated {new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Kolkata",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(result.checkedAt)}{" "}
        · re-checked on every booking and check-in
      </p>
    </section>
  );
}
