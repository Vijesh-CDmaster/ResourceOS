// Capital decision model.
//
// Pure functions: given rows from the database, produce the evidence snapshot,
// the five alternative assessments and a recommendation. No I/O, no clock reads
// beyond the supplied `now`, so every figure can be unit-tested and every number
// on screen is traceable to records.
//
// This is a transparent rule-based comparison, not a forecast. It never claims
// guaranteed savings and it never makes the decision — an authorised human does.

export type CapitalOption = "buy_new" | "repair" | "share" | "reallocate" | "retire";

export const OPTION_ORDER: CapitalOption[] = ["buy_new", "repair", "share", "reallocate", "retire"];

export const OPTION_LABEL: Record<CapitalOption, string> = {
  buy_new: "Buy new equipment",
  repair: "Repair existing equipment",
  share: "Share across departments",
  reallocate: "Reallocate existing equipment",
  retire: "Retire equipment",
};

/** Default planning assumptions. Every one is shown in the UI and stored with the record. */
export const DEFAULT_ASSUMPTIONS = {
  /** Replacement cost is assumed to be this multiple of the recorded acquisition cost when no replacement quote exists. */
  replacementCostMultiplier: 1.15,
  /** A repair is considered economically comparable to replacement above this share of replacement cost. */
  repairVsReplacementThreshold: 0.5,
  /** Utilisation below this share is treated as under-used. */
  lowUtilisationThreshold: 0.35,
  /** Utilisation below this share is treated as negligible. */
  negligibleUtilisationThreshold: 0.1,
  /** Downtime above this share of available hours is treated as a reliability problem. */
  downtimeShareThreshold: 0.1,
  /** Minimum unmet-demand requests from other departments before sharing is suggested. */
  shareDemandThreshold: 3,
  /** Minimum usage hours before any recommendation is treated as well supported. */
  minimumEvidenceHours: 10,
  /** Below this window, seasonal effects dominate and confidence is capped. */
  minimumWindowDays: 30,
} as const;

export type Assumptions = typeof DEFAULT_ASSUMPTIONS;

export type AssetFacts = {
  id: string;
  code: string;
  name: string;
  category: string;
  status: string;
  condition: string | null;
  departmentId: string | null;
  departmentName: string | null;
  facilityName: string | null;
  location: string;
  acquiredAt: string | null;
  acquisitionCost: number | null;
  replacementCost: number | null;
  warrantyExpiresAt: string | null;
  expectedLifeYears: number | null;
};

export type BookingFact = {
  status: string;
  startsAt: string;
  endsAt: string;
  userId: string;
  departmentId: string | null;
};

export type UsageFact = { hours: number };

export type UnmetFact = {
  reason: string;
  departmentId: string | null;
  departmentName: string | null;
};

export type MaintenanceFact = {
  title: string;
  faultCategory: string | null;
  cost: number;
  downtimeHours: number;
  status: string;
  resolvedAt: string | null;
  scheduledStart: string | null;
};

/** Another asset in the same category, used for sharing/reallocation comparisons. */
export type PeerFact = {
  id: string;
  code: string;
  departmentId: string | null;
  departmentName: string | null;
  usedHours: number;
  unmetCount: number;
};

export type EvidenceInput = {
  asset: AssetFacts;
  bookings: BookingFact[];
  sessions: UsageFact[];
  unmet: UnmetFact[];
  maintenance: MaintenanceFact[];
  peers: PeerFact[];
  openIncidents: number;
  windowDays: number;
  /** Organisation operating window, used to derive available hours. */
  openHour: number;
  closeHour: number;
  now: Date;
  assumptions?: Assumptions;
};

