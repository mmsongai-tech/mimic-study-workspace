import assert from "node:assert/strict";
import test from "node:test";
import { loadSavedObjectiveInterpretation, type ObjectiveCoverageReview, type ResearchObjectiveList } from "./index.js";

const question = "Compare treatment with no treatment for mortality.";
const objectiveList: ResearchObjectiveList = {
  schema_version: "1.0.0",
  original_question: question,
  objectives: [{ objective_id: "mortality", purpose: "treatment_effect", relationship: "primary", question, population: "hospital patients", exposure_or_predictors: ["treatment"], comparator: "no treatment", outcome: "mortality", effect_modifiers: [], source_claims: [question] }],
  ambiguities: [],
};
const coverage: ObjectiveCoverageReview = { schema_version: "1.0.0", decision: "pass", covered_claims: [question], missing_claims: [], altered_claims: [], unsupported_additions: [], explanation: "The source claim is preserved." };

test("loads a validated saved interpretation for the exact original question", () => {
  const result = loadSavedObjectiveInterpretation(JSON.stringify({ objective_list: objectiveList, coverage_review: coverage }), question);
  assert.deepEqual(result.objective_list, objectiveList);
  assert.deepEqual(result.coverage, coverage);
  assert.deepEqual(result.audit, []);
});

test("rejects cross-question reuse and invalid saved contracts", () => {
  assert.throws(() => loadSavedObjectiveInterpretation(JSON.stringify({ objective_list: objectiveList, coverage_review: coverage }), "another question"), /QUESTION_MISMATCH/u);
  assert.throws(() => loadSavedObjectiveInterpretation(JSON.stringify({ objective_list: {}, coverage_review: coverage }), question), /SCHEMA_INVALID/u);
});
