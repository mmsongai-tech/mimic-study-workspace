import { createHash } from "node:crypto";

export interface ContinuousGroupSummary { n: number; sum: number; sum_of_squares: number; }
export interface AggregateContinuousAssociationResult {
  schema_version: "1.0.0"; status: "completed"; method_id: "aggregate_continuous_association.v1"; input_integrity_id: string;
  groups: { exposed: ContinuousGroupSummary; unexposed: ContinuousGroupSummary };
  estimates: { exposed_mean: number; unexposed_mean: number; mean_difference: number; exposed_sd: number | null; unexposed_sd: number | null };
  model: { input: "aggregate_group_moments"; estimand: string; limitations: string[] };
}

const validate = (group: ContinuousGroupSummary, label: string): void => {
  if (!Number.isSafeInteger(group.n) || group.n < 1 || !Number.isFinite(group.sum) || !Number.isFinite(group.sum_of_squares)) throw new Error(`Invalid aggregate summary: ${label}`);
  if (group.sum_of_squares < (group.sum * group.sum) / group.n - 1e-8) throw new Error(`Inconsistent aggregate moments: ${label}`);
};

const sd = (group: ContinuousGroupSummary): number | null => group.n > 1 ? Math.sqrt(Math.max(0, (group.sum_of_squares - (group.sum * group.sum) / group.n) / (group.n - 1))) : null;

export const executeAggregateContinuousAssociation = (groups: AggregateContinuousAssociationResult["groups"]): AggregateContinuousAssociationResult => {
  validate(groups.exposed, "exposed"); validate(groups.unexposed, "unexposed");
  const exposed_mean = groups.exposed.sum / groups.exposed.n;
  const unexposed_mean = groups.unexposed.sum / groups.unexposed.n;
  return { schema_version: "1.0.0", status: "completed", method_id: "aggregate_continuous_association.v1", input_integrity_id: `sha256:${createHash("sha256").update(JSON.stringify(groups)).digest("hex")}`, groups, estimates: { exposed_mean, unexposed_mean, mean_difference: exposed_mean - unexposed_mean, exposed_sd: sd(groups.exposed), unexposed_sd: sd(groups.unexposed) }, model: { input: "aggregate_group_moments", estimand: "Difference in group means", limitations: ["Crude aggregate comparison; no covariate adjustment or distributional diagnostics.", "Confidence intervals require an explicit variance and dependence model."] } };
};
