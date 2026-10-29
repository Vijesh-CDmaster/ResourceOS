import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canManage } from "@/lib/roles";
import {
  DEFAULT_WINDOW_DAYS,
  getAssetCapitalInputs,
  getOrganizationContext,
  listDecisionsForResource,
} from "@/lib/queries/capital";
import { buildCapitalAssessment, CALCULATION_DEFINITIONS, OPTION_LABEL, type CapitalOption } from "@/lib/capital/model";
import { generateDecisionAction } from "@/lib/actions/decisions";
import { formatDate, formatMoney, formatMoneyCompact, formatPercent, timeAgo } from "@/lib/format";
import { Badge, Meter, PageHeader, SectionHeading, Stat } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

const WINDOWS = [90, 180, 365];

const CONFIDENCE_TONE: Record<string, "green" | "amber" | "red"> = {
  high: "green",
  medium: "amber",
  low: "red",
};

export default async function AssetCapitalPage({
  params,
  searchParams,
}: {
  params: Promise<{ resourceId: string }>;
  searchParams: Promise<{ window?: string; error?: string; ok?: string }>;
}) {
  const user = await requireUser();
  const { resourceId } = await params;
  const query = await searchParams;
  const windowDays = WINDOWS.includes(Number(query.window)) ? Number(query.window) : DEFAULT_WINDOW_DAYS;

  const organization = await getOrganizationContext(user.organizationId);
  if (!organization) notFound();

  const inputs = await getAssetCapitalInputs(user.organizationId, resourceId, windowDays);
  if (!inputs) notFound();

  const { evidence, alternatives, recommendation } = buildCapitalAssessment({
    ...inputs,
    windowDays,
    openHour: organization.openHour,
    closeHour: organization.closeHour,
    now: new Date(),
  });
  const decisions = await listDecisionsForResource(user.organizationId, resourceId, 5);
  const canDecide = canManage(user.role);
  const leadingScore = Math.max(...alternatives.map((option) => option.score), 0.0001);

  return (
    <div>
      <div className="mb-4">
        <Link href="/capital" className="text-xs font-medium text-muted hover:text-ink">
          ← Capital decisions
        </Link>
      </div>

      <PageHeader
        eyebrow={`${inputs.asset.category} · ${inputs.asset.departmentName ?? "unassigned department"}`}
        title={`${inputs.asset.code} — ${inputs.asset.name}`}
        description={`${inputs.asset.facilityName ?? "No facility"} · ${inputs.asset.location || "no location"} · evidence window ${windowDays} days${inputs.asset.condition ? ` · condition ${inputs.asset.condition}` : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            {WINDOWS.map((option) => (
              <Link
                key={option}
                href={`/capital/${resourceId}?window=${option}`}
                className={`btn-secondary text-xs ${option === windowDays ? "ring-2 ring-brand-300" : ""}`}
              >
                {option}d
              </Link>
            ))}
          </div>
        }
      />

      {organization.isDemo ? (
        <div className="mb-5 rounded-xl border border-violet-200 bg-violet-50 px-4 py-2.5 text-[12px] text-violet-900">
          <strong>Synthetic demo data.</strong> Asset, bookings, repairs and unmet requests here are fictional.
        </div>
      ) : null}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Utilisation"
          value={formatPercent(evidence.capacity.utilisation)}
          hint={`${Math.round(evidence.demand.usedHours)}h used / ${Math.round(evidence.capacity.availableHours)}h available`}
          tone={
            evidence.capacity.utilisation === null
              ? "slate"
              : evidence.capacity.utilisation >= 0.5
                ? "green"
                : evidence.capacity.utilisation >= 0.2
                  ? "amber"
                  : "red"
          }
        />
        <Stat
          label="Unmet demand"
          value={evidence.demand.unmetTotal}
          hint={`${evidence.demand.unmetFromOtherDepartments} from other departments`}
          tone={evidence.demand.unmetTotal > 0 ? "amber" : "slate"}
        />
        <Stat
          label="Maintenance"
          value={formatMoneyCompact(evidence.maintenance.cost)}
          hint={`${evidence.maintenance.events} event(s) · ${Math.round(evidence.maintenance.downtimeHours)}h downtime`}
          tone={evidence.maintenance.cost > 0 ? "red" : "slate"}
        />
        <Stat
          label="Replacement cost"
          value={formatMoneyCompact(evidence.facts.replacementCost)}
          hint={
            evidence.facts.replacementCostSource === "derived"
              ? "Derived from acquisition cost (no quote on file)"
              : evidence.facts.replacementCostSource === "recorded"
                ? "From a recorded replacement quote"
                : "No cost data"
          }
          tone={evidence.facts.replacementCostSource === "recorded" ? "green" : "slate"}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.25fr_1fr]">
        <div className="space-y-5">
          <section className="card-pad">
            <SectionHeading
              title="Recommendation"
              description="Generated by the rule-based comparison below. Advisory only — a person records the decision."
            />
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="violet">{OPTION_LABEL[recommendation.option]}</Badge>
              <Badge tone={CONFIDENCE_TONE[recommendation.confidence]}>{recommendation.confidence} confidence</Badge>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink/80">{recommendation.reason}</p>
            <ul className="mt-2 space-y-1">
              {recommendation.confidenceReasons.map((reason) => (
                <li key={reason} className="text-[11px] text-muted">
                  • {reason}
                </li>
              ))}
            </ul>

            {canDecide ? (
              <form action={generateDecisionAction} className="mt-4 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-end">
                <input type="hidden" name="resource_id" value={resourceId} />
                <input type="hidden" name="window_days" value={windowDays} />
                <div>
                  <label className="label" htmlFor="window_days_display">
                    Evidence window
                  </label>
                  <input
                    id="window_days_display"
                    className="input w-28"
                    value={`${windowDays} days`}
                    readOnly
                    aria-describedby="decision-note"
                  />
                </div>
                <div className="flex-1">
                  <p id="decision-note" className="text-[11px] leading-relaxed text-muted">
                    Generating stores the evidence snapshot, all five alternatives and this recommendation as a
                    persistent record. It stays <strong>pending</strong> until a human decision is recorded.
                  </p>
                </div>
                <SubmitButton className="btn-primary" pendingLabel="Generating…">
                  Generate decision record
                </SubmitButton>
              </form>
            ) : (
              <p className="mt-4 border-t border-line pt-3 text-[11px] text-muted">
                Viewing only. Only administrators and facility managers can generate a decision record.
              </p>
            )}
          </section>

          <section className="card">
            <div className="border-b border-line px-5 py-4">
              <SectionHeading
                title="Five alternatives"
                description="Score = sum of the triggered signal weights. Weights are fixed and shown, not learned."
              />
            </div>
            <ul className="divide-y divide-line">
              {alternatives.map((option) => (
                <li key={option.option} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">{option.label}</h3>
                      {option.option === recommendation.option ? <Badge tone="violet">recommended</Badge> : null}
                      {!option.applicable ? <Badge tone="slate">not costable</Badge> : null}
                    </div>
                    <p className="text-xs text-muted">score {option.score.toFixed(2)}</p>
                  </div>
                  <div className="mt-2">
                    <Meter
                      value={(option.score / leadingScore) * 100}
                      tone={option.option === recommendation.option ? "violet" : "slate"}
                    />
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-ink/75">{option.summary}</p>

                  <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-muted">
                    <div>
                      <dt className="inline">Cost now: </dt>
                      <dd className="inline font-medium text-ink/80">{option.costNow === null ? "—" : formatMoney(option.costNow)}</dd>
                    </div>
                    <div>
                      <dt className="inline">Per year: </dt>
                      <dd className="inline font-medium text-ink/80">{option.annualCost === null ? "—" : formatMoney(option.annualCost)}</dd>
                    </div>
                    <div>
                      <dt className="inline">Per used hour: </dt>
                      <dd className="inline font-medium text-ink/80">
                        {option.costPerUsedHour === null ? "—" : formatMoney(option.costPerUsedHour)}
                      </dd>
                    </div>
                  </dl>

                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] font-medium text-brand-700">
                      Evidence and gaps ({option.supportingEvidence.length} supporting, {option.missingEvidence.length} missing)
                    </summary>
                    <div className="mt-2 space-y-2">
                      <ul className="space-y-1">
                        {option.signals.map((signal) => (
                          <li key={signal.label} className="flex items-start gap-2 text-[11px]">
                            <span
                              className={`mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                                signal.triggered ? "bg-emerald-500" : "bg-slate-300"
                              }`}
                            />
                            <span className={signal.triggered ? "text-ink/80" : "text-muted"}>
                              <strong className="font-medium">{signal.label}</strong> ({signal.weight.toFixed(2)}) —{" "}
                              {signal.detail}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {option.missingEvidence.length > 0 ? (
                        <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-800">Missing evidence</p>
                          <ul className="mt-1 space-y-0.5">
                            {option.missingEvidence.map((item) => (
                              <li key={item} className="text-[11px] text-amber-900">
                                • {item}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {option.caveats.length > 0 ? (
                        <ul className="space-y-0.5">
                          {option.caveats.map((caveat) => (
                            <li key={caveat} className="text-[11px] text-muted">
                              Not modelled: {caveat}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <div className="border-b border-line px-5 py-4">
              <SectionHeading title="Decision records for this asset" description="Previous recommendations and what a human decided." />
            </div>
            {decisions.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted">No decision record has been generated for this asset yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {decisions.map((decision) => (
                  <li key={decision.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div>
                      <Link href={`/capital/decisions/${decision.id}`} className="text-sm font-medium hover:underline">
                        {formatDate(decision.createdAt)} · recommended {OPTION_LABEL[decision.recommendedOption as CapitalOption]}
                      </Link>
                      <p className="text-[11px] text-muted">
                        {decision.createdByName ? `by ${decision.createdByName}` : "unknown author"} · {timeAgo(decision.createdAt)}
                        {decision.decisionOption
                          ? ` · decided ${OPTION_LABEL[decision.decisionOption as CapitalOption]}`
                          : " · awaiting decision"}
                      </p>
                    </div>
                    <Badge tone={decision.status === "decided" ? "green" : "amber"}>{decision.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="space-y-5">
          <section className="card-pad">
            <SectionHeading title="Lifecycle facts" description="From the asset record; blank means not recorded." />
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {[
                ["Acquired", evidence.facts.ageYears === null ? inputs.asset.acquiredAt ?? "not recorded" : `${Math.round(evidence.facts.ageYears * 10) / 10} years ago`],
                ["Acquisition cost", formatMoney(evidence.facts.acquisitionCost)],
                ["Replacement cost", formatMoney(evidence.facts.replacementCost)],
                ["Expected life", inputs.asset.expectedLifeYears === null ? "not recorded" : `${inputs.asset.expectedLifeYears} years`],
                ["Remaining life", evidence.facts.remainingLifeYears === null ? "unknown" : `${evidence.facts.remainingLifeYears} years`],
                ["Warranty", evidence.facts.warrantyActive === null ? "unknown" : evidence.facts.warrantyActive ? "active" : "expired"],
                ["Condition", evidence.facts.condition ?? "not recorded"],
                ["Status", evidence.facts.status],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
                  <dd className="text-sm font-medium text-ink/85">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="card-pad">
            <SectionHeading title="Demand in the window" />
            <dl className="mt-2 space-y-1.5 text-sm">
              {[
                ["Bookings recorded", evidence.demand.bookings],
                ["Completed", evidence.demand.completed],
                ["No-shows", evidence.demand.noShows],
                ["No-show rate", formatPercent(evidence.demand.noShowRate)],
                ["Cancelled / rejected", `${evidence.demand.cancelled} / ${evidence.demand.rejected}`],
                ["Booked hours", `${Math.round(evidence.demand.bookedHours)}h`],
                ["Actual usage hours", `${Math.round(evidence.demand.usedHours)}h`],
                ["Completed without a session", evidence.demand.completedWithoutSession],
                ["Unmet requests", evidence.demand.unmetTotal],
              ].map(([label, value]) => (
                <div key={label as string} className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="text-sm font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            {Object.keys(evidence.demand.unmetByReason).length > 0 ? (
              <p className="mt-2 text-[11px] text-muted">
                Unmet reasons:{" "}
                {Object.entries(evidence.demand.unmetByReason)
                  .map(([reason, count]) => `${reason.replace("_", " ")} ${count}`)
                  .join(" · ")}
              </p>
            ) : null}
          </section>

          <section className="card-pad">
            <SectionHeading title="Maintenance and reliability" />
            <dl className="mt-2 space-y-1.5 text-sm">
              {[
                ["Events in window", evidence.maintenance.events],
                ["Resolved repairs", evidence.maintenance.resolved],
                ["Verified work orders", evidence.maintenance.verifiedRepairs],
                ["Repair spend", formatMoney(evidence.maintenance.cost)],
                ["of which actual", formatMoney(evidence.maintenance.actualCost)],
                ["of which estimated", formatMoney(evidence.maintenance.estimatedCost)],
                ["Downtime hours", `${Math.round(evidence.maintenance.downtimeHours)}h`],
                ["Repair estimate", evidence.maintenance.repairEstimate === null ? "unknown (no resolved repair)" : formatMoney(evidence.maintenance.repairEstimate)],
                ["Cost per used hour", evidence.maintenance.costPerUsedHour === null ? "—" : formatMoney(evidence.maintenance.costPerUsedHour)],
                ["Open incidents", evidence.risk.openIncidents],
                ["Downtime share", formatPercent(evidence.risk.downtimeShare)],
              ].map(([label, value]) => (
                <div key={label as string} className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="text-sm font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            {evidence.maintenance.topFaults.length > 0 ? (
              <ul className="mt-2 space-y-0.5">
                {evidence.maintenance.topFaults.map((fault) => (
                  <li key={fault.category} className="text-[11px] text-muted">
                    {fault.category}: {fault.count} event(s), {formatMoney(fault.cost)}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="card-pad">
            <SectionHeading title="Data coverage" description="What the calculation actually had to work with." />
            <ul className="mt-1 space-y-1 text-[11px] text-muted">
              <li>Bookings in window: {evidence.coverage.bookings}</li>
              <li>Usage sessions: {evidence.coverage.sessions}</li>
              <li>Maintenance records: {evidence.coverage.maintenanceRecords}</li>
              <li>Unmet-demand events: {evidence.coverage.unmetDemandEvents}</li>
              <li>Comparable assets in category: {evidence.peers.compared}</li>
              <li>Recorded cost / replacement / life / condition: {[
                evidence.coverage.hasAcquisitionCost ? "cost" : null,
                evidence.coverage.hasReplacementCost ? "quote" : null,
                evidence.coverage.hasLifeExpectancy ? "life" : null,
                evidence.coverage.hasCondition ? "condition" : null,
              ].filter(Boolean).join(", ") || "none"}</li>
            </ul>
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-800">Missing or weak evidence</p>
              <ul className="mt-1 space-y-1">
                {evidence.missingData.map((item) => (
                  <li key={item} className="text-[11px] leading-relaxed text-amber-900">
                    • {item}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="card-pad">
            <SectionHeading title="Where the numbers come from" />
            <dl className="space-y-2">
              {CALCULATION_DEFINITIONS.slice(0, 6).map((definition) => (
                <div key={definition.label}>
                  <dt className="text-[11px] font-semibold text-ink">{definition.label}</dt>
                  <dd className="text-[11px] leading-relaxed text-muted">{definition.definition}</dd>
                </div>
              ))}
            </dl>
            <Link href="/capital" className="mt-2 inline-block text-[11px] font-medium text-brand-700 hover:underline">
              All definitions →
            </Link>
          </section>
        </div>
      </div>

      {!canDecide ? (
        <p className="mt-4 text-[11px] text-muted">
          Signed in as {user.name}. Capital decisions require an administrator or facility manager.
        </p>
      ) : null}
    </div>
  );
}
