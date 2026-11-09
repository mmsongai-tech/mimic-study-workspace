import assert from "node:assert/strict";
import test from "node:test";
import { objectiveListCanProceed, validateCoverageConsistency, validateObjectiveCoverageReview, validateObjectiveIdentities, validateResearchObjectiveList, type ObjectiveCoverageReview, type ResearchObjectiveList } from "./index.js";

const list = { schema_version: "1.0.0", original_question: "比较治疗对血压和死亡的影响，并评估性别差异", objectives: [
  { objective_id: "bp", purpose: "treatment_effect", relationship: "primary", question: "治疗是否影响血压？", population: "目标人群", exposure_or_predictors: ["治疗"], comparator: "未治疗", outcome: "血压变化", effect_modifiers: [], source_claims: ["治疗对血压的影响"] },
  { objective_id: "death", purpose: "treatment_effect", relationship: "secondary", question: "治疗是否影响死亡？", population: "目标人群", exposure_or_predictors: ["治疗"], comparator: "未治疗", outcome: "死亡", effect_modifiers: [], source_claims: ["治疗对死亡的影响"] },
  { objective_id: "sex", purpose: "treatment_effect", relationship: "effect_modification", question: "性别是否修饰治疗作用？", population: "目标人群", exposure_or_predictors: ["治疗"], outcome: "血压和死亡", effect_modifiers: ["性别"], source_claims: ["性别差异"] },
] , ambiguities: [] } satisfies ResearchObjectiveList;

test("validates a strict multi-objective interpretation", () => {
  assert.deepEqual(validateResearchObjectiveList(list), []);
  assert.deepEqual(validateObjectiveIdentities(list), []);
});

test("fails closed when semantic coverage review reports an omitted target", () => {
  const review = { schema_version: "1.0.0", decision: "needs_review", covered_claims: ["治疗对血压的影响"], missing_claims: ["死亡结局"], altered_claims: [], unsupported_additions: [], explanation: "死亡目标被遗漏" } satisfies ObjectiveCoverageReview;
  assert.deepEqual(validateObjectiveCoverageReview(review), []);
  assert.equal(objectiveListCanProceed(list, review), false);
});

test("rejects duplicate objectives and incomplete effect modification", () => {
  const invalid: ResearchObjectiveList = structuredClone(list);
  invalid.objectives[1]!.objective_id = "bp";
  invalid.objectives[2]!.effect_modifiers = [];
  assert.equal(validateObjectiveIdentities(invalid).length, 2);
});

test("rejects contradictory coverage verdicts and duplicate ambiguity ids", () => {
  const contradictory = { schema_version: "1.0.0", decision: "pass", covered_claims: [], missing_claims: ["死亡结局"], altered_claims: [], unsupported_additions: [], explanation: "遗漏死亡" } satisfies ObjectiveCoverageReview;
  assert.equal(validateCoverageConsistency(contradictory).length, 1);
  const invalid: ResearchObjectiveList = structuredClone(list);
  invalid.ambiguities = [
    { ambiguity_id: "definition", question: "定义？", reason: "不明确", affected_objective_ids: ["bp"] },
    { ambiguity_id: "definition", question: "时间窗？", reason: "不明确", affected_objective_ids: ["death"] },
  ];
  assert.equal(validateObjectiveIdentities(invalid).length, 1);
});

test("rejects duplicate estimands even when the model assigns different relationships and ids", () => {
  const invalid: ResearchObjectiveList = structuredClone(list);
  invalid.objectives[1] = { ...invalid.objectives[0]!, objective_id: "duplicate", relationship: "secondary" };
  assert.match(validateObjectiveIdentities(invalid).join("\n"), /duplicates the estimand/u);
});

test("rejects an effect-modifier duplicate that also repeats the modifier as an input", () => {
  const invalid: ResearchObjectiveList = structuredClone(list);
  invalid.objectives = [
    { ...invalid.objectives[0]!, objective_id: "dose-sex", effect_modifiers: ["性别"] },
    { ...invalid.objectives[0]!, objective_id: "dose-sex-copy", relationship: "effect_modification", exposure_or_predictors: ["治疗", "性别"], effect_modifiers: ["性别"] },
  ];
  assert.match(validateObjectiveIdentities(invalid).join("\n"), /duplicates the estimand/u);
});
