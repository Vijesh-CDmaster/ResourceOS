import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { canManage, isStaff } from "@/lib/roles";
import {
  getReadinessBoard,
  getResourceOperationalDetail,
  listConsumables,
} from "@/lib/queries/readiness";
import {
  linkConsumableAction,
  recordCalibrationAction,
  setCalibrationRequirementAction,
  unlinkConsumableAction,
} from "@/lib/actions/readiness";
import { ReadinessPanel } from "@/components/readiness-panel";
import { Badge, EmptyState, Flash, PageHeader, SectionHeading, Stat } from "@/components/ui";
import { formatDate } from "@/lib/format";

const TODAY = () => new Date().toISOString().slice(0, 10);

function stateBadge(state: "blocked" | "warnings" | "ready") {
  if (state === "blocked") return <Badge tone="red">Blocked</Badge>;
  if (state === "warnings") return <Badge tone="amber">Warnings</Badge>;
  return <Badge tone="green">Ready</Badge>;
}

export default async function ReadinessPage({
  searchParams,
}: {
  searchParams: Promise<{ resource?: string; error?: string; ok?: string }>;
}) {
  const user = await requireUser();
  const query = await searchParams;
  const staff = isStaff(user.role);
  const manager = canManage(user.role);
  const board = await getReadinessBoard(user.organizationId);
  const selectedId = query.resource && board.rows.some((row) => row.id === query.resource) ? query.resource : null;
  const detail = selectedId ? await getResourceOperationalDetail(user.organizationId, selectedId) : null;
  const catalogue = manager ? await listConsumables(user.organizationId) : [];
  const selected = board.rows.find((row) => row.id === selectedId) ?? null;

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Operational readiness"
        description="A free calendar slot is not permission to use an instrument. Every asset is checked against calibration, incidents, maintenance and required stock before it can be booked."
        actions={
          <Link href="/consumables" className="btn-secondary">
            Consumables &amp; stock
          </Link>
        }
      />

      <Flash error={query.error} ok={query.ok} />

      {!selectedId ? (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <Stat label="Blocked" value={board.counts.blocked} hint="Cannot be booked" tone="red" />
            <Stat label="Warnings" value={board.counts.warnings} hint="Bookable with conditions" tone="amber" />
            <Stat label="Ready" value={board.counts.ready} hint="All checks pass" tone="green" />
          </div>

          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
              <SectionHeading title="Every live asset" description="Blocked assets sort first." />
              <p className="text-[11px] text-muted">Re-evaluated on each page load, booking and check-in</p>
            </div>
            {board.rows.length === 0 ? (
              <EmptyState
                title="No assets to evaluate"
                description="Add a resource to the catalogue and it will appear here with its readiness verdict."
                action={<Link href="/resources" className="btn-primary">Open resources</Link>}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Readiness</th>
                      <th>Calibration</th>
                      <th>Blocking condition</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {board.rows.map((row) => {
                      const blocking = row.readiness.blocked[0] ?? null;
                      const warning = row.readiness.warnings[0] ?? null;
                      return (
                        <tr key={row.id}>
                          <td>
                            <p className="font-medium text-ink">{row.name}</p>
                            <p className="font-mono text-[11px] text-muted">
                              {row.code} · {row.category}
                            </p>
                          </td>
                          <td>{stateBadge(row.readiness.state)}</td>
                          <td className="text-[12px] text-muted">
                            {!row.requiresCalibration ? (
                              <span>Not required</span>
                            ) : row.calibrationValidUntil ? (
                              <span>Valid to {formatDate(row.calibrationValidUntil)}</span>
                            ) : (
                              <span className="text-red-700">No record</span>
                            )}
                          </td>
                          <td className="max-w-[320px] text-[12px] text-muted">
                            {blocking ? (
                              <span className="text-red-700">{blocking.title}</span>
                            ) : warning ? (
                              <span className="text-amber-700">{warning.title}</span>
                            ) : (
                              <span>—</span>
                            )}
                          </td>
                          <td className="text-right">
                            <Link href={`/readiness?resource=${row.id}`} className="btn-ghost">
                              Inspect
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : (
        <div className="space-y-5">
          <div>
            <Link href="/readiness" className="text-xs font-medium text-muted hover:text-ink">
              ← All assets
            </Link>
          </div>

          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-600">
                {selected?.code}
              </p>
              <h2 className="mt-1 text-[22px] font-semibold tracking-[-0.02em]">{selected?.name}</h2>
              <p className="mt-1 text-sm text-muted">
                {selected?.category} · {detail?.calibrationHistory.length ?? 0} calibration record
                {(detail?.calibrationHistory.length ?? 0) === 1 ? "" : "s"} ·{" "}
                {detail?.consumables.length ?? 0} consumable requirement
                {(detail?.consumables.length ?? 0) === 1 ? "" : "s"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href={`/resources/${selectedId}`} className="btn-secondary">
                Open booking page
              </Link>
              <Link href={`/capital/${selectedId}`} className="btn-secondary">
                Capital evidence
              </Link>
            </div>
          </div>

          {detail ? <ReadinessPanel result={detail.readiness} /> : null}

          <div className="grid gap-5 xl:grid-cols-2">
            <section className="card-pad">
              <SectionHeading
                title="Calibration"
                description={
                  detail?.requiresCalibration
                    ? "Required. Expired or missing calibration blocks booking and check-in."
                    : "Not required for this asset."
                }
              />

              {staff ? (
                <form action={recordCalibrationAction} className="mt-4 grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="resource_id" value={selectedId} />
                  <div>
                    <label className="label" htmlFor="performed_on">
                      Calibrated on
                    </label>
                    <input id="performed_on" name="performed_on" type="date" defaultValue={TODAY()} className="input" required />
                  </div>
                  <div>
                    <label className="label" htmlFor="valid_until">
                      Valid until
                    </label>
                    <input id="valid_until" name="valid_until" type="date" defaultValue={TODAY()} className="input" required />
                  </div>
                  <div>
                    <label className="label" htmlFor="result">
                      Result
                    </label>
                    <select id="result" name="result" className="input" defaultValue="pass">
                      <option value="pass">Pass</option>
                      <option value="conditional">Conditional</option>
                      <option value="fail">Fail</option>
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="provider">
                      Provider / technician
                    </label>
                    <input id="provider" name="provider" className="input" placeholder="Metrology cell" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label" htmlFor="certificate_ref">
                      Certificate reference
                    </label>
                    <input id="certificate_ref" name="certificate_ref" className="input" placeholder="CAL-2026-118" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label" htmlFor="notes">
                      Notes
                    </label>
                    <input id="notes" name="notes" className="input" placeholder="Optional" />
                  </div>
                  <div className="sm:col-span-2">
                    <button type="submit" className="btn-primary">
                      Record calibration
                    </button>
                  </div>
                </form>
              ) : (
                <p className="mt-3 text-sm text-muted">Ask facility staff to record a calibration result.</p>
              )}

              {manager ? (
                <form action={setCalibrationRequirementAction} className="mt-5 flex flex-wrap items-end gap-3 border-t border-line pt-4">
                  <input type="hidden" name="resource_id" value={selectedId} />
                  <label className="flex items-center gap-2 text-[13px] text-ink">
                    <input
                      type="checkbox"
                      name="requires_calibration"
                      defaultChecked={detail?.requiresCalibration ?? false}
                      className="h-4 w-4 rounded border-line"
                    />
                    Calibration required
                  </label>
                  <div>
                    <label className="label" htmlFor="calibration_interval_days">
                      Interval (days)
                    </label>
                    <input
                      id="calibration_interval_days"
                      name="calibration_interval_days"
                      type="number"
                      min="1"
                      className="input w-28"
                      placeholder="365"
                    />
                  </div>
                  <button type="submit" className="btn-secondary">
                    Save policy
                  </button>
                </form>
              ) : null}

              <div className="mt-5 border-t border-line pt-4">
                <p className="label">History</p>
                {detail && detail.calibrationHistory.length > 0 ? (
                  <ul className="space-y-2">
                    {detail.calibrationHistory.map((record) => (
                      <li key={record.id} className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
                        <span>
                          <span className="font-medium">{formatDate(record.validUntil)}</span>
                          <span className="text-muted"> · valid from {formatDate(record.performedOn)}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          {record.result === "pass" ? (
                            <Badge tone="green">pass</Badge>
                          ) : record.result === "fail" ? (
                            <Badge tone="red">fail</Badge>
                          ) : (
                            <Badge tone="amber">conditional</Badge>
                          )}
                          <span className="text-[11px] text-muted">{record.certificateRef || "no certificate ref"}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">No calibration has been recorded for this asset.</p>
                )}
              </div>
            </section>

            <section className="card-pad">
              <SectionHeading
                title="Required consumables"
                description="A mandatory item below its session quantity blocks booking."
              />

              {detail && detail.consumables.length > 0 ? (
                <ul className="mt-3 divide-y divide-line">
                  {detail.consumables.map((item) => (
                    <li key={item.linkId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                      <div>
                        <p className="text-sm font-medium">{item.name}</p>
                        <p className="text-[11px] text-muted">
                          {item.required} {item.unit} per session · {item.stock} in stock · min {item.minStock}
                          {item.mandatory ? " · mandatory" : " · optional"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {item.mandatory && item.stock < item.required ? (
                          <Badge tone="red">short</Badge>
                        ) : item.stock < item.minStock ? (
                          <Badge tone="amber">low</Badge>
                        ) : (
                          <Badge tone="green">ok</Badge>
                        )}
                        {manager ? (
                          <form action={unlinkConsumableAction}>
                            <input type="hidden" name="resource_id" value={selectedId} />
                            <input type="hidden" name="link_id" value={item.linkId} />
                            <button type="submit" className="btn-ghost">
                              Remove
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-muted">
                  No consumables are attached to this asset. Add one below if a session needs stock to start.
                </p>
              )}

              {manager ? (
                catalogue.length > 0 ? (
                  <form action={linkConsumableAction} className="mt-5 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
                    <input type="hidden" name="resource_id" value={selectedId} />
                    <div className="sm:col-span-2">
                      <label className="label" htmlFor="consumable_id">
                        Consumable
                      </label>
                      <select id="consumable_id" name="consumable_id" className="input" required>
                        <option value="">Choose an item…</option>
                        {catalogue.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} ({item.stock} {item.unit} in stock)
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label" htmlFor="qty_per_session">
                        Quantity per session
                      </label>
                      <input id="qty_per_session" name="qty_per_session" type="number" step="0.01" min="0.01" defaultValue="1" className="input" />
                    </div>
                    <label className="flex items-center gap-2 self-end pb-2 text-[13px]">
                      <input type="checkbox" name="mandatory" defaultChecked className="h-4 w-4 rounded border-line" />
                      Mandatory (blocks booking when short)
                    </label>
                    <div className="sm:col-span-2">
                      <button type="submit" className="btn-primary">
                        Attach requirement
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="mt-4 text-[13px] text-muted">
                    The consumables catalogue is empty.{" "}
                    <Link href="/consumables" className="link">
                      Add an item first
                    </Link>
                    .
                  </p>
                )
              ) : null}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
