import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { GenericRAnalysisExecutor, type ProjectedAnalysisRow } from "../index.js";

const executor = new GenericRAnalysisExecutor({ rscript_binary: "Rscript", script_path: fileURLToPath(new URL("../runtimes/r/generic_manifest_analysis.R", import.meta.url)), timeout_ms: 30_000 });
const rows = Array.from({ length: 240 }, (_, index): ProjectedAnalysisRow => ({ analysis_id: String(index), exposure: index % 2, predictor_0: (index % 17) / 3, predictor_1: index % 5, covariate_0: 30 + index % 50, covariate_1: index % 2, outcome: Number((index % 7 === 0) || (index % 2 === 1 && index % 5 === 0)) }));

test("runs generic association statistics and a crude sensitivity model", async () => {
  const result = await executor.execute({ rows, study_family: "association", outcome_structure: "binary" });
  assert.equal(result.method, "multivariable_logistic_regression"); assert.equal(result.counts.complete, 240); assert.equal(result.diagnostics.converged, true); assert.equal(result.sensitivity.analysis, "crude_model");
  assert.equal(result.estimates.effect_scale, "odds_ratio"); assert.equal(typeof result.estimates.estimate, "number");
  assert.equal(typeof result.estimates.risk_difference, "number"); assert.equal(typeof result.estimates.risk_difference_ci_lower, "number"); assert.equal(typeof result.counts.exposed_events, "number");
  assert.deepEqual(result.publication_outputs.tables.map(({ id }) => id), ["table_1", "primary_results", "model_diagnostics", "sensitivity_analysis"]);
  assert.equal(result.publication_outputs.listings[0]?.privacy, "aggregate_only");
  assert.match(result.publication_outputs.figures[0]?.content ?? "", /^<svg/u);
});

test("runs generic prediction with a deterministic held-out split", async () => {
  const result = await executor.execute({ rows: rows.map(({ exposure: _exposure, ...row }) => row), study_family: "prediction", outcome_structure: "binary" });
  assert.equal(result.method, "logistic_prediction_deterministic_split"); assert.equal(result.counts.complete, 240); assert.equal(typeof result.estimates.auroc, "number");
  assert.equal(typeof result.diagnostics.calibration_slope, "number"); assert.equal(typeof result.diagnostics.sensitivity_at_0_5, "number");
});

test("runs generic treatment-effect IPTW with a truncation sensitivity", async () => {
  const result = await executor.execute({ rows, study_family: "treatment_effect", outcome_structure: "binary" });
  assert.equal(result.method, "stabilized_iptw"); assert.equal(result.counts.complete, 240); assert.equal(typeof result.estimates.estimate, "number"); assert.equal(result.sensitivity.analysis, "weight_truncation_5_95");
  assert.equal(typeof result.diagnostics.maximum_weighted_smd, "number"); assert.equal(typeof result.diagnostics.propensity_minimum, "number");
  assert.equal(typeof result.estimates.ci_lower, "number"); assert.equal(typeof result.estimates.ci_upper, "number"); assert.equal(result.estimates.ci_method, "weighted_influence_function_normal_approximation");
});

test("reports interaction and stratified treatment effects for a binary modifier", async () => {
  const modified = rows.map(({ covariate_1: _covariate1, ...row }, index) => ({ ...row, effect_modifier_0: Math.floor(index / 2) % 2 }));
  const result = await executor.execute({ rows: modified, study_family: "treatment_effect", outcome_structure: "binary" });
  assert.equal(result.method, "stabilized_iptw_with_effect_modification");
  assert.equal(result.estimates.interaction_effect_scale, "ratio_of_odds_ratios");
  assert.equal(typeof result.estimates.interaction_estimate, "number");
  assert.equal(typeof result.estimates.stratum_1_effect, "number");
  assert.equal(typeof result.estimates.stratum_2_effect, "number");
  assert.equal(typeof result.estimates.stratum_1_ci_lower, "number");
  assert.equal(typeof result.estimates.stratum_2_ci_upper, "number");
});

test("builds publication tables from the same complete cases used by R", async () => {
  const incomplete = rows.map((row, index) => index === 0 ? { ...row, covariate_0: undefined } : row);
  const result = await executor.execute({ rows: incomplete, study_family: "treatment_effect", outcome_structure: "binary" });
  const analysisUnits = result.publication_outputs.tables.find(({ id }) => id === "table_1")?.rows.find(([label]) => label === "Analysis units")?.[1];
  assert.equal(result.counts.complete, 239);
  assert.equal(analysisUnits, "239");
});

test("drops zero-variance ordinary adjustments before complete-case selection and reports the downgrade", async () => {
  const constant = rows.map((row, index) => ({ ...row, covariate_2: index === 0 ? undefined : 1 }));
  const result = await executor.execute({ rows: constant, study_family: "treatment_effect", outcome_structure: "binary" });
  const table = result.publication_outputs.tables.find(({ id }) => id === "table_1");
  assert.equal(result.counts.complete, 240);
  assert.equal(result.diagnostics.zero_variance_adjustments_dropped, 1);
  assert.equal(table?.rows.some(([label]) => label === "covariate_2"), false);
});

test("runs a fixed continuous-outcome treatment method with effect modification", async () => {
  const continuous = rows.map((row, index) => ({ ...row, outcome: 130 - Number(row.exposure) * 8 + (index % 9), effect_modifier_0: Math.floor(index / 2) % 2 }));
  const result = await executor.execute({ rows: continuous, study_family: "treatment_effect", outcome_structure: "continuous" });
  assert.equal(result.method, "stabilized_iptw_continuous_with_effect_modification");
  assert.equal(result.estimates.effect_scale, "mean_difference");
  assert.equal(typeof result.estimates.mean_treated, "number");
  assert.equal(result.estimates.interaction_effect_scale, "difference_in_mean_differences");
  assert.equal(typeof result.estimates.interaction_estimate, "number");
});

test("runs a continuous association model with a modifier", async () => {
  const continuous = rows.map((row, index) => ({ ...row, outcome: 80 + Number(row.exposure) * 4 + (index % 11), effect_modifier_0: Math.floor(index / 2) % 2 }));
  const result = await executor.execute({ rows: continuous, study_family: "association", outcome_structure: "continuous" });
  assert.equal(result.method, "multivariable_linear_regression");
  assert.equal(result.estimates.effect_scale, "mean_difference");
  assert.equal(result.estimates.interaction_effect_scale, "difference_in_mean_differences");
});

test("renders categorical baseline values as aggregate counts instead of NA", async () => {
  const categorical = rows.map(({ covariate_1: _covariate, ...row }, index) => ({ ...row, covariate_1: index % 2 ? "level-b" : "level-a" }));
  const result = await executor.execute({ rows: categorical, study_family: "association", outcome_structure: "binary" });
  const categoryRow = result.publication_outputs.tables.find(({ id }) => id === "table_1")?.rows.find(([label]) => label === "covariate_1");
  assert.match(categoryRow?.[1] ?? "", /level-a: 120 \(50\.0%\)/u);
  assert.match(categoryRow?.[1] ?? "", /level-b: 120 \(50\.0%\)/u);
});
