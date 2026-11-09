import assert from "node:assert/strict";
import test from "node:test";
import { patientFlow } from "../patient-flow.js";

test("the patient flow runs from every unit assessed down to the cohort, step by step", () => {
  // The statin run of 2026-10-14: units that ended before the follow-up start leave first, whatever their diagnosis.
  const steps = patientFlow({ analysis_units: 546_028, exclusion_reasons: { ended_before_landmark: 120_812, not_in_population: 409_469, not_first_eligible_unit_of_patient: 3_041, incomplete_model_variables: 526 } });
  assert.deepEqual(steps.map(({ key }) => key), ["ended_before_landmark", "not_in_population", "not_first_eligible_unit_of_patient"]);
  assert.equal(steps.at(-1)!.remaining, 12_706, "the last step lands on the cohort size");
  assert.ok(!steps.some(({ key }) => key === "incomplete_model_variables"), "the model's own complete-case exclusion is not a step before the cohort");
});

test("a step with no exclusions is left out and nothing goes below zero", () => {
  assert.deepEqual(patientFlow({ analysis_units: 10, exclusion_reasons: { not_in_population: 4 } }).map(({ remaining }) => remaining), [6]);
  assert.deepEqual(patientFlow({ analysis_units: 10 }), []);
});

test("a prediction's unit that already had the outcome at the prediction time leaves after those that ended before it", () => {
  const steps = patientFlow({ analysis_units: 100, exclusion_reasons: { not_in_population: 10, outcome_before_prediction_time: 5, ended_before_landmark: 3 } });
  assert.deepEqual(steps.map(({ key, remaining }) => [key, remaining]), [["ended_before_landmark", 97], ["outcome_before_prediction_time", 92], ["not_in_population", 82]]);
});
