import assert from "node:assert/strict";
import test from "node:test";
import { assessAnalysisObjectiveContract, assessResearchProtocol, JsonSchemaResearchDesignValidator, objectivePreservationIssues, projectAnalysisObjective } from "../index.js";
import { explicitDerivedVariableRequest } from "../../variable-mapping/derived-variable-mapping.js";
import { syntheticObjectiveStudy } from "./analysis-objectives-fixture.js";

test("explicit independent objectives preserve different scales and windows", () => {
  const spec = syntheticObjectiveStudy(); const validator = new JsonSchemaResearchDesignValidator();
  assert.deepEqual(validator.checkStudySpec(spec), []);
  assert.equal(validator.isConfirmedExecutableStudy(spec), true);
  assert.equal(assessResearchProtocol(spec).status, "complete");
  const children = spec.analysis_objectives!.objectives.map((item) => projectAnalysisObjective(spec, item));
  assert.deepEqual(children.map(({ outcome_structure }) => outcome_structure), ["continuous", "binary"]);
  assert.ok(children.every((child) => !child.analysis_objectives));
  assert.equal(children[1]!.time_windows!.some((window) => "end_event" in window), true);
});

test("missing requested objective cannot be confirmed or erased by a continuation", () => {
  const spec = syntheticObjectiveStudy(); const next = structuredClone(spec);
  next.analysis_objectives!.objectives.pop();
  assert.ok(assessAnalysisObjectiveContract(next).some(({ code }) => code === "OBJECTIVE_NOT_COVERED"));
  assert.equal(new JsonSchemaResearchDesignValidator().isConfirmedExecutableStudy(next), false);
  next.analysis_objectives!.requested.pop();
  assert.ok(objectivePreservationIssues(spec, next).length);
});

test("continuous outcomes reject arbitrary predicates rather than magic-number exceptions", () => {
  for (const value of [-999, 0, 42]) {
    const spec = syntheticObjectiveStudy();
    spec.analysis_objectives!.objectives[0]!.outcome.definition = { condition_id: "bad", source_text: "Measurement", kind: "numeric_comparison", concept: "Measurement A", operator: "gte", value };
    assert.ok(assessAnalysisObjectiveContract(spec).some(({ code }) => code === "CONTINUOUS_VALUE_AS_PREDICATE"));
    assert.equal(new JsonSchemaResearchDesignValidator().isConfirmedExecutableStudy(spec), false);
  }
});

test("frozen continuous scale and explicit derivation cannot be replaced by a binary result", () => {
  const spec = syntheticObjectiveStudy();
  const objective = spec.analysis_objectives!.objectives[0]!;
  objective.outcome_structure = "binary"; delete objective.outcome.derivation;
  const codes = assessAnalysisObjectiveContract(spec).map(({ code }) => code);
  assert.ok(codes.includes("OBJECTIVE_SCALE_CHANGED")); assert.ok(codes.includes("OBJECTIVE_DERIVATION_REQUIRED"));
});

test("explicit derivation is independent of display labels and detects conflicting windows", () => {
  const spec = syntheticObjectiveStudy(); const variable = spec.analysis_objectives!.objectives[0]!.outcome;
  const derived = explicitDerivedVariableRequest(variable.name, variable.derivation!);
  assert.equal(derived.source_term, "Measurement A"); assert.deepEqual(derived.directions, ["baseline_minus_follow_up"]);
  assert.equal(derived.aggregation, "mean");
  variable.derivation!.baseline = { purpose: "baseline", anchor: "index_time", start_offset: -48, end_offset: 0, unit: "hour" };
  assert.ok(assessAnalysisObjectiveContract(spec).some(({ code }) => code === "DERIVATION_WINDOW_CONFLICT"));
});

test("a true composite event stays one objective and legacy single-outcome contracts remain readable", () => {
  const spec = syntheticObjectiveStudy(); const objective = spec.analysis_objectives!.objectives[1]!;
  const leaf = objective.outcome.definition!;
  objective.outcome.definition = { condition_id: "composite", source_text: "Event B or C", kind: "any", operands: [leaf, { ...leaf, condition_id: "event_c", source_text: "Event C" }] };
  spec.analysis_objectives!.requested = [spec.analysis_objectives!.requested[1]!]; spec.analysis_objectives!.objectives = [objective];
  assert.deepEqual(assessAnalysisObjectiveContract(spec), []);
  const child = projectAnalysisObjective(spec, objective);
  assert.equal(child.outcome!.definition!.kind, "any");
  assert.deepEqual(new JsonSchemaResearchDesignValidator().checkStudySpec(child), []);
});
