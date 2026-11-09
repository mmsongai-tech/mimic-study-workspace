import assert from "node:assert/strict";
import test from "node:test";
import { checkPlanResult, FileResultCheckRulesRepository, profileAnalysisColumns, type PlanCheckInput } from "../index.js";

const rules = await new FileResultCheckRulesRepository(new URL("../../../../config/result-checks/result-checks.json", import.meta.url)).load();
const columns = [
  { column: "exposure", role: "exposure", requested_label: "Drug" },
  { column: "outcome", role: "outcome", requested_label: "All-cause death", mapping_id: "mimic-iv.all-cause-death.v1" },
  { column: "covariate_age", role: "covariate", requested_label: "Age" },
];
// Synthetic rows: 1,000 patients, 300 exposed, a given death count, ages 20–89.
const rows = (deaths: number, age: (index: number) => number = (index) => 20 + (index % 70)) => Array.from({ length: 1000 }, (_, index) => ({ exposure: index < 300, outcome: index % 1000 < deaths, covariate_age: age(index) }));
const input = (overrides: Partial<PlanCheckInput> = {}, data = rows(30)): PlanCheckInput => ({
  intent: "treatment_effect", outcome_structure: "binary", index_event: "hospital admission", outcome_to_encounter_end: true,
  covariate_names: ["Age", "Sex", "Charlson comorbidity index"],
  mapping: [{ role: "outcome", requested_term: "All-cause death", status: "resolved", selected: { mapping_id: "mimic-iv.all-cause-death.v1", table: "mimiciv_hosp.patients", values: ["patients.dod"] } }],
  profile: profileAnalysisColumns(data, columns),
  result: { n_input: 1000, n_analysed: 1000, estimates: [{ label: "Drug (IPTW)", measure: "odds_ratio", estimate: 0.8, ci_low: 0.6, ci_high: 1.1 }], diagnostics: { max_smd_after: 0.02, effective_sample_size: 900, events_per_parameter: 12 } },
  ...overrides,
});
const statusOf = (quality: ReturnType<typeof checkPlanResult>, id: string) => quality.checks.find(({ check_id }) => check_id === id)?.status;

test("a clean treatment result passes every check except the missing severity adjustment", () => {
  const quality = checkPlanResult(input(), rules);
  assert.equal(quality.rules_version, "1.1.0");
  assert.deepEqual(quality.checks.filter(({ status }) => status !== "pass").map(({ check_id }) => check_id), ["severity_adjustment"]);
  assert.equal(quality.status, "warn");
  assert.equal(statusOf(checkPlanResult(input({ covariate_names: ["Age", "SOFA score"] }), rules), "severity_adjustment"), "pass");
});

test("flags an implausible death rate, as when deaths outside the study window were counted", () => {
  const quality = checkPlanResult(input({}, rows(217)), rules);
  const check = quality.checks.find(({ check_id }) => check_id === "outcome_rate_plausible");
  assert.equal(check?.status, "warn");
  assert.match(check?.observed ?? "", /22%/u);
  // The same rate is plausible for ICU admissions, and no range applies with a stated horizon.
  assert.equal(statusOf(checkPlanResult(input({ index_event: "ICU admission" }, rows(217)), rules), "outcome_rate_plausible"), "pass");
  assert.equal(statusOf(checkPlanResult(input({ outcome_to_encounter_end: false }, rows(217)), rules), "outcome_rate_plausible"), undefined);
});

test("fails a constant outcome and warns on recording artifacts", () => {
  assert.equal(statusOf(checkPlanResult(input({}, rows(0)), rules), "variables_vary"), "fail");
  const artifacts = checkPlanResult(input({}, rows(30, (index) => index % 50 === 0 ? 5000 : 60 + (index % 20))), rules);
  assert.equal(statusOf(artifacts, "extreme_values"), "warn");
});

test("grades balance, weights, events and effect size against the stated thresholds", () => {
  const poor = checkPlanResult(input({ result: { n_input: 1000, n_analysed: 600, estimates: [{ label: "Drug (IPTW)", measure: "odds_ratio", estimate: 0.28, ci_low: 0.24, ci_high: 0.33 }], diagnostics: { max_smd_after: 0.31, effective_sample_size: 150, events_per_parameter: 4 } } }), rules);
  assert.equal(statusOf(poor, "covariate_balance"), "fail");
  assert.equal(statusOf(poor, "weight_stability"), "warn");
  assert.equal(statusOf(poor, "outcome_events"), "warn");
  assert.equal(statusOf(poor, "effect_size_plausible"), "warn");
  assert.equal(statusOf(poor, "missing_data"), "warn");
  assert.equal(poor.status, "fail");
  assert.equal(statusOf(checkPlanResult(input({}, rows(5)), rules), "outcome_events"), "fail");
});

