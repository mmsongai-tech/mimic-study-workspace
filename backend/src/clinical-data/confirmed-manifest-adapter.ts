import type { ConfirmedManifest } from "../research-design/research-definition.js";
import type { AnalysisInputManifest } from "./local-analysis-inputs.js";

export const toExecutionManifest = (manifest: ConfirmedManifest): AnalysisInputManifest => {
  if (!manifest.subject_id?.column) throw new Error("A confirmed subject identifier is required before execution.");
  const find = (role: "exposure" | "predictor" | "outcome" | "covariate"): string[] => manifest.fields.filter((field) => field.role === role).flatMap((field) => field.columns);
  const exposure = find("exposure")[0]; const outcome = find("outcome")[0];
  if (!exposure) throw new Error("A confirmed exposure or treatment field is required before execution.");
  if (!outcome) throw new Error("A confirmed outcome field is required before execution.");
  const predictors = find("predictor"); const covariates = find("covariate");
  return { subject_id: manifest.subject_id.column, exposure, outcome, ...(predictors.length ? { predictors: Object.fromEntries(predictors.map((name) => [name, name])) } : {}), ...(covariates.length ? { strata: covariates } : {}), ...(manifest.time_windows?.find((window) => window.purpose === "follow_up") ? { time_end: "duration" } : {}) };
};
