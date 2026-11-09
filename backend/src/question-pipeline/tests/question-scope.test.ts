import assert from "node:assert/strict";
import test from "node:test";
import type { ClinicalDatabaseCatalog } from "../../clinical-database/index.js";
import type { StudyVariableMappingReview, VariableMappingRecord } from "../../variable-mapping/index.js";
import { buildFrames, type FrameExtraction, type StudyFrame } from "../../study-framing/index.js";
import { RStudyMethodExecutor } from "../../study-analysis/index.js";
import { resolveBackendRuntimeConfig } from "../../runtime/index.js";
import { lockQuestionPlan, PlanLockError, QuestionPipelineService } from "../index.js";

// The release's question scope is a rule on study types: an aim of an excluded type is not planned and is reported with the
// reason; the other aims of the same question are planned as usual. Synthetic frames and mappings only, no patient data.
const catalog: ClinicalDatabaseCatalog = { schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "local", inspected_at: "2026-11-09T00:00:00.000Z", relation_count: 2, column_count: 8, relations: [
  { schema: "mimiciv_hosp", name: "admissions", relation_type: "table", columns: ["subject_id", "hadm_id", "admittime", "hospital_expire_flag", "exposed"].map((name) => ({ name, data_type: "text", nullable: false })) },
  { schema: "mimiciv_hosp", name: "patients", relation_type: "table", columns: ["subject_id", "anchor_age", "gender"].map((name) => ({ name, data_type: "text", nullable: false })) },
] };
const record = (id: string, table: string, columns: string[], value_type: VariableMappingRecord["value_type"], category: VariableMappingRecord["category"] = "outcome"): VariableMappingRecord => ({ schema_version: "1.0.0", mapping_id: id, concept_id: id, mapping_version: "1", labels: { en: id }, synonyms: [], category, value_type, definition: { summary: id, temporal_rule: "At admission", value_rule: "Source value", missingness_rule: "Exclude missing" }, sources: [{ kind: "direct_field", schema: "mimiciv_hosp", table, columns }], status: "validated", provenance: "team_validation", evidence: {}, created_at: "2026-11-09T00:00:00.000Z", updated_at: "2026-11-09T00:00:00.000Z" });
const resolved = (role: StudyVariableMappingReview["variables"][number]["role"], mapping: VariableMappingRecord): StudyVariableMappingReview["variables"][number] => ({ schema_version: "1.0.0", requested_term: mapping.labels.en, role, status: "resolved", candidates: [{ candidate_id: mapping.mapping_id, requested_term: mapping.labels.en, normalized_term: mapping.labels.en, role, mapping, match_basis: ["validated_mapping"], confidence: "high", requires_clinician_confirmation: false, explanation: "validated" }] });
const population = record("Hospitalized patient", "admissions", ["subject_id", "hadm_id"], "categorical", "encounter");
const review: StudyVariableMappingReview = { schema_version: "1.0.0", status: "ready", summary: { resolved: 6, needs_confirmation: 0, unmapped: 0 }, verification_available: true, variables: [
  { ...resolved("population", population), condition_id: "population.target", semantic_condition: { condition_id: "population.target", source_text: "住院患者", kind: "concept" as const, concept: "Hospitalized patient", assertion: "present" as const } },
  resolved("index_time", record("hospital admission", "admissions", ["subject_id", "hadm_id", "admittime"], "categorical", "encounter")),
  resolved("exposure", record("Drug", "admissions", ["subject_id", "hadm_id", "exposed"], "binary", "medication")),
  resolved("outcome", record("Death", "admissions", ["subject_id", "hadm_id", "hospital_expire_flag"], "binary")),
  resolved("covariate", record("Age", "patients", ["subject_id", "anchor_age"], "continuous", "demographic")),
  resolved("covariate", record("Sex", "patients", ["subject_id", "gender"], "categorical", "demographic")),
] };
const extraction = (overrides: Partial<FrameExtraction>): FrameExtraction => ({ goal: "evaluate_treatment", outcome_kind: "event", dose_question: false, population: "住院患者", exposure: "某药", exposure_categories: [], comparator: "不用某药", outcomes: ["死亡"], composite_outcome: "", modifiers: [], mediators: [], predictors: [], time_window: "", ...overrides });
const serviceFor = (question: string, frames: StudyFrame[]) => new QuestionPipelineService({
  framing: { frame: async () => ({ frame_set: { schema_version: "1.0.0", original_question: question, frames: structuredClone(frames) }, audits: [] }) }, model: "test-model", data_source: { id: "simulated", version: "test" },
  catalog, archive_path: "/unused.zip", mapping: { assess: async () => review }, runner: { run: async () => { throw new Error("A draft reads no patient data."); } }, executor: new RStudyMethodExecutor({ timeout_ms: 1_000 }), output_dir: "/unused",
  allowed_study_types: resolveBackendRuntimeConfig().question_scope.allowed_study_types,
});

