import "server-only";
import type { Role } from "./roles";

/**
 * Work-order lifecycle.
 *
 * A work order is the record of a repair; it is *not* the record that an asset
 * is safe to use again. Those are deliberately separate:
 *
 *   work_orders.status     where the repair is in its process
 *   resource_holds         whether the asset is still held
 *
 * Completing a repair never clears a hold. Only `release` does, and `release`
 * re-runs the readiness checks (ignoring its own hold) before it will proceed.
 *
 * The transition table is the single source of truth for "which move is legal",
 * so an action cannot invent a status jump the process does not allow.
 */

export const WORK_ORDER_STATUSES = [
  "reported",
  "assigned",
  "in_progress",
  "waiting_parts",
  "repair_completed",
  "awaiting_verification",
  "verified",
  "closed",
] as const;

export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const WORK_ORDER_STATUS_LABEL: Record<WorkOrderStatus, string> = {
  reported: "Reported",
  assigned: "Assigned",
  in_progress: "In progress",
  waiting_parts: "Waiting for parts",
  repair_completed: "Repair completed",
  awaiting_verification: "Awaiting verification",
  verified: "Verified",
  closed: "Closed",
};

export const WORK_ORDER_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type WorkOrderPriority = (typeof WORK_ORDER_PRIORITIES)[number];

export const OPEN_STATUSES: WorkOrderStatus[] = [
  "reported",
  "assigned",
  "in_progress",
  "waiting_parts",
  "repair_completed",
  "awaiting_verification",
  "verified",
];

export const TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  reported: ["assigned"],
  assigned: ["in_progress"],
  in_progress: ["waiting_parts", "repair_completed", "awaiting_verification"],
  waiting_parts: ["in_progress"],
  // A finished repair either needs independent verification, or (when policy
  // says verification is not required) goes straight to an authorised release.
  repair_completed: ["awaiting_verification", "closed"],
  // Rejected verification sends the job back for rework.
  awaiting_verification: ["verified", "in_progress"],
  verified: ["closed", "in_progress"],
  // Reopening is explicit and requires a reason.
  closed: ["in_progress"],
};

export function canTransition(from: WorkOrderStatus, to: WorkOrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function isOpenStatus(status: WorkOrderStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/** Human-readable summary of what a status means for the asset. */
export function statusMeaning(status: WorkOrderStatus, requiresVerification: boolean): string {
  switch (status) {
    case "reported":
      return "Reported but not yet assigned. The asset is held.";
    case "assigned":
      return "An owner is assigned. The asset is held.";
    case "in_progress":
      return "Work is under way. The asset is held.";
    case "waiting_parts":
      return "Waiting for parts. The asset is held.";
    case "repair_completed":
      return requiresVerification
        ? "Repair reported complete, but independent verification is still required before release."
        : "Repair complete. Release is waiting on an authorised staff sign-off.";
    case "awaiting_verification":
      return "Repair complete. An independent verifier must check the work before release.";
    case "verified":
      return "Verified. A facility manager must still release the asset explicitly.";
    case "closed":
      return "Closed and released.";
  }
}

/** Who may run each operation. Authorisation is enforced in the action too. */
export const PERMISSIONS = {
  create: ["admin", "manager", "technician"] as Role[],
  assign: ["admin", "manager"] as Role[],
  progress: ["admin", "manager", "technician"] as Role[],
  completeRepair: ["admin", "manager", "technician"] as Role[],
  verify: ["admin", "manager", "technician"] as Role[],
  release: ["admin", "manager"] as Role[],
  reopen: ["admin", "manager"] as Role[],
  override: ["admin", "manager"] as Role[],
} as const;

export function can(role: Role, operation: keyof typeof PERMISSIONS): boolean {
  return PERMISSIONS[operation].includes(role);
}

export type VerificationCheck =
  | { ok: true }
  | { ok: false; code: "not_required" | "self_verification" | "not_authorised"; message: string };

/**
 * Independent verification: when the asset policy requires it, the person who
 * signed off the repair may not be the person who verifies it. The rule is pure
 * so it can be tested without a database, and it is re-checked inside the action
 * against the row that was actually stored.
 */
export function checkVerifier(input: {
  role: Role;
  requiresVerification: boolean;
  repairerId: string | null;
  verifierId: string;
  status: WorkOrderStatus;
}): VerificationCheck {
  if (input.status !== "awaiting_verification") {
    return { ok: false, code: "not_required", message: "This work order is not awaiting verification." };
  }
  if (!can(input.role, "verify")) {
    return { ok: false, code: "not_authorised", message: "You are not authorised to verify repairs." };
  }
  if (input.requiresVerification && input.repairerId && input.repairerId === input.verifierId) {
    return {
      ok: false,
      code: "self_verification",
      message: "Independent verification is required: the person who completed the repair cannot verify it.",
    };
  }
  return { ok: true };
}

/**
 * The one status a release may start from. A job that never needed independent
 * verification is releasable straight after the repair is signed off; one that
 * does must be verified first. `verified` always qualifies.
 */
export function isReleasable(status: WorkOrderStatus, requiresVerification: boolean): boolean {
  if (status === "verified") return true;
  return status === "repair_completed" && !requiresVerification;
}

export const OVERRIDE_ACTIONS = [
  "operational_exception",
  "scheduling_exception",
  "restrict_resource",
  "cancel_bookings",
  "relocate_bookings",
  "communicate_downtime",
] as const;

export type OverrideAction = (typeof OVERRIDE_ACTIONS)[number];

export const OVERRIDE_ACTION_LABEL: Record<OverrideAction, string> = {
  operational_exception: "Record an operational exception",
  scheduling_exception: "Record a justified scheduling exception",
  restrict_resource: "Temporarily restrict the resource",
  cancel_bookings: "Cancel affected bookings",
  relocate_bookings: "Flag affected bookings for relocation",
  communicate_downtime: "Communicate downtime to affected users",
};

/** Actions that change booking or resource state, and so take a window. */
export function overrideNeedsWindow(action: OverrideAction): boolean {
  return action === "restrict_resource" || action === "cancel_bookings" || action === "relocate_bookings";
}

/**
 * Restrictions that an emergency override may never bypass. These are checked
 * before the override row is written, so an operator cannot use the workflow to
 * start a session on an unsafe or uncalibrated asset.
 *
 * The list is explicit and short on purpose: each entry is a condition where a
 * human override would create a safety or compliance risk, not an inconvenience.
 */
export const NON_OVERRIDABLE = [
  "calibration_expired",
  "calibration_failed",
  "calibration_missing",
  "safety_hold",
  "active_hold",
  "resource_retired",
  "quota",
  "no_training",
] as const;

export type NonOverridableCode = (typeof NON_OVERRIDABLE)[number];

export function isNonOverridable(code: string): code is NonOverridableCode {
  return (NON_OVERRIDABLE as readonly string[]).includes(code);
}

/**
 * Checks whether an override of `action` is blocked by the asset's current
 * readiness verdict. Recording an exception or communicating downtime is always
 * allowed (it grants nothing); anything that would let work proceed is refused
 * when a non-overridable condition is present.
 */
export function overrideBlockedBy(
  blockedCodes: string[],
  action: OverrideAction,
): NonOverridableCode[] {
  const grantsOrReschedules = action === "scheduling_exception";
  if (!grantsOrReschedules) return [];
  return blockedCodes.filter(isNonOverridable) as NonOverridableCode[];
}

/** Minimum reason length, mirrored by the database CHECK. */
export const MIN_OVERRIDE_REASON = 20;
