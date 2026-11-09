import { familyPValue, planHeadline } from "./headline.js";
import type { PlanOutcome } from "./plan-execution.js";

export interface MultiplicityAdjustment {
  method: "holm";
  /** Distinct analyses in the family (a result reported twice under different names counts once). */
  analyses: number;
  /** Distinct analyses with P<0.05 before and after the adjustment, counted like `analyses`. */
  significant_before: number;
  significant_after: number;
  adjusted: Array<{ plan_id: string; p_value: number; p_adjusted: number }>;
}

/**
 * Holm step-down adjustment over a run's completed analyses, each represented by its family P value (see headline.ts:
 * the interaction test for effect modification; no prediction models and no results that are not reliably estimable).
 * Nothing to adjust for a single analysis.
 */
export function adjustForMultiplicity(plans: PlanOutcome[]): MultiplicityAdjustment | undefined {
  const tested = plans.flatMap((plan) => {
    const p_value = familyPValue(plan);
    if (p_value === undefined) return [];
    const headline = planHeadline(plan);
    const estimate = headline.kind === "prediction" || headline.kind === "description" ? undefined : headline.estimate?.estimate;
    // Two plans that report the same result (a death outcome listed twice under different names) are one analysis.
    return [{ plan_id: plan.plan_id, p_value, key: `${plan.exposure_level ?? ""}|${estimate}|${p_value}` }];
  });
  const distinct = new Map<string, { plan_id: string; p_value: number }>();
  for (const row of tested) if (!distinct.has(row.key)) distinct.set(row.key, row);
  const unique = [...distinct.values()];
  if (unique.length < 2) return undefined;
  const ordered = [...unique].sort((a, b) => a.p_value - b.p_value);
  let running = 0;
  const adjustedById = new Map(ordered.map((row, index) => {
    running = Math.max(running, Math.min(1, row.p_value * (ordered.length - index)));
    return [row.plan_id, running] as const;
  }));
  // Duplicates share the adjusted value of the analysis they repeat.
  const adjusted = tested.map(({ plan_id, p_value, key }) => ({ plan_id, p_value, p_adjusted: adjustedById.get(distinct.get(key)!.plan_id)! }));
  return {
    method: "holm",
    analyses: unique.length,
    significant_before: unique.filter(({ p_value }) => p_value < 0.05).length,
    significant_after: unique.filter(({ plan_id }) => adjustedById.get(plan_id)! < 0.05).length,
    adjusted,
  };
}
