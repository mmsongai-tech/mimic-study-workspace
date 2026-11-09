import assert from "node:assert/strict";
import test from "node:test";
import { selectStatisticalMethod } from "../analysis-planning/index.js";
import { ClinicalConceptCatalogService } from "../clinical-concept-catalog/index.js";
import type { StudySpec } from "../research-design/index.js";
import { researchQuestionGoldCases } from "./research-question-gold-cases.js";

test("gold set contains 30–50 distinct representative research questions", () => {
  assert.ok(researchQuestionGoldCases.length >= 30 && researchQuestionGoldCases.length <= 50);
  assert.equal(new Set(researchQuestionGoldCases.map(({ id }) => id)).size, researchQuestionGoldCases.length);
  assert.equal(new Set(researchQuestionGoldCases.map(({ question }) => question)).size, researchQuestionGoldCases.length);
});

test("gold set covers every purpose and outcome-structure combination", () => {
  const combinations = new Set(researchQuestionGoldCases.map(({ intent, outcome_structure }) => `${intent}:${outcome_structure}`));
  assert.equal(combinations.size, 18);
});

for (const item of researchQuestionGoldCases) {
  test(`validates gold research case ${item.id}`, () => {
    const spec: StudySpec = {
      schema_version: "1.0.0",
      intent_family: item.intent,
      research_question: item.question,
      outcome_structure: item.outcome_structure,
      exposure_or_predictors: [{
        name: item.exposure_or_predictor,
        role: item.intent === "prediction" ? "predictor" : "exposure",
        operational_definition: "Prespecified before analysis",
      }],
      outcome: { name: item.outcome, role: "outcome", operational_definition: "Prespecified before analysis" },
    };
    const concepts = new ClinicalConceptCatalogService().assessStudy(spec);
    const method = selectStatisticalMethod(spec);
    assert.equal(concepts.status, "ready_for_source_mapping");
    assert.deepEqual(concepts.resolutions.map(({ concept }) => concept?.id), item.expected_concepts);
    assert.equal(method.method_id, `${item.intent}.${item.outcome_structure}.v1`);
  });
}

