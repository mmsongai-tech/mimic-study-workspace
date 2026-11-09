import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryDesignSessionRepository, createResearchDesignService } from "../index.js";
import type { ResearchDesignModel } from "../index.js";
import type { OutcomeStructure, ResearchIntent, StudySpec } from "../study-spec.js";

const cases: Array<{ name: string; question: string; intent: ResearchIntent; analysis: NonNullable<StudySpec["analysis_family"]>; outcomeStructure: OutcomeStructure }> = [
  { name: "binary association", question: "研究乳酸与院内死亡之间的关联。", intent: "association", analysis: "association", outcomeStructure: "binary" },
  { name: "binary prediction", question: "预测 ICU 入科后 24 小时内机械通气。", intent: "prediction", analysis: "binary_prediction", outcomeStructure: "binary" },
  { name: "binary treatment effect", question: "评估早期升压药对院内死亡的治疗效果。", intent: "treatment_effect", analysis: "propensity_weighted_treatment_effect", outcomeStructure: "binary" },
  { name: "survival association", question: "研究 SOFA 评分与 ICU 出院时间之间的关联。", intent: "association", analysis: "time_to_event_association", outcomeStructure: "time_to_event" },
  { name: "survival prediction", question: "预测 ICU 患者 30 天死亡时间。", intent: "prediction", analysis: "time_to_event_prediction", outcomeStructure: "time_to_event" },
  { name: "survival treatment effect", question: "评估早期升压药对 28 天生存的治疗效果。", intent: "treatment_effect", analysis: "time_to_event_treatment_effect", outcomeStructure: "time_to_event" },
];

const modelFor = (item: typeof cases[number]): ResearchDesignModel => ({
  propose: async () => ({
    assistant_message: "Review the proposed design.",
    intent_assessment: { recommended_intent: item.intent, confidence: "high", reason: "The purpose is explicit.", alternative_intents: [], clarification_required: false, clarifying_question: null },
    spec_patch: [
      { op: "replace", path: "/intent_family", value: item.intent },
      { op: "add", path: "/title", value: item.name },
      { op: "add", path: "/research_question", value: item.question },
      { op: "add", path: "/population", value: { description: "Adult ICU admissions", criteria: { condition_id: "population.adult_icu", source_text: "Adult ICU admissions", kind: "concept", concept: "adult ICU admission", assertion: "present" } } },
      { op: "add", path: "/index_time", value: { event: "ICU admission", selection_rule: "First eligible ICU admission" } },
      { op: "add", path: "/exposure_or_predictors", value: [{ name: "Prespecified input", role: item.intent === "prediction" ? "predictor" : "exposure", operational_definition: "Defined before analysis", definition: { condition_id: "input.prespecified", source_text: "Prespecified input", kind: "concept", concept: "prespecified input", assertion: "present" } }] },
      { op: "add", path: "/outcome", value: { name: "Prespecified outcome", role: "outcome", operational_definition: "Defined before analysis", definition: { condition_id: "outcome.prespecified", source_text: "Prespecified outcome", kind: "event_exists", concept: "prespecified outcome", occurrence: "present" } } },
      { op: "add", path: "/outcome_structure", value: item.outcomeStructure },
      { op: "add", path: "/time_windows", value: [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 30, unit: "day" }] },
      { op: "add", path: "/estimand", value: { target_population: "Adult ICU admissions", exposure_contrast: "Prespecified contrast", outcome_measure: "Prespecified outcome", summary_measure: item.outcomeStructure === "time_to_event" ? "Time-to-event estimate" : "Adjusted estimate" } },
      { op: "add", path: "/analysis_family", value: item.analysis },
    ],
    assumptions: [], clarifying_questions: [], warnings: [], suggestions: [], readiness: "candidate_ready",
  }),
});

for (const item of cases) {
  test(`keeps ${item.name} within a three-purpose contract`, async () => {
    const service = createResearchDesignService(modelFor(item), createInMemoryDesignSessionRepository());
    const view = await service.start({ message: item.question, client_request_id: item.name });
    assert.equal(view.study_spec.intent_family, item.intent);
    assert.equal(view.study_spec.analysis_family, item.analysis);
    assert.equal(view.study_spec.outcome_structure, item.outcomeStructure);
  });
}