test("a mixed question keeps its main aim and reports the excluded part with the reason", async () => {
  const question = "住院患者使用某药与不用某药的死亡差异，以及性别是否改变该效应";
  const frames = [
    ...buildFrames({ question, sub_question: "住院患者使用某药与不用某药的死亡差异", first_id: 1, extraction: extraction({}) }),
    ...buildFrames({ question, sub_question: "性别是否改变某药对死亡的效应", first_id: 2, aim: "effect_modification", extraction: extraction({ modifiers: ["性别"] }) }),
  ];
  assert.deepEqual(frames.map(({ study_type, status }) => [study_type, status]), [["treatment_effect", "ready"], ["effect_modification", "ready"]]);
  const draft = await serviceFor(question, frames).draft(question);
  assert.ok(draft.plans.length > 0 && draft.plans.every(({ plan }) => plan.frame_id === "f1"), "only the main aim is planned");
  assert.ok(draft.plans.some(({ status }) => status === "ready"));
  assert.deepEqual(draft.unanswered_frames.map(({ frame }) => frame.frame_id), ["f2"]);
  assert.equal(draft.unanswered_frames[0]!.frame.ambiguities[0]!.code, "STUDY_TYPE_NOT_SUPPORTED");
  assert.deepEqual(draft.unanswered_frames[0]!.reasons[0], {
    en: "This version does not support this kind of analysis (whether a subgroup or sex changes the effect); the rest of the question is analysed as usual.",
    zh: "本版本暂不支持此类分析（亚组或性别是否改变疗效），其余部分照常分析。",
  });
  assert.doesNotThrow(() => lockQuestionPlan(draft, {}, "user"));
});

test("a treatment question adjusted for named variables is planned, not refused as effect modification", async () => {
  // The local model filed the adjusted-for variables as effect modifiers (final review probe); they are adjustment only.
  const question = "住院患者中，校正年龄、性别后，使用某药与不用某药相比，死亡有何差异？";
  const frames = buildFrames({ question, sub_question: question, first_id: 1, aim: "effect_modification", extraction: extraction({ modifiers: ["年龄", "性别"] }) });
  assert.deepEqual(frames.map(({ study_type, status }) => [study_type, status]), [["treatment_effect", "ready"]]);
  const draft = await serviceFor(question, frames).draft(question);
  assert.ok(draft.plans.length > 0 && draft.plans.some(({ status }) => status === "ready"));
  assert.deepEqual(draft.unanswered_frames, []);
  assert.ok(draft.plans.every(({ plan }) => !plan.study_spec.effect_modifiers?.length), "no interaction analysis is planned");
});

test("a question with only excluded kinds gives no runnable plan, the reason, and the way to rewrite it", async () => {
  const question = "住院患者某药的剂量与死亡的关系，以及其中有多少通过血压实现";
  const frames = [
    ...buildFrames({ question, sub_question: "住院患者某药的剂量与死亡的关系", first_id: 1, extraction: extraction({ goal: "relate_factor", comparator: "", dose_question: true }) }),
    ...buildFrames({ question, sub_question: "某药对死亡的影响有多少通过血压实现", first_id: 2, aim: "mediation", extraction: extraction({ mediators: ["血压"] }) }),
  ];
  assert.deepEqual(frames.map(({ study_type }) => study_type), ["dose_response", "mediation"]);
  const draft = await serviceFor(question, frames).draft(question);
  assert.equal(draft.plans.length, 0);
  assert.deepEqual(draft.unanswered_frames.map(({ reasons }) => reasons[0]!.zh), [
    "本版本暂不支持此类分析（剂量-反应）。请从本版本支持的问题类型中选一类，按格式改写后重新提交。",
    "本版本暂不支持此类分析（中介分析）。请从本版本支持的问题类型中选一类，按格式改写后重新提交。",
  ]);
  assert.match(draft.unanswered_frames[1]!.reasons[0]!.en, /does not support this kind of analysis \(mediation\)\. Choose one of the kinds of question/u);
  assert.throws(() => lockQuestionPlan(draft, {}, "user"), PlanLockError);
});