export type Evidence = {
  assetId: string;
  assetCode: string;
  assetName: string;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  departmentName: string | null;
  facts: {
    ageYears: number | null;
    remainingLifeYears: number | null;
    acquisitionCost: number | null;
    replacementCost: number | null;
    replacementCostSource: "recorded" | "derived" | "unknown";
    warrantyActive: boolean | null;
    condition: string | null;
    status: string;
  };
  demand: {
    bookings: number;
    requested: number;
    confirmed: number;
    completed: number;
    cancelled: number;
    rejected: number;
    noShows: number;
    noShowRate: number | null;
    bookedHours: number;
    usedHours: number;
    sessionsRecorded: number;
    completedWithoutSession: number;
    unmetTotal: number;
    unmetByReason: Record<string, number>;
    unmetFromOtherDepartments: number;
  };
  capacity: {
    dailyOpenHours: number;
    grossAvailableHours: number;
    downtimeHours: number;
    availableHours: number;
    utilisation: number | null;
    bookedUtilisation: number | null;
  };
  maintenance: {
    events: number;
    resolved: number;
    cost: number;
    downtimeHours: number;
    costPerUsedHour: number | null;
    repairEstimate: number | null;
    recurringFaults: boolean;
    topFaults: Array<{ category: string; count: number; cost: number }>;
  };
  risk: {
    openIncidents: number;
    downtimeShare: number | null;
    repairToReplacementShare: number | null;
  };
  peers: {
    compared: number;
    underusedPeers: number;
    busyPeers: number;
    otherDepartmentDemand: number;
  };
  coverage: {
    bookings: number;
    maintenanceRecords: number;
    sessions: number;
    unmetDemandEvents: number;
    hasAcquisitionCost: boolean;
    hasReplacementCost: boolean;
    hasLifeExpectancy: boolean;
    hasCondition: boolean;
  };
  missingData: string[];
};

export type Signal = { label: string; detail: string; weight: number; triggered: boolean };

export type OptionAssessment = {
  option: CapitalOption;
  label: string;
  score: number;
  applicable: boolean;
  summary: string;
  costNow: number | null;
  annualCost: number | null;
  costPerUsedHour: number | null;
  signals: Signal[];
  supportingEvidence: string[];
  missingEvidence: string[];
  caveats: string[];
};

export type Recommendation = {
  option: CapitalOption;
  label: string;
  reason: string;
  confidence: "low" | "medium" | "high";
  confidenceReasons: string[];
};