test("reports small counts as <10 and never includes patient-level values", () => {
  const quality = checkPlanResult(input({}, rows(5)), rules);
  assert.match(quality.checks.find(({ check_id }) => check_id === "outcome_events")!.observed, /^<10 of 1,000/u);
  const profile = profileAnalysisColumns(rows(30), columns);
  assert.deepEqual(Object.keys(profile[2]!).sort(), ["column", "distinct", "kind", "label", "mean", "median", "missing", "n", "q1", "q3", "role", "sd"]);
});

test("an outcome defined only by a diagnosis code is flagged as having no known timing", () => {
  const diagnosis = input({ mapping: [{ role: "outcome", requested_term: "Heart failure", status: "resolved", selected: { mapping_id: "mimic-iv.heart-failure.v1", table: "mimiciv_hosp.diagnoses_icd", values: ["ICD-10 I50"] } }] });
  assert.equal(statusOf(checkPlanResult(diagnosis, rules), "outcome_timing"), "warn");
  assert.equal(statusOf(checkPlanResult(input(), rules), "outcome_timing"), undefined, "a dated outcome such as death is not flagged");
});

test("an estimate of about zero with an empty interval fails instead of being reported", () => {
  const degenerate = input({ result: { n_input: 1000, n_analysed: 1000, estimates: [{ label: "Drug (IPTW)", measure: "odds_ratio", estimate: 0, ci_low: 0, ci_high: 0 }], diagnostics: {} } as never });
  assert.equal(statusOf(checkPlanResult(degenerate, rules), "effect_size_plausible"), "fail");
  assert.equal(checkPlanResult(degenerate, rules).status, "fail");
});

test("a prediction fitted on a minority of the cohort is flagged, and a diagnosis-coded outcome warns of overstated performance", () => {
  const few = input({ intent: "prediction", result: { ...input().result!, n_input: 1000, n_analysed: 90 } });
  assert.equal(statusOf(checkPlanResult(few, rules), "prediction_coverage"), "warn");
  assert.equal(statusOf(checkPlanResult(input({ intent: "prediction" }), rules), "prediction_coverage"), "pass");
  assert.equal(statusOf(checkPlanResult(input(), rules), "prediction_coverage"), undefined, "only predictions are checked");
  const coded = input({ intent: "prediction", mapping: [{ role: "outcome", requested_term: "Acute kidney injury", status: "resolved", selected: { mapping_id: "m", table: "mimiciv_hosp.diagnoses_icd", values: ["ICD-10 N17"] } }] });
  assert.match(checkPlanResult(coded, rules).checks.find(({ check_id }) => check_id === "outcome_timing")!.message.en, /overstated/u);
});

test("an association whose interval spans two orders of magnitude is not a reliable estimate", async () => {
  const rules = await new FileResultCheckRulesRepository(new URL("../../../../config/result-checks/result-checks.json", import.meta.url)).load();
  const input = (estimate: number, low: number, high: number) => ({ intent: "association" as const, outcome_to_encounter_end: false, covariate_names: [], mapping: [], profile: [],
    result: { n_input: 80, n_analysed: 80, estimates: [{ measure: "odds_ratio", estimate, ci_low: low, ci_high: high, label: "NLR (adjusted)" }], diagnostics: {} } });
  assert.equal(checkPlanResult(input(1.2, 0.05, 40), rules).checks.find(({ check_id }) => check_id === "effect_size_plausible")?.status, "fail");
  assert.equal(checkPlanResult(input(1.2, 1.1, 1.5), rules).checks.find(({ check_id }) => check_id === "effect_size_plausible"), undefined);
});