test("without a configured scope every study type is planned as before", async () => {
  const question = "性别是否改变某药对死亡的效应";
  const frames = buildFrames({ question, sub_question: question, first_id: 1, aim: "effect_modification", extraction: extraction({ modifiers: ["性别"] }) });
  const service = new QuestionPipelineService({
    framing: { frame: async () => ({ frame_set: { schema_version: "1.0.0", original_question: question, frames }, audits: [] }) }, model: "test-model", data_source: { id: "simulated", version: "test" },
    catalog, archive_path: "/unused.zip", mapping: { assess: async () => review }, runner: { run: async () => { throw new Error("unused"); } }, executor: new RStudyMethodExecutor({ timeout_ms: 1_000 }), output_dir: "/unused",
  });
  const draft = await service.draft(question);
  assert.equal(draft.unanswered_frames.length, 0);
  assert.ok(draft.plans.length > 0);
});

test("an excluded aim shows only the scope reason, not its other reasons", async () => {
  const question = "住院患者使用某药与不用某药的死亡差异，以及性别是否改变某药的疗效";
  const frames = [
    ...buildFrames({ question, sub_question: "住院患者使用某药与不用某药的死亡差异", first_id: 1, extraction: extraction({}) }),
    ...buildFrames({ question, sub_question: "性别是否改变某药的疗效", first_id: 2, aim: "effect_modification", extraction: extraction({ modifiers: ["性别"], outcomes: ["疗效"] }) }),
  ];
  assert.deepEqual(frames[1]!.ambiguities.map(({ code }) => code), ["SLOT_MISSING", "VAGUE_OUTCOME"], "the excluded aim also has other reasons");
  const draft = await serviceFor(question, frames).draft(question);
  const [excluded] = draft.unanswered_frames;
  assert.equal(excluded!.frame.frame_id, "f2");
  assert.deepEqual(excluded!.reasons, [{
    en: "This version does not support this kind of analysis (whether a subgroup or sex changes the effect); the rest of the question is analysed as usual.",
    zh: "本版本暂不支持此类分析（亚组或性别是否改变疗效），其余部分照常分析。",
  }]);
  // The other reasons stay on the saved aim for the record; they are only not shown.
  assert.deepEqual(excluded!.frame.ambiguities.map(({ code }) => code), ["STUDY_TYPE_NOT_SUPPORTED", "SLOT_MISSING", "VAGUE_OUTCOME"]);
});

test("the rest is said to be analysed only when another aim is in scope and ready", async () => {
  const question = "住院患者使用某药的差异，以及性别是否改变某药对死亡的效应";
  const frames = [
    ...buildFrames({ question, sub_question: "住院患者使用某药的差异", first_id: 1, extraction: extraction({ outcomes: [] }) }),
    ...buildFrames({ question, sub_question: "性别是否改变某药对死亡的效应", first_id: 2, aim: "effect_modification", extraction: extraction({ modifiers: ["性别"] }) }),
  ];
  assert.deepEqual(frames.map(({ study_type, status }) => [study_type, status]), [["treatment_effect", "needs_clarification"], ["effect_modification", "ready"]]);
  const draft = await serviceFor(question, frames).draft(question);
  assert.equal(draft.plans.length, 0);
  const excluded = draft.unanswered_frames.find(({ frame }) => frame.frame_id === "f2")!;
  assert.deepEqual(excluded.reasons, [{
    en: "This version does not support this kind of analysis (whether a subgroup or sex changes the effect). Choose one of the kinds of question this version supports and rewrite the question in its format.",
    zh: "本版本暂不支持此类分析（亚组或性别是否改变疗效）。请从本版本支持的问题类型中选一类，按格式改写后重新提交。",
  }]);
});

test("planning again from saved aims (re-analysis, --from-run) does not add the scope reason twice", async () => {
  const question = "住院患者使用某药与不用某药的死亡差异，以及性别是否改变该效应";
  const frames = [
    ...buildFrames({ question, sub_question: "住院患者使用某药与不用某药的死亡差异", first_id: 1, extraction: extraction({}) }),
    ...buildFrames({ question, sub_question: "性别是否改变某药对死亡的效应", first_id: 2, aim: "effect_modification", extraction: extraction({ modifiers: ["性别"] }) }),
  ];
  const first = await serviceFor(question, frames).draft(question);
  const saved = first.frame_set.frames;
  const savedCodes = saved[1]!.ambiguities.map(({ code }) => code);
  assert.equal(savedCodes.filter((code) => code === "STUDY_TYPE_NOT_SUPPORTED").length, 1);
  const again = await serviceFor(question, saved).draft(question);
  const excluded = again.unanswered_frames.find(({ frame }) => frame.frame_id === "f2")!;
  assert.deepEqual(excluded.frame.ambiguities.map(({ code }) => code), savedCodes, "the saved aim's reasons, the scope reason once");
  assert.deepEqual(excluded.reasons, first.unanswered_frames[0]!.reasons);
  assert.equal(excluded.reasons.length, 1);
  assert.deepEqual(again.plans.map(({ plan }) => plan.plan_id), first.plans.map(({ plan }) => plan.plan_id));
});