const round = (value: number, places = 2): number => {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function yearsBetween(from: string | Date, to: Date): number {
  const start = new Date(from);
  if (Number.isNaN(start.getTime())) return 0;
  return (to.getTime() - start.getTime()) / (365.25 * 24 * 3600_000);
}

function hoursBetween(start: string, end: string): number {
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return (to - from) / 3600_000;
}

/** Computes the evidence snapshot. Every field is derived from the supplied rows. */
export function computeEvidence(input: EvidenceInput): Evidence {
  const assumptions = input.assumptions ?? DEFAULT_ASSUMPTIONS;
  const { asset, now, windowDays } = input;

  const windowStart = new Date(now.getTime() - windowDays * 24 * 3600_000);
  const wantPaid = asset.acquisitionCost ?? null;
  const replacementRecorded = asset.replacementCost ?? null;
  const replacementCost =
    replacementRecorded ?? (wantPaid !== null ? round(wantPaid * assumptions.replacementCostMultiplier) : null);
  const replacementCostSource: Evidence["facts"]["replacementCostSource"] =
    replacementRecorded !== null ? "recorded" : replacementCost !== null ? "derived" : "unknown";

  const ageYears = asset.acquiredAt ? round(yearsBetween(asset.acquiredAt, now), 2) : null;
  const remainingLifeYears =
    ageYears !== null && asset.expectedLifeYears !== null ? round(asset.expectedLifeYears - ageYears, 2) : null;
  const warrantyActive = asset.warrantyExpiresAt ? new Date(asset.warrantyExpiresAt) > now : null;

  const byStatus = (status: string) => input.bookings.filter((booking) => booking.status === status);
  const bookedStatuses = new Set(["confirmed", "completed", "no_show"]);
  const bookedHours = input.bookings
    .filter((booking) => bookedStatuses.has(booking.status))
    .reduce((total, booking) => total + hoursBetween(booking.startsAt, booking.endsAt), 0);
  const usedHours = input.sessions.reduce((total, session) => total + Math.max(0, session.hours), 0);
  const completed = byStatus("completed").length;
  const sessionsRecorded = input.sessions.length;
  const completedWithoutSession = Math.max(0, completed - sessionsRecorded);
  const noShows = byStatus("no_show").length;
  const noShowBase = completed + noShows;

  const dailyOpenHours = Math.max(0, input.closeHour - input.openHour);
  const grossAvailableHours = dailyOpenHours * windowDays;
  const downtimeHours = input.maintenance.reduce((total, record) => total + Math.max(0, record.downtimeHours), 0);
  const availableHours = Math.max(0, grossAvailableHours - downtimeHours);

  const maintenanceCost = input.maintenance.reduce((total, record) => total + Math.max(0, record.cost), 0);
  const resolvedMaintenance = input.maintenance.filter((record) => record.status === "resolved");
  const meanResolvedCost =
    resolvedMaintenance.length > 0
      ? resolvedMaintenance.reduce((total, record) => total + record.cost, 0) / resolvedMaintenance.length
      : null;
  const lastResolvedCost = resolvedMaintenance
    .slice()
    .sort((a, b) => String(b.resolvedAt ?? "").localeCompare(String(a.resolvedAt ?? "")))[0]?.cost ?? null;
  // Repair hypothesis: the mean historical repair plus 15% contingency, and never
  // less than the most recent repair. Both inputs are shown to the reviewer.
  const repairEstimate =
    meanResolvedCost === null && lastResolvedCost === null
      ? null
      : round(Math.max((meanResolvedCost ?? 0) * 1.15, lastResolvedCost ?? 0));

  const faultTotals = new Map<string, { count: number; cost: number }>();
  for (const record of input.maintenance) {
    const key = record.faultCategory?.trim() || "Uncategorised";
    const current = faultTotals.get(key) ?? { count: 0, cost: 0 };
    faultTotals.set(key, { count: current.count + 1, cost: current.cost + record.cost });
  }
  const topFaults = [...faultTotals.entries()]
    .map(([category, value]) => ({ category, count: value.count, cost: round(value.cost) }))
    .sort((a, b) => b.count - a.count || b.cost - a.cost)
    .slice(0, 3);

  const unmetByReason: Record<string, number> = {};
  for (const event of input.unmet) {
    unmetByReason[event.reason] = (unmetByReason[event.reason] ?? 0) + 1;
  }
  const unmetFromOtherDepartments = input.unmet.filter(
    (event) => event.departmentId !== null && event.departmentId !== asset.departmentId,
  ).length;

  const utilisation = availableHours > 0 ? round(usedHours / availableHours, 4) : null;
  const bookedUtilisation = availableHours > 0 ? round(bookedHours / availableHours, 4) : null;

  const underusedPeers = input.peers.filter(
    (peer) => peer.id !== asset.id && peer.usedHours <= 0 && peer.unmetCount >= 0,
  ).length;
  const busyPeers = input.peers.filter((peer) => peer.id !== asset.id && peer.usedHours > 0).length;
  const otherDepartmentDemand = input.peers
    .filter((peer) => peer.id !== asset.id && peer.departmentId !== asset.departmentId)
    .reduce((total, peer) => total + peer.unmetCount, 0);

  const missingData: string[] = [];
  if (asset.acquisitionCost === null) missingData.push("Acquisition cost is not recorded, so value and depreciation cannot be assessed.");
  if (replacementRecorded === null && replacementCost !== null)
    missingData.push("No replacement quote is recorded; replacement cost is estimated from acquisition cost with a 15% escalation factor.");
  if (replacementCost === null) missingData.push("No replacement cost or acquisition cost, so buy-new costs cannot be compared.");
  if (asset.expectedLifeYears === null) missingData.push("Expected useful life is not recorded, so remaining life is unknown.");
  if (asset.acquiredAt === null) missingData.push("Purchase date is not recorded, so asset age is unknown.");
  if (asset.condition === null) missingData.push("Condition is not recorded, so physical degradation cannot be weighed.");
  if (input.maintenance.length === 0) missingData.push("No maintenance history in the window, so repair cost is unknown rather than zero.");
  if (sessionsRecorded < completed)
    missingData.push(
      `${completedWithoutSession} completed booking(s) have no usage session, so actual run time is understated and utilisation is a floor.`,
    );
  if (input.unmet.length === 0)
    missingData.push("No unmet-demand events in the window; this may mean no suppressed demand, or that requests were never attempted.");
  missingData.push(
    "Available hours assume every calendar day is operable at full opening hours; weekends and holidays are not excluded in this version.",
  );

  return {
    assetId: asset.id,
    assetCode: asset.code,
    assetName: asset.name,
    windowDays,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    departmentName: asset.departmentName,
    facts: {
      ageYears,
      remainingLifeYears,
      acquisitionCost: wantPaid,
      replacementCost,
      replacementCostSource,
      warrantyActive,
      condition: asset.condition,
      status: asset.status,
    },
    demand: {
      bookings: input.bookings.length,
      requested: byStatus("requested").length,
      confirmed: byStatus("confirmed").length,
      completed,
      cancelled: byStatus("cancelled").length,
      rejected: byStatus("rejected").length,
      noShows,
      noShowRate: noShowBase > 0 ? round(noShows / noShowBase, 4) : null,
      bookedHours: round(bookedHours),
      usedHours: round(usedHours),
      sessionsRecorded,
      completedWithoutSession,
      unmetTotal: input.unmet.length,
      unmetByReason,
      unmetFromOtherDepartments,
    },
    capacity: {
      dailyOpenHours,
      grossAvailableHours: round(grossAvailableHours),
      downtimeHours: round(downtimeHours),
      availableHours: round(availableHours),
      utilisation,
      bookedUtilisation,
    },
    maintenance: {
      events: input.maintenance.length,
      resolved: resolvedMaintenance.length,
      cost: round(maintenanceCost),
      downtimeHours: round(downtimeHours),
      costPerUsedHour: usedHours > 0 ? round(maintenanceCost / usedHours) : null,
      repairEstimate,
      recurringFaults: input.maintenance.length >= 3,
      topFaults,
    },
    risk: {
      openIncidents: input.openIncidents,
      downtimeShare: grossAvailableHours > 0 ? round(downtimeHours / grossAvailableHours, 4) : null,
      repairToReplacementShare:
        repairEstimate !== null && replacementCost !== null && replacementCost > 0
          ? round(repairEstimate / replacementCost, 4)
          : null,
    },
    peers: {
      compared: input.peers.filter((peer) => peer.id !== asset.id).length,
      underusedPeers,
      busyPeers,
      otherDepartmentDemand,
    },
    coverage: {
      bookings: input.bookings.length,
      maintenanceRecords: input.maintenance.length,
      sessions: sessionsRecorded,
      unmetDemandEvents: input.unmet.length,
      hasAcquisitionCost: asset.acquisitionCost !== null,
      hasReplacementCost: replacementRecorded !== null,
      hasLifeExpectancy: asset.expectedLifeYears !== null,
      hasCondition: asset.condition !== null,
    },
    missingData,
  };
}

const pct = (value: number | null): string => (value === null ? "unknown" : `${round(value * 100, 1)}%`);
const money = (value: number | null): string => (value === null ? "unknown" : `₹${round(value, 0).toLocaleString("en-IN")}`);

/**
 * Assesses the five alternatives. Signals are explicit and weighted; the score is
 * the sum of triggered weights, so the UI can show exactly why an option scored
 * the way it did.
 */
export function assessOptions(evidence: Evidence, assumptions: Assumptions = DEFAULT_ASSUMPTIONS): OptionAssessment[] {
  const utilisation = evidence.capacity.utilisation;
  const usedHours = evidence.demand.usedHours;
  const replacement = evidence.facts.replacementCost;
  const repairEstimate = evidence.maintenance.repairEstimate;
  const downtimeShare = evidence.risk.downtimeShare;
  const remainingLife = evidence.facts.remainingLifeYears;
  const windowYears = evidence.windowDays / 365;
  const annualUsedHours = windowYears > 0 ? usedHours / windowYears : usedHours;

  const signal = (label: string, detail: string, weight: number, triggered: boolean): Signal => ({
    label,
    detail,
    weight,
    triggered,
  });

  const scoreOf = (signals: Signal[]): number => round(signals.filter((s) => s.triggered).reduce((t, s) => t + s.weight, 0), 3);

  const buySignals = [
    signal(
      "Repair is a large share of replacement",
      `Repair estimate ${money(repairEstimate)} vs replacement ${money(replacement)}`,
      0.35,
      repairEstimate !== null && replacement !== null && replacement > 0
        ? repairEstimate / replacement >= assumptions.repairVsReplacementThreshold
        : false,
    ),
    signal(
      "Beyond or near end of useful life",
      `Remaining life ${remainingLife === null ? "unknown" : `${remainingLife} years`}`,
      0.25,
      remainingLife !== null && remainingLife <= 1,
    ),
    signal(
      "Demand supports a replacement",
      `Utilisation ${pct(utilisation)} of available hours`,
      0.2,
      utilisation !== null && utilisation >= 0.6,
    ),
    signal(
      "Reliability problems absorb capacity",
      `Downtime ${pct(downtimeShare)} of gross hours`,
      0.2,
      downtimeShare !== null && downtimeShare >= assumptions.downtimeShareThreshold,
    ),
    signal(
      "Faults are recurring",
      `${evidence.maintenance.events} maintenance event(s) in the window`,
      0.15,
      evidence.maintenance.events >= 3,
    ),
  ];

  const repairSignals = [
    signal(
      "Repair is affordable relative to replacement",
      `Repair estimate ${money(repairEstimate)} vs replacement ${money(replacement)}`,
      0.4,
      repairEstimate !== null && replacement !== null && replacement > 0
        ? repairEstimate / replacement < assumptions.repairVsReplacementThreshold
        : false,
    ),
    signal(
      "Useful life remains",
      `Remaining life ${remainingLife === null ? "unknown" : `${remainingLife} years`}`,
      0.3,
      remainingLife !== null && remainingLife > 1,
    ),
    signal(
      "Asset is in active use",
      `Utilisation ${pct(utilisation)}`,
      0.2,
      utilisation !== null && utilisation >= 0.3,
    ),
    signal(
      "Faults are not yet chronic",
      `${evidence.maintenance.events} maintenance event(s) in the window`,
      0.1,
      evidence.maintenance.events <= 2,
    ),
  ];

  const shareSignals = [
    signal(
      "Asset is under-used by its owner",
      `Utilisation ${pct(utilisation)}`,
      0.4,
      utilisation !== null && utilisation < assumptions.lowUtilisationThreshold,
    ),
    signal(
      "Other departments record unmet demand",
      `${evidence.demand.unmetFromOtherDepartments} request(s) from other departments`,
      0.3,
      evidence.demand.unmetFromOtherDepartments >= assumptions.shareDemandThreshold,
    ),
    signal(
      "Condition supports continued use",
      `Condition ${evidence.facts.condition ?? "not recorded"}`,
      0.2,
      evidence.facts.condition === "excellent" || evidence.facts.condition === "good",
    ),
    signal(
      "Comparable assets exist nearby",
      `${evidence.peers.compared} comparable asset(s) in this category`,
      0.1,
      evidence.peers.compared > 0,
    ),
  ];

  const reallocateSignals = [
    signal(
      "Owner barely uses the asset",
      `Utilisation ${pct(utilisation)}`,
      0.35,
      utilisation !== null && utilisation < 0.2,
    ),
    signal(
      "Another department has demand without supply",
      `${evidence.demand.unmetFromOtherDepartments} unmet request(s) from other departments, ${evidence.peers.busyPeers} busier peer(s)`,
      0.35,
      evidence.demand.unmetFromOtherDepartments > 0 && evidence.peers.busyPeers > 0,
    ),
    signal(
      "Asset is in usable condition",
      `Status ${evidence.facts.status}, condition ${evidence.facts.condition ?? "not recorded"}`,
      0.2,
      evidence.facts.status === "ready" && evidence.facts.condition !== "poor",
    ),
    signal(
      "No single department depends on it",
      `Booked utilisation ${pct(evidence.capacity.bookedUtilisation)}`,
      0.1,
      (evidence.capacity.bookedUtilisation ?? 1) < 0.3,
    ),
  ];

  const retireSignals = [
    signal(
      "End of useful life reached",
      `Remaining life ${remainingLife === null ? "unknown" : `${remainingLife} years`}`,
      0.35,
      remainingLife !== null && remainingLife <= 0,
    ),
    signal("Poor physical condition", `Condition ${evidence.facts.condition ?? "not recorded"}`, 0.25, evidence.facts.condition === "poor"),
    signal(
      "Negligible demand",
      `Utilisation ${pct(utilisation)}`,
      0.25,
      utilisation !== null && utilisation < assumptions.negligibleUtilisationThreshold,
    ),
    signal(
      "Repair is uneconomic",
      `Repair ${money(repairEstimate)} vs replacement ${money(replacement)}`,
      0.15,
      repairEstimate !== null && replacement !== null && replacement > 0
        ? repairEstimate / replacement >= 0.7
        : false,
    ),
  ];

  const annualised = (total: number | null): number | null =>
    total === null || windowYears <= 0 ? null : round(total / windowYears, 0);

  const perHour = (annual: number | null): number | null =>
    annual === null || annualUsedHours <= 0 ? null : round(annual / annualUsedHours, 0);

  const buyAnnualised = replacement !== null && evidence.facts.remainingLifeYears && evidence.facts.remainingLifeYears > 0
    ? round(replacement / evidence.facts.remainingLifeYears, 0)
    : replacement !== null
      ? round(replacement / 5, 0)
      : null;

  const build = (
    option: CapitalOption,
    signals: Signal[],
    extra: Partial<OptionAssessment> & { summary: string; missingEvidence: string[] },
  ): OptionAssessment => ({
    option,
    label: OPTION_LABEL[option],
    score: scoreOf(signals),
    applicable: extra.applicable ?? true,
    costNow: extra.costNow ?? null,
    annualCost: extra.annualCost ?? null,
    costPerUsedHour: extra.costPerUsedHour ?? null,
    signals,
    supportingEvidence: signals.filter((s) => s.triggered).map((s) => `${s.label} — ${s.detail}`),
    missingEvidence: extra.missingEvidence,
    caveats: extra.caveats ?? [],
    summary: extra.summary,
  });

  return [
    build("buy_new", buySignals, {
      summary:
        replacement === null
          ? "A replacement has no known price, so this option cannot be costed."
          : `Replacing costs about ${money(replacement)} now; spread over the expected life that is roughly ${money(buyAnnualised)} per year, or ${money(perHour(buyAnnualised))} per used hour.`,
      applicable: replacement !== null,
      costNow: replacement,
      annualCost: buyAnnualised,
      costPerUsedHour: perHour(buyAnnualised),
      missingEvidence: [
        ...(evidence.facts.replacementCostSource === "derived" ? ["Replacement cost is derived from the purchase price, not a current quote."] : []),
        ...(repairEstimate === null ? ["No repair history, so the comparison against repair cost is one-sided."] : []),
      ],
      caveats: ["Installation, commissioning, training and disposal costs are not included."],
    }),
    build("repair", repairSignals, {
      summary:
        repairEstimate === null
          ? "No resolved maintenance event in the window, so a repair cost cannot be estimated."
          : `A repair is estimated at ${money(repairEstimate)} (mean historical repair +15%, floor of the last repair). That is ${pct(evidence.risk.repairToReplacementShare)} of replacement cost.`,
      applicable: repairEstimate !== null,
      costNow: repairEstimate,
      annualCost: annualised(repairEstimate),
      costPerUsedHour: perHour(annualised(repairEstimate)),
      missingEvidence: [
        ...(evidence.maintenance.resolved === 0 ? ["No resolved repair in the window; the estimate is not evidence-based."] : []),
        ...(evidence.facts.warrantyActive === null ? ["Warranty status is unknown; a covered repair may cost nothing."] : []),
      ],
      caveats: ["Repair estimates exclude downtime during the repair and repeat-failure risk."],
    }),
    build("share", shareSignals, {
      summary:
        utilisation === null
          ? "Utilisation cannot be computed, so a sharing case cannot be made."
          : `Sharing leaves the asset where it is and opens it to other departments. Current utilisation is ${pct(utilisation)} with ${evidence.demand.unmetFromOtherDepartments} unmet request(s) from other departments.`,
      applicable: utilisation !== null,
      costNow: 0,
      annualCost: 0,
      costPerUsedHour: evidence.maintenance.costPerUsedHour === null ? null : round(evidence.maintenance.costPerUsedHour, 0),
      missingEvidence: [
        ...(evidence.demand.unmetTotal === 0 ? ["No unmet-demand records; sharing may be solving a problem nobody logged."] : []),
        ...(evidence.facts.condition === null ? ["Condition is unrecorded, so suitability for wider use is unverified."] : []),
      ],
      caveats: [
        "Costs of training, access control and inter-department charging are not modelled.",
        "Cross-institution sharing is not implemented in ResourceOS.",
      ],
    }),
    build("reallocate", reallocateSignals, {
      summary:
        utilisation === null
          ? "Utilisation cannot be computed, so a reallocation case cannot be made."
          : `Moving the asset to another department transfers ${pct(utilisation)} utilisation and ${evidence.demand.unmetFromOtherDepartments} external unmet request(s). No purchase is required.`,
      applicable: utilisation !== null,
      costNow: 0,
      annualCost: 0,
      costPerUsedHour: null,
      missingEvidence: [
        ...(evidence.peers.compared === 0 ? ["No comparable assets to compare departmental demand against."] : []),
        ...(evidence.peers.busyPeers === 0 ? ["No peer asset is measurably busier."] : []),
      ],
      caveats: ["Relocation, recalibration and re-validation costs are not modelled."],
    }),
    build("retire", retireSignals, {
      summary:
        evidence.facts.remainingLifeYears === null
          ? "Remaining life is unknown, so retirement cannot be justified on age alone."
          : `Retiring ends maintenance spend (${money(evidence.maintenance.cost)} in the window) and downtime (${evidence.maintenance.downtimeHours}h), and removes the asset from service. Remaining life is ${evidence.facts.remainingLifeYears} years.`,
      applicable: true,
      costNow: 0,
      annualCost: 0,
      costPerUsedHour: null,
      missingEvidence: [
        ...(evidence.facts.condition === null ? ["Condition is unrecorded; physical state was not considered."] : []),
        ...(utilisation === null ? ["Utilisation is unknown, so loss of service cannot be sized."] : []),
      ],
      caveats: ["Residual value, disposal cost and replacement of lost capacity are not included."],
    }),
  ];
}

const PRIORITY: CapitalOption[] = ["repair", "share", "reallocate", "buy_new", "retire"];

/**
 * Picks the highest-scoring applicable alternative (ties broken by the least
 * disruptive option) and explains the choice. Confidence reflects the quality of
 * the evidence, never the size of the claimed saving.
 */
export function recommendOption(
  evidence: Evidence,
  assessments: OptionAssessment[],
  assumptions: Assumptions = DEFAULT_ASSUMPTIONS,
): Recommendation {
  const applicable = assessments.filter((assessment) => assessment.applicable);
  const ranked = [...applicable].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return PRIORITY.indexOf(a.option) - PRIORITY.indexOf(b.option);
  });
  const best = ranked[0] ?? assessments.find((assessment) => assessment.option === "repair")!;

  const confidenceReasons: string[] = [];
  let confidence: Recommendation["confidence"] = "medium";

  if (evidence.demand.usedHours < assumptions.minimumEvidenceHours) {
    confidence = "low";
    confidenceReasons.push(`Only ${evidence.demand.usedHours}h of recorded usage; below the ${assumptions.minimumEvidenceHours}h minimum for a confident comparison.`);
  } else if (evidence.windowDays < assumptions.minimumWindowDays) {
    confidence = "low";
    confidenceReasons.push(`Window is ${evidence.windowDays} days; seasonal effects are not represented.`);
  }

  if (best.missingEvidence.length > 0) {
    confidence = confidence === "low" ? "low" : "medium";
    confidenceReasons.push(`${best.missingEvidence.length} piece of evidence is missing for this option.`);
  }

  if (
    confidence !== "low" &&
    evidence.demand.usedHours >= assumptions.minimumEvidenceHours &&
    evidence.demand.sessionsRecorded > 0 &&
    evidence.facts.acquisitionCost !== null &&
    evidence.facts.remainingLifeYears !== null &&
    best.score >= 0.6
  ) {
    confidence = "high";
    confidenceReasons.push("Usage sessions, cost and life expectancy are all recorded, and the leading option scored strongly.");
  }

  if (confidenceReasons.length === 0) {
    confidenceReasons.push("Evidence is complete enough to compare options, but this is a rule-based ranking, not a forecast.");
  }

  const runnerUp = ranked[1];
  const margin = runnerUp ? round(best.score - runnerUp.score, 2) : best.score;

  const reason = [
    `${best.label} scored ${best.score.toFixed(2)} against ${ranked
      .slice(1)
      .map((assessment) => `${assessment.label} ${assessment.score.toFixed(2)}`)
      .join(", ") || "no other applicable option"}.`,
    best.supportingEvidence.length
      ? `Driven by: ${best.supportingEvidence.join("; ")}.`
      : "No weighted signal was triggered, so the ranking is weak and should be treated as a starting point only.",
    `Margin over the next option: ${margin.toFixed(2)}.`,
  ].join(" ");

  return {
    option: best.option,
    label: best.label,
    reason,
    confidence,
    confidenceReasons,
  };
}

