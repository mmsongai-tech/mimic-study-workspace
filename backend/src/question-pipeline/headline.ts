import type { PlanOutcome } from "./plan-execution.js";

type Estimate = NonNullable<PlanOutcome["result"]>["estimates"][number];
type HeadedPlan = Pick<PlanOutcome, "status" | "chosen_method" | "result" | "quality">;

/** Checks whose failure means the usual estimate is not reported as a result: a degenerate model, too few patients in a group, too few events. */
const ESTIMABILITY_CHECKS = ["effect_size_plausible", "group_sizes", "outcome_events"];

export const notReliablyEstimable = (plan: Pick<PlanOutcome, "quality">): boolean =>
  Boolean(plan.quality?.checks.some(({ check_id, status }) => ESTIMABILITY_CHECKS.includes(check_id) && status === "fail"));

/** Measures that describe a group or test a difference without sizing it; an effect measure is preferred as the headline. */
const NOT_PRIMARY = ["proportion", "mean", "test_statistic", "logrank_chisq"];

export type PlanHeadline =
  /** A prediction model is judged by its test-set AUC, beside the AUC of the background-only model. */
  | { kind: "prediction"; auc?: Estimate | undefined; baseline?: Estimate | undefined }
  /** An effect-modification analysis is answered by its interaction test; `estimate` is one subgroup's estimate, shown under its label. */
  | { kind: "modification"; p_interaction: number; estimate?: Estimate | undefined }
  /** A description answers with what it describes: each characteristic's proportion or mean in the whole cohort (and the groups' shares). */
  | { kind: "description"; estimates: Estimate[] }
  | { kind: "estimate"; estimate?: Estimate | undefined };

/** The rows a description answers with: the groups' shares (terms `group:<level>`), then the characteristics overall, or by group without overall rows. */
const describedRows = (estimates: Estimate[]): Estimate[] => {
  const described = estimates.filter(({ measure }) => measure !== "test_statistic");
  const shares = described.filter(({ term }) => term.startsWith("group:"));
  const characteristics = described.filter(({ term }) => !term.startsWith("group:"));
  const overall = characteristics.filter(({ label }) => / \(overall\)$/u.test(label));
  return [...shares, ...(overall.length ? overall : characteristics)];
};

/**
 * What a completed analysis answers with. One rule for the report, the multiple-comparison family and the web page
 * (frontend lib/domain.ts mirrors it), so a headline and its adjusted P always describe the same thing.
 */
export const planHeadline = (plan: HeadedPlan): PlanHeadline => {
  const estimates = plan.result?.estimates ?? [];
  if (plan.chosen_method?.startsWith("prediction.")) {
    return { kind: "prediction", auc: estimates.find(({ term }) => term === "auc"), baseline: estimates.find(({ term }) => term === "auc_baseline") };
  }
  // A description sizes no effect, and it adds no P to the family: the answer is each group's share, then each characteristic in the
  // whole cohort, or in every group when only groups were described (`descriptive.rates`). Between-group tests are never the answer.
  if (plan.chosen_method?.startsWith("descriptive.")) return { kind: "description", estimates: describedRows(estimates) };
  const estimate = estimates.find(({ measure }) => !NOT_PRIMARY.includes(measure)) ?? estimates[0];
  const interaction = plan.result?.diagnostics?.p_interaction;
  if (typeof interaction === "number" && Number.isFinite(interaction)) return { kind: "modification", p_interaction: interaction, estimate };
  return { kind: "estimate", estimate };
};

/**
 * The P value that stands for an analysis in the multiple-comparison family: the interaction test of an effect-modification
 * analysis, the headline estimate's P otherwise. None for a prediction model (judged by its AUC) or a result that is not
 * reliably estimable (not reported as a result, so it must neither count as significant nor enlarge the family).
 */
export const familyPValue = (plan: HeadedPlan): number | undefined => {
  if (plan.status !== "completed" || notReliablyEstimable(plan)) return undefined;
  const headline = planHeadline(plan);
  const p = headline.kind === "prediction" || headline.kind === "description" ? undefined : headline.kind === "modification" ? headline.p_interaction : headline.estimate?.p_value;
  return typeof p === "number" && Number.isFinite(p) ? p : undefined;
};
