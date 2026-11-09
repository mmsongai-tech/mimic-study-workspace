import assert from "node:assert/strict";
import test from "node:test";
import { assessResearchProtocol, type StudySpec } from "../index.js";

const completeSpec = (): StudySpec => ({
  schema_version: "1.0.0",
  intent_family: "association",
  title: "Lactate and mortality",
  research_question: "Is early lactate associated with in-hospital mortality?",
  population: { description: "Adult ICU admissions", inclusion_criteria: ["Age at least 18 years"], exclusion_criteria: ["Missing outcome"], criteria: { condition_id: "population.adult_icu", source_text: "Adult ICU admissions", kind: "all", operands: [
    { condition_id: "population.adult", source_text: "Adult", kind: "numeric_comparison", concept: "age", operator: "gte", value: 18, unit: "year" },
    { condition_id: "population.icu", source_text: "ICU admissions", kind: "concept", concept: "ICU admission", assertion: "present" },
  ] } },
  index_time: { event: "ICU admission", selection_rule: "First eligible ICU admission" },
  exposure_or_predictors: [{ name: "Lactate", role: "exposure", operational_definition: "Maximum in six hours", definition: { condition_id: "exposure.lactate", source_text: "Lactate", kind: "concept", concept: "blood lactate", assertion: "present" } }],
  outcome: { name: "In-hospital mortality", role: "outcome", operational_definition: "Death before hospital discharge", definition: { condition_id: "outcome.mortality", source_text: "Death before hospital discharge", kind: "event_exists", concept: "in-hospital mortality", occurrence: "present" } },
  outcome_structure: "binary",
  time_windows: [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 30, unit: "day" }],
  covariates: [{ name: "Age", role: "covariate", operational_definition: "Age at admission", definition: { condition_id: "covariate.age", source_text: "Age at admission", kind: "concept", concept: "age", assertion: "present" } }],
  estimand: { target_population: "Adult ICU admissions", exposure_contrast: "High versus low lactate", outcome_measure: "In-hospital mortality", summary_measure: "Adjusted odds ratio and standardized risk difference" },
  analysis_family: "association",
  assumptions: ["No unmeasured confounding is not required for a causal claim because this is an association study."],
});

test("accepts a structurally complete research protocol", () => {
  const result = assessResearchProtocol(completeSpec());
  assert.equal(result.status, "complete");
  assert.equal(result.requirements.length, 0);
});

test("accepts an outcome bounded by the end of the encounter", () => {
  const value = completeSpec();
  value.time_windows = [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }];
  const result = assessResearchProtocol(value);
  assert.equal(result.status, "complete");
  assert.equal(result.requirements.some(({ code }) => code === "OUTCOME_WINDOW_REQUIRED"), false);
});

for (const [name, mutate, code] of [
  ["purpose", (value: StudySpec) => { value.intent_family = "undetermined"; }, "PURPOSE_REQUIRED"],
  ["question", (value: StudySpec) => { delete value.research_question; }, "QUESTION_REQUIRED"],
  ["population", (value: StudySpec) => { delete value.population; }, "POPULATION_REQUIRED"],
  ["time zero", (value: StudySpec) => { delete value.index_time; }, "TIME_ZERO_REQUIRED"],
  ["input", (value: StudySpec) => { delete value.exposure_or_predictors; }, "INPUT_REQUIRED"],
  ["outcome", (value: StudySpec) => { delete value.outcome; }, "OUTCOME_REQUIRED"],
  ["outcome structure", (value: StudySpec) => { delete value.outcome_structure; }, "OUTCOME_STRUCTURE_REQUIRED"],
  ["outcome window", (value: StudySpec) => { value.time_windows = []; }, "OUTCOME_WINDOW_REQUIRED"],
  ["estimand", (value: StudySpec) => { delete value.estimand; }, "ESTIMAND_REQUIRED"],
  ["analysis family", (value: StudySpec) => { delete value.analysis_family; }, "ANALYSIS_FAMILY_REQUIRED"],
] as const) {
  test(`requires clarification for missing ${name}`, () => {
    const value = completeSpec();
    mutate(value);
    const result = assessResearchProtocol(value);
    assert.equal(result.status, "needs_clarification");
    assert.ok(result.requirements.some((requirement) => requirement.code === code && requirement.severity === "required"));
  });
}