/** Full pipeline used by the page and the action, so both show identical numbers. */
export function buildCapitalAssessment(
  input: EvidenceInput,
): { evidence: Evidence; alternatives: OptionAssessment[]; recommendation: Recommendation; assumptions: Assumptions } {
  const assumptions = input.assumptions ?? DEFAULT_ASSUMPTIONS;
  const evidence = computeEvidence({ ...input, assumptions });
  const alternatives = assessOptions(evidence, assumptions);
  const recommendation = recommendOption(evidence, alternatives, assumptions);
  return { evidence, alternatives, recommendation, assumptions };
}

export const CALCULATION_DEFINITIONS: Array<{ label: string; definition: string }> = [
  {
    label: "Available hours",
    definition:
      "Window days × (closing hour − opening hour) from the institute's operating window, minus recorded maintenance downtime hours.",
  },
  {
    label: "Utilisation",
    definition:
      "Actual usage hours from check-in/check-out sessions ÷ available hours. It is a floor when completed bookings have no recorded session.",
  },
  {
    label: "Booked utilisation",
    definition: "Scheduled hours of confirmed, completed and no-show bookings ÷ available hours.",
  },
  {
    label: "No-show rate",
    definition: "No-show bookings ÷ (completed + no-show bookings) in the window.",
  },
  {
    label: "Repair estimate",
    definition:
      "Maximum of (mean cost of resolved maintenance in the window × 1.15) and the most recent resolved repair cost. Unknown, not zero, when there is no resolved maintenance.",
  },
  {
    label: "Replacement cost",
    definition:
      "The recorded replacement quote. When absent, acquisition cost × 1.15, and the record is flagged as derived rather than quoted.",
  },
  {
    label: "Cost per used hour",
    definition: "Maintenance spend in the window ÷ actual usage hours. Excludes depreciation, staff time and opportunity cost.",
  },
  {
    label: "Option score",
    definition:
      "Sum of the weights of the triggered signals shown on each option. Scores rank alternatives against the available evidence; they are not probabilities or savings forecasts.",
  },
  {
    label: "Confidence",
    definition:
      "Low when usage evidence is thin, the window is short, or the leading option lacks required data; high only when sessions, cost and life expectancy are all recorded.",
  },
];
