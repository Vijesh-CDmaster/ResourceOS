"use server";

import { revalidatePath } from "next/cache";
import { withOrg } from "../db";
import { requireUser } from "../auth";
import { canManage } from "../roles";
import { recordAudit } from "../audit";
import { fail, field, ok, errorMessage } from "../action-utils";
import {
  buildCapitalAssessment,
  DEFAULT_ASSUMPTIONS,
  OPTION_LABEL,
  OPTION_ORDER,
  type CapitalOption,
} from "../capital/model";
import { getAssetCapitalInputs, getOrganizationContext } from "../queries/capital";

const CAPITAL = "/capital";

function isOption(value: string): value is CapitalOption {
  return (OPTION_ORDER as string[]).includes(value);
}

function parseWindow(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 180;
  return Math.min(730, Math.max(30, parsed));
}

/**
 * Generates a Capital Decision Record from the current evidence.
 *
 * The evidence is recomputed on the server from the database — the browser only
 * supplies which asset and which window. Nothing on the client can influence the
 * numbers that get stored.
 */
export async function generateDecisionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const resourceId = field(formData, "resource_id");
  const windowDays = parseWindow(field(formData, "window_days"));
  const assetPath = `${CAPITAL}/${resourceId}`;

  if (!canManage(user.role)) {
    fail(assetPath, "Only administrators and facility managers can generate capital decisions.");
  }
  if (!resourceId) fail(CAPITAL, "Choose an asset first.");

  let problem: string | null = null;
  let decisionId: string | null = null;

  try {
    const organization = await getOrganizationContext(user.organizationId);
    if (!organization) throw new Error("Workspace not found.");

    const inputs = await getAssetCapitalInputs(user.organizationId, resourceId, windowDays);
    if (!inputs) throw new Error("That asset does not exist for this institution.");

    const { evidence, alternatives, recommendation, assumptions } = buildCapitalAssessment({
      ...inputs,
      windowDays,
      openHour: organization.openHour,
      closeHour: organization.closeHour,
      now: new Date(),
      assumptions: DEFAULT_ASSUMPTIONS,
    });

    decisionId = await withOrg(user.organizationId, async (db) => {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO capital_decisions
           (organization_id, resource_id, asset_code, asset_name, window_days, evidence, alternatives,
            assumptions, recommended_option, recommendation_reason, confidence, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          user.organizationId,
          resourceId,
          evidence.assetCode,
          evidence.assetName,
          windowDays,
          JSON.stringify(evidence),
          JSON.stringify(alternatives),
          JSON.stringify(assumptions),
          recommendation.option,
          recommendation.reason,
          recommendation.confidence,
          user.userId,
        ],
      );
      const id = inserted.rows[0].id;

      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "capital.recommendation_generated",
        entityType: "capital_decision",
        entityId: id,
        summary: `${user.name} generated a capital recommendation for ${evidence.assetCode}: ${OPTION_LABEL[recommendation.option]} (${recommendation.confidence} confidence)`,
        metadata: {
          recommendedOption: recommendation.option,
          confidence: recommendation.confidence,
          windowDays,
          utilisation: evidence.capacity.utilisation,
          usedHours: evidence.demand.usedHours,
        },
      });

      return id;
    });
  } catch (error) {
    problem = errorMessage(error, "Could not generate the recommendation.");
  }

  if (problem || !decisionId) {
    fail(assetPath, problem ?? "Could not generate the recommendation.");
  }

  revalidatePath(CAPITAL);
  revalidatePath(assetPath);
  revalidatePath(`${CAPITAL}/decisions/${decisionId}`);
  ok(
    `${CAPITAL}/decisions/${decisionId}`,
    "Recommendation saved. It stays pending until an authorised person records a decision.",
  );
}

/**
 * Records the human decision on a pending recommendation. The recommendation is
 * advisory: this action is the only path that sets a decision, and it requires a
 * named person and a written rationale.
 */
export async function recordDecisionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const decisionId = field(formData, "decision_id");
  const option = field(formData, "option");
  const rationale = field(formData, "rationale");
  const recordPath = `${CAPITAL}/decisions/${decisionId}`;

  if (!canManage(user.role)) {
    fail(CAPITAL, "Only administrators and facility managers can record a capital decision.");
  }
  if (!decisionId) fail(CAPITAL, "No decision record selected.");

  let problem: string | null = null;
  let message = "";

  try {
    if (!isOption(option)) throw new Error("Choose one of the five options.");
    if (rationale.trim().length < 12) {
      throw new Error("Record a rationale of at least 12 characters explaining the decision.");
    }
    if (rationale.length > 2000) throw new Error("The rationale must be 2,000 characters or fewer.");

    await withOrg(user.organizationId, async (db) => {
      const existing = await db.query<{
        id: string;
        status: string;
        recommended_option: string;
        asset_code: string;
      }>(
        `SELECT id, status, recommended_option, asset_code
           FROM capital_decisions
          WHERE id = $1 AND organization_id = $2
          FOR UPDATE`,
        [decisionId, user.organizationId],
      );
      const record = existing.rows[0];
      if (!record) throw new Error("That decision record does not exist for this institution.");
      if (record.status === "decided") throw new Error("This decision has already been recorded.");

      await db.query(
        `UPDATE capital_decisions
            SET status = 'decided', decision_option = $2, decision_rationale = $3,
                decided_by = $4, decided_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [decisionId, option, rationale.trim(), user.userId],
      );

      const agreed = option === record.recommended_option;
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "capital.decision_recorded",
        entityType: "capital_decision",
        entityId: decisionId,
        summary: `${user.name} decided ${OPTION_LABEL[option]} for ${record.asset_code}${
          agreed ? "" : ` (recommendation was ${OPTION_LABEL[record.recommended_option as CapitalOption]})`
        }`,
        metadata: { decisionOption: option, recommendedOption: record.recommended_option, agreed },
      });

      message = agreed
        ? `Decision recorded: ${OPTION_LABEL[option]}.`
        : `Decision recorded: ${OPTION_LABEL[option]}, overriding the recommendation of ${OPTION_LABEL[record.recommended_option as CapitalOption]}.`;
    });
  } catch (error) {
    problem = errorMessage(error, "Could not record the decision.");
  }

  if (problem) fail(recordPath, problem);

  revalidatePath(CAPITAL);
  revalidatePath(recordPath);
  ok(recordPath, message || "Decision recorded.");
}
