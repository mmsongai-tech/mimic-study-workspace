import assert from "node:assert/strict";
import test from "node:test";
import { AnalysisPlanningService, assessStatisticalDiagnostics, selectStatisticalMethod } from "../index.js";
import type { ResearchIntent, StudySpec } from "../../research-design/study-spec.js";
import type { MimicMappingResult } from "../../mimic-concept-mapping/domain/mimic-concept.js";

const mapping = (blocking_requirements: string[] = []): MimicMappingResult => ({
  schema_version: "1.0.0",
  data_model: "MIMIC-IV",
  matches: [],
  blocking_requirements,
});
const clinicalConcepts = { status: "ready_for_source_mapping" as const, resolutions: [], blocking_requirements: [] };

const spec = (intent_family: ResearchIntent): StudySpec => ({
  schema_version: "1.0.0",
  intent_family,
  analysis_family: intent_family === "prediction" ? "binary_prediction"
    : intent_family === "treatment_effect" ? "propensity_weighted_treatment_effect" : "association",
});

for (const family of ["association", "prediction", "treatment_effect"] as const) {
  test(`creates a reviewable ${family} statistical plan`, () => {
    const result = new AnalysisPlanningService().plan({
      study_spec: spec(family),
      mapping: mapping(),
      clinical_concepts: clinicalConcepts,
      generated_execution_enabled: true,
    });
    assert.equal(result.status, "ready_for_confirmation");
    assert.equal(result.execution_mode, "guarded_generated");
    assert.equal(result.method.study_family, family);
    assert.ok(result.method.required_conditions.length >= 5);
    assert.ok(result.method.required_diagnostics.length >= 5);
  });
}

for (const family of ["association", "prediction", "treatment_effect"] as const) {
  test(`selects a time-to-event method within ${family}`, () => {
    const result = new AnalysisPlanningService().plan({
      study_spec: { ...spec(family), outcome_structure: "time_to_event" },
      mapping: mapping(),
      clinical_concepts: clinicalConcepts,
      generated_execution_enabled: true,
    });
    assert.equal(result.method.study_family, family);
    assert.equal(result.method.outcome_structure, "time_to_event");
    assert.match(result.method.primary_method, /time-to-event/iu);
    assert.ok(result.method.required_diagnostics.includes("Numbers at risk"));
  });
}

test("prefers an exact registered capability over generated execution", () => {
  const result = new AnalysisPlanningService().plan({
    study_spec: spec("association"),
    mapping: mapping(),
    clinical_concepts: clinicalConcepts,
    registered_capability_id: "association.lactate.in_hospital_mortality.v1",
    generated_execution_enabled: true,
  });
  assert.equal(result.execution_mode, "registered");
});

test("blocks generated execution until MIMIC dictionary requirements are resolved", () => {
  const result = new AnalysisPlanningService().plan({
    study_spec: spec("association"),
    mapping: mapping(["Dictionary resolution required for fluid_balance"]),
    clinical_concepts: clinicalConcepts,
    generated_execution_enabled: true,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.execution_mode, "none");
});

test("blocks even a registered executor when the clinical concept is undefined", () => {
  const result = new AnalysisPlanningService().plan({
    study_spec: spec("association"),
    mapping: mapping(),
    clinical_concepts: {
      status: "needs_clarification",
      resolutions: [],
      blocking_requirements: ["Define exposure: undefined biomarker"],
    },
    registered_capability_id: "association.lactate.in_hospital_mortality.v1",
    generated_execution_enabled: true,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.execution_mode, "none");
  assert.deepEqual(result.blocking_requirements, ["Define exposure: undefined biomarker"]);
});

for (const family of ["association", "prediction", "treatment_effect"] as const) {
  for (const outcome of ["binary", "continuous", "count", "time_to_event", "repeated_measure", "competing_risk"] as const) {
    test(`registers an explicit ${family} method for ${outcome}`, () => {
      const method = selectStatisticalMethod({ ...spec(family), outcome_structure: outcome });
      assert.equal(method.study_family, family);
      assert.equal(method.outcome_structure, outcome);
      assert.match(method.method_id, new RegExp(`^${family}\\.${outcome}\\.v1$`, "u"));
      assert.ok(method.rationale.length > 40);
      assert.ok(method.alternative_methods.length >= 2);
      assert.ok(method.required_conditions.length >= 5);
      assert.ok(method.required_diagnostics.length >= 6);
      assert.ok(method.sensitivity_analyses.length >= 3);
      assert.ok(method.blocking_diagnostic_codes.length >= 2);
      assert.ok(method.minimum_report_sections.length >= 9);
    });
  }
}

test("blocks interpretation when a critical diagnostic fails", () => {
  const method = selectStatisticalMethod({ ...spec("association"), outcome_structure: "binary" });
  const observations = method.blocking_diagnostic_codes.map((code) => ({
    code,
    state: code === "model_convergence" ? "fail" as const : "pass" as const,
    summary: code === "model_convergence" ? "The fitted model did not converge." : "Passed.",
  }));
  const result = assessStatisticalDiagnostics(method, observations);
  assert.equal(result.decision, "blocked");
  assert.match(result.blocking_reasons.join(" "), /did not converge/iu);
});

test("allows a report with warnings for a non-critical diagnostic", () => {
  const method = selectStatisticalMethod({ ...spec("association"), outcome_structure: "binary" });
  const observations = [
    ...method.blocking_diagnostic_codes.map((code) => ({ code, state: "pass" as const, summary: "Passed." })),
    { code: "influence", state: "warning" as const, summary: "A small number of influential observations require sensitivity analysis." },
  ];
  const result = assessStatisticalDiagnostics(method, observations);
  assert.equal(result.decision, "reportable_with_warnings");
});

test("blocks interpretation when a required critical diagnostic was not evaluated", () => {
  const method = selectStatisticalMethod({ ...spec("treatment_effect"), outcome_structure: "binary" });
  const result = assessStatisticalDiagnostics(method, []);
  assert.equal(result.decision, "blocked");
  assert.ok(result.blocking_reasons.some((reason) => reason.includes("propensity_overlap")));
});