test("rejects a prediction input labeled as exposure", () => {
  const value = completeSpec();
  value.intent_family = "prediction";
  value.analysis_family = "binary_prediction";
  const result = assessResearchProtocol(value);
  assert.ok(result.requirements.some(({ code }) => code === "INPUT_ROLE_MISMATCH"));
});

test("rejects a time window ending before it begins", () => {
  const value = completeSpec();
  value.time_windows = [{ purpose: "outcome", anchor: "index_time", start_offset: 2, end_offset: 1, unit: "day" }];
  const result = assessResearchProtocol(value);
  assert.ok(result.requirements.some(({ code }) => code === "INVALID_TIME_WINDOW"));
});

test("requires an effect modifier to reference a mapped association or treatment covariate", () => {
  const value = completeSpec();
  value.effect_modifiers = [{ variable_name: "Sex", analysis: "interaction_and_stratified", report_levels: ["Female", "Male"] }];
  assert.ok(assessResearchProtocol(value).requirements.some(({ code }) => code === "EFFECT_MODIFIER_VARIABLE_MISSING"));
  value.intent_family = "treatment_effect"; value.analysis_family = "propensity_weighted_treatment_effect";
  assert.ok(assessResearchProtocol(value).requirements.some(({ code }) => code === "EFFECT_MODIFIER_VARIABLE_MISSING"));
  value.covariates = [...(value.covariates ?? []), { name: "Sex", role: "covariate", operational_definition: "Administrative sex at baseline", definition: { condition_id: "covariate.sex", source_text: "Administrative sex at baseline", kind: "concept", concept: "administrative sex", assertion: "present" } }];
  assert.equal(assessResearchProtocol(value).requirements.some(({ code }) => code.startsWith("EFFECT_MODIFIER_")), false);
});

test("allows an association interaction with a mapped effect modifier", () => {
  const spec = structuredClone(completeSpec());
  spec.intent_family = "association";
  spec.analysis_family = "association";
  spec.covariates = [{ name: "Sex", role: "covariate", operational_definition: "Recorded sex", definition: { condition_id: "covariate.sex", source_text: "Recorded sex", kind: "concept", concept: "administrative sex", assertion: "present" } }];
  spec.effect_modifiers = [{ variable_name: "Sex", analysis: "interaction_and_stratified", report_levels: ["Female", "Male"] }];
  assert.equal(assessResearchProtocol(spec).requirements.some(({ code }) => code === "EFFECT_MODIFIER_PURPOSE_MISMATCH"), false);
});

test("blocks narrative-only population definitions before confirmation", () => {
  const value = completeSpec();
  value.population = { description: "Adult ICU admissions" };
  value.covariates = [];
  value.assumptions = [];
  const result = assessResearchProtocol(value);
  assert.equal(result.status, "needs_clarification");
  assert.ok(result.requirements.some(({ code, severity }) => code === "STRUCTURED_POPULATION_REQUIRED" && severity === "required"));
});

test("requires structured definitions for every mapped variable", () => {
  const value = completeSpec();
  delete value.exposure_or_predictors![0]!.definition;
  delete value.outcome!.definition;
  delete value.covariates![0]!.definition;
  const codes = assessResearchProtocol(value).requirements.map(({ code }) => code);
  assert.ok(codes.includes("STRUCTURED_INPUT_REQUIRED"));
  assert.ok(codes.includes("STRUCTURED_OUTCOME_REQUIRED"));
  assert.ok(codes.includes("STRUCTURED_COVARIATE_RECOMMENDED"));
  assert.equal(assessResearchProtocol(value).requirements.find(({ code }) => code === "STRUCTURED_COVARIATE_RECOMMENDED")?.severity, "recommended");
});