test("many first eligible units without a recorded exposure or outcome warn that the result describes recorded patients", () => {
  const warned = checkPlanResult(input({ selection: { first_eligible_units: 10_000, missing_exposure_or_outcome: 8_300 } }), rules).checks.find(({ check_id }) => check_id === "outcome_recorded")!;
  assert.equal(warned.status, "warn");
  assert.match(warned.observed, /8,300 of 10,000 first eligible units lack them \(83%\)/u);
  assert.equal(checkPlanResult(input({ selection: { first_eligible_units: 1000, missing_exposure_or_outcome: 50 } }), rules).checks.find(({ check_id }) => check_id === "outcome_recorded")!.status, "pass");
  assert.equal(checkPlanResult(input(), rules).checks.some(({ check_id }) => check_id === "outcome_recorded"), false);
});

test("a prediction's first eligible units without any predictor are described as such, not as lacking an exposure", () => {
  const warned = checkPlanResult(input({ intent: "prediction", selection: { first_eligible_units: 223_452, missing_exposure_or_outcome: 74_931 } }), rules).checks.find(({ check_id }) => check_id === "outcome_recorded")!;
  assert.equal(warned.status, "warn");
  assert.equal(warned.title.en, "Predictors and outcome recorded");
  assert.match(warned.message.en, /no predictor measured in the window/u);
  assert.doesNotMatch(warned.message.zh, /暴露/u);
});

test("a severity variable recorded for no patient does not count as severity adjustment", () => {
  // Vasopressors and ventilation were 0 for every patient of a readmission analysis and the check still passed (2026-10-27).
  const withVasopressors = [...columns, { column: "covariate_vasopressors", role: "covariate", requested_label: "Vasopressors" }];
  const data = rows(30).map((row) => ({ ...row, covariate_vasopressors: false }));
  const flat = checkPlanResult(input({ covariate_names: ["Age", "Vasopressors"], profile: profileAnalysisColumns(data, withVasopressors) }), rules);
  assert.equal(statusOf(flat, "severity_adjustment"), "warn");
  const varying = rows(30).map((row, index) => ({ ...row, covariate_vasopressors: index % 7 === 0 }));
  assert.equal(statusOf(checkPlanResult(input({ covariate_names: ["Age", "Vasopressors"], profile: profileAnalysisColumns(varying, withVasopressors) }), rules), "severity_adjustment"), "pass");
});

test("a description's checks never fail on a small group or read a described death rate as the outcome, and report sparse characteristics", () => {
  // 1,000 patients, 30 received the drug (the grouping); in-hospital death is a characteristic; lactate is recorded for 400.
  const data = Array.from({ length: 1000 }, (_, index) => ({ exposure: index < 30, characteristic_0: index % 10 === 0, ...(index < 400 ? { characteristic_1: 1 + (index % 30) / 10 } : {}) }));
  const described = profileAnalysisColumns(data, [
    { column: "exposure", role: "exposure", requested_label: "Beta blockers" },
    { column: "characteristic_0", role: "characteristic", requested_label: "In-hospital mortality", mapping_id: "mimic-iv.in-hospital-mortality.v1" },
    { column: "characteristic_1", role: "characteristic", requested_label: "Lactate" },
  ]);
  const quality = checkPlanResult({ intent: "association", index_event: "hospital admission", outcome_to_encounter_end: true, covariate_names: ["Charlson comorbidity index"], description: true,
    mapping: [{ role: "outcome", characteristic: true, requested_term: "In-hospital mortality", status: "resolved", selected: { mapping_id: "mimic-iv.in-hospital-mortality.v1", table: "mimiciv_hosp.diagnoses_icd", values: [] } }],
    profile: described, result: { n_input: 1000, n_analysed: 1000, estimates: [{ label: "In-hospital mortality (overall)", measure: "proportion", estimate: 0.1, ci_low: 0.08, ci_high: 0.12 }], diagnostics: {} } }, rules);
  assert.equal(statusOf(quality, "group_sizes"), "warn", "a group of 30 is reported, not a failed estimate");
  assert.equal(statusOf(quality, "outcome_events"), undefined);
  assert.equal(statusOf(quality, "outcome_rate_plausible"), undefined);
  assert.equal(statusOf(quality, "outcome_timing"), undefined, "a characteristic's source is not the timing of an outcome");
  assert.equal(statusOf(quality, "characteristics_recorded"), "warn");
  assert.match(quality.checks.find(({ check_id }) => check_id === "characteristics_recorded")!.observed, /Lactate: 40%/u);
  assert.notEqual(quality.status, "fail");
  // The same group sizes still fail a comparison.
  assert.equal(statusOf(checkPlanResult({ ...input(), profile: described }, rules), "group_sizes"), "fail");
});
