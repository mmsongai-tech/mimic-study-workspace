import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClinicalDatabaseCatalog } from "../../clinical-database/index.js";
import type { StudyVariableMappingReview, VariableMappingRecord } from "../../variable-mapping/index.js";
import { buildFrames, type FrameExtraction, type StudyFrameSet } from "../../study-framing/index.js";
import { RStudyMethodExecutor } from "../../study-analysis/index.js";
import { lockIsIntact, lockQuestionPlan, PlanLockError, QuestionPipelineService, type PlanExecutionDependencies } from "../index.js";

const catalog: ClinicalDatabaseCatalog = { schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "local", inspected_at: "2026-09-24T00:00:00.000Z", relation_count: 2, column_count: 6, relations: [
  { schema: "mimiciv_hosp", name: "admissions", relation_type: "table", columns: ["subject_id", "hadm_id", "admittime", "hospital_expire_flag", "exposed"].map((name) => ({ name, data_type: "text", nullable: false })) },
  { schema: "mimiciv_hosp", name: "patients", relation_type: "table", columns: ["subject_id", "anchor_age", "gender"].map((name) => ({ name, data_type: "text", nullable: false })) },
] };
const record = (id: string, table: string, columns: string[], value_type: VariableMappingRecord["value_type"], category: VariableMappingRecord["category"] = "outcome"): VariableMappingRecord => ({ schema_version: "1.0.0", mapping_id: id, concept_id: id, mapping_version: "1", labels: { en: id }, synonyms: [], category, value_type, definition: { summary: id, temporal_rule: "At admission", value_rule: "Source value", missingness_rule: "Exclude missing" }, sources: [{ kind: "direct_field", schema: "mimiciv_hosp", table, columns }], status: "validated", provenance: "team_validation", evidence: {}, created_at: "2026-09-24T00:00:00.000Z", updated_at: "2026-09-24T00:00:00.000Z" });
const resolved = (role: StudyVariableMappingReview["variables"][number]["role"], mapping: VariableMappingRecord): StudyVariableMappingReview["variables"][number] => ({ schema_version: "1.0.0", requested_term: mapping.labels.en, role, status: "resolved", candidates: [{ candidate_id: mapping.mapping_id, requested_term: mapping.labels.en, normalized_term: mapping.labels.en, role, mapping, match_basis: ["validated_mapping"], confidence: "high", requires_clinician_confirmation: false, explanation: "validated" }] });
const population = record("Hospitalized patient", "admissions", ["subject_id", "hadm_id"], "categorical", "encounter");
population.evidence.data_profile = { source_id: "mimiciv_hosp.admissions", matched_record_count: 600, missing_value_count: 0, distinct_value_count: 600, units: [], top_values: [], profiled_at: "2026-09-24T00:00:00.000Z" };
const populationVariable = { ...resolved("population", population), condition_id: "population.target", semantic_condition: { condition_id: "population.target", source_text: "住院患者", kind: "concept" as const, concept: "Hospitalized patient", assertion: "present" as const } };
const readyReview: StudyVariableMappingReview = { schema_version: "1.0.0", status: "ready", summary: { resolved: 6, needs_confirmation: 0, unmapped: 0 }, verification_available: true, variables: [
  populationVariable,
  resolved("index_time", record("hospital admission", "admissions", ["subject_id", "hadm_id", "admittime"], "categorical", "encounter")),
  resolved("exposure", record("Drug", "admissions", ["subject_id", "hadm_id", "exposed"], "binary", "medication")),
  resolved("outcome", record("Death", "admissions", ["subject_id", "hadm_id", "hospital_expire_flag"], "binary")),
  resolved("covariate", record("Age", "patients", ["subject_id", "anchor_age"], "continuous", "demographic")),
  resolved("covariate", record("Sex", "patients", ["subject_id", "gender"], "categorical", "demographic")),
] };

const simulatedRows = (n: number): Array<{ analysis_id: string } & Record<string, unknown>> => {
  let seed = 7; const random = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  return Array.from({ length: n }, (_, index) => {
    const age = 50 + Math.floor(40 * random()); const exposed = random() < 0.3 + 0.004 * (age - 50);
    return { analysis_id: String(index), exposure: exposed, outcome: random() < 0.1 + 0.003 * (age - 50) - 0.04 * Number(exposed), covariate_0: age, covariate_1: random() < 0.5 ? "M" : "F" };
  });
};
const runner = { run: async () => ({ rows: simulatedRows(600), columns: [
  { column: "exposure", role: "exposure" as const, requested_label: "Drug", mapping_id: "Drug", value_type: "binary" as const },
  { column: "outcome", role: "outcome" as const, requested_label: "Death", mapping_id: "Death", value_type: "binary" as const },
  { column: "covariate_0", role: "covariate" as const, requested_label: "Age", mapping_id: "Age", value_type: "continuous" as const },
  { column: "covariate_1", role: "covariate" as const, requested_label: "Sex", mapping_id: "Sex", value_type: "categorical" as const },
], quality: { source_rows: {}, analysis_units: 600, complete_rows: 600, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "sha256:simulated" }) };

const extraction = (overrides: Partial<FrameExtraction>): FrameExtraction => ({ goal: "evaluate_treatment", outcome_kind: "event", dose_question: false, population: "", exposure: "", exposure_categories: [], comparator: "", outcomes: [], composite_outcome: "", modifiers: [], mediators: [], predictors: [], time_window: "", ...overrides });

test("runs ready plans to a statistical result, blocks unmapped ones, and explains frames that need clarification", { timeout: 300_000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), "question-pipeline-test-"));
  try {
    const question = "住院患者使用某药与不用某药的死亡差异，以及生物标志物X的疗效";
    const frames = [
      ...buildFrames({ question, sub_question: "住院患者使用某药与不用某药的死亡差异", first_id: 1, extraction: extraction({ population: "住院患者", exposure: "某药", comparator: "不用某药", outcomes: ["死亡"] }) }),
      ...buildFrames({ question, sub_question: "住院患者使用罕见药与不用罕见药的死亡差异", first_id: 2, extraction: extraction({ population: "住院患者", exposure: "罕见药", comparator: "不用罕见药", outcomes: ["死亡"] }) }),
      ...buildFrames({ question, sub_question: "生物标志物X的疗效", first_id: 3, extraction: extraction({ goal: "relate_factor", exposure: "生物标志物X", outcomes: ["疗效"] }) }),
    ];
    const frameSet: StudyFrameSet = { schema_version: "1.0.0", original_question: question, frames };
    const mapping: PlanExecutionDependencies["mapping"] = { assess: async (spec) => spec.exposure_or_predictors?.[0]?.name === "罕见药"
      ? { ...readyReview, status: "blocked", summary: { resolved: 4, needs_confirmation: 0, unmapped: 1 }, variables: readyReview.variables.map((variable) => variable.role === "exposure" ? { ...variable, requested_term: "罕见药", status: "unmapped" as const, candidates: [], reason: "No dictionary entry." } : variable) }
      : readyReview };
    const progress: string[] = [];
    const service = new QuestionPipelineService({
      framing: { frame: async () => ({ frame_set: frameSet, audits: [] }) }, model: "test-model", data_source: { id: "simulated", version: "test" },
      catalog, archive_path: "/unused.zip", mapping, runner, executor: new RStudyMethodExecutor({ timeout_ms: 120_000 }), output_dir: output,
      on_plan: (outcome, index, total) => progress.push(`${index}/${total}:${outcome.status}`),
    });
    const result = await service.run(question);
    assert.deepEqual(progress, ["1/2:completed", "2/2:blocked"], JSON.stringify(result.plans.map(({ stage_reached, blockers }) => [stage_reached, blockers.map(({ code, message }) => `${code}: ${message.en}`)])));
    assert.deepEqual(result.summary, { frames: 3, plans: 2, completed: 1, blocked: 1, failed: 0, needs_clarification: 1 });
    const completed = result.plans[0]!;
    assert.equal(completed.chosen_method, "treatment.iptw");
    assert.equal(completed.method_options?.length, 3);
    assert.ok(completed.result?.estimates.some(({ measure }) => measure === "odds_ratio"));
    assert.equal(completed.cohort?.rows, 600);
    const blocked = result.plans[1]!;
    assert.equal(blocked.stage_reached, "mapping");
    assert.match(blocked.blockers[0]!.message.zh, /未在 MIMIC-IV 字典/u);
    assert.equal(result.unanswered_frames[0]!.frame.frame_id, "f3");
    assert.ok(result.unanswered_frames[0]!.reasons.some(({ zh }) => /笼统/u.test(zh)));
    assert.match(result.run_id, /^question-run:/u);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("honours a user method choice among the three options", { timeout: 300_000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), "question-pipeline-choice-"));
  try {
    const question = "住院患者使用某药与不用某药的死亡差异";
    const frameSet: StudyFrameSet = { schema_version: "1.0.0", original_question: question, frames: buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction({ population: "住院患者", exposure: "某药", comparator: "不用某药", outcomes: ["死亡"] }) }) };
    const service = new QuestionPipelineService({
      framing: { frame: async () => ({ frame_set: frameSet, audits: [] }) }, model: "test-model", data_source: { id: "simulated", version: "test" },
      catalog, archive_path: "/unused.zip", mapping: { assess: async () => readyReview }, runner, executor: new RStudyMethodExecutor({ timeout_ms: 120_000 }), output_dir: output,
      choose_method: (_plan, options) => options.find(({ method_id }) => method_id === "regression.adjusted")?.method_id,
    });
    const result = await service.run(question);
    assert.equal(result.plans[0]!.chosen_method, "regression.adjusted");
    assert.equal(result.plans[0]!.status, "completed");
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("uses one adjustment variable when two study variables resolve to the same mapping", async () => {
  const { methodConfigFor } = await import("../index.js");
  const plan = { plan_id: "f1", frame_id: "f1", study_spec: { schema_version: "1.0.0" as const, intent_family: "treatment_effect" as const, outcome_structure: "binary" as const }, roles: { mediators: [], modifiers: ["gender"], default_covariates: ["Age", "Sex"] } };
  const cohort = { rows: [], quality: { source_rows: {}, analysis_units: 0, complete_rows: 0, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "x", columns: [
    { column: "covariate_0", role: "covariate" as const, requested_label: "Age", mapping_id: "age", value_type: "continuous" as const },
    { column: "covariate_1", role: "covariate" as const, requested_label: "Sex", mapping_id: "sex", value_type: "categorical" as const },
    { column: "effect_modifier_0", role: "covariate" as const, requested_label: "gender", mapping_id: "sex", value_type: "categorical" as const },
  ] };
  const config = methodConfigFor(plan, cohort, "modification.interaction");
  assert.equal(config.modifier, "effect_modifier_0");
  assert.deepEqual(config.covariates, ["covariate_0", "effect_modifier_0"]);
});

test("drafts without reading data, locks the confirmed choices and runs the locked plan unattended", { timeout: 300_000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), "question-pipeline-lock-"));
  try {
    const question = "住院患者使用某药与不用某药的死亡差异";
    const frameSet: StudyFrameSet = { schema_version: "1.0.0", original_question: question, frames: buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction({ population: "住院患者", exposure: "某药", comparator: "不用某药", outcomes: ["死亡"] }) }) };
    let scans = 0; let mappings = 0;
    const service = new QuestionPipelineService({
      framing: { frame: async () => ({ frame_set: structuredClone(frameSet), audits: [] }) }, model: "test-model", data_source: { id: "simulated", version: "test" },
      catalog, archive_path: "/unused.zip", mapping: { assess: async () => { mappings += 1; return readyReview; } }, runner: { run: async () => { scans += 1; return runner.run(); } },
      executor: new RStudyMethodExecutor({ timeout_ms: 120_000 }), output_dir: output,
    });
    const draft = await service.draft(question);
    assert.equal(scans, 0, "a draft never reads patient data");
    assert.equal(draft.plans[0]!.status, "ready");
    assert.ok(draft.plans[0]!.manifest);
    assert.equal(draft.plans[0]!.method_options.length, 3);
    assert.deepEqual(draft.plans[0]!.protocol.elements.map(({ key }) => key), ["eligibility", "treatment", "comparator", "time_zero", "outcome", "follow_up", "confounders", "analysis"]);
    // The safer design is the default: a 24-hour landmark and the always-recorded severity variables (lactate off).
    assert.equal(draft.plans[0]!.protocol.design_checks.find(({ check_id }) => check_id === "outcome_after_exposure")?.status, "pass");
    assert.deepEqual(draft.plans[0]!.design_options?.landmark, { hours: 24, default: true });
    assert.deepEqual(draft.plans[0]!.design_options?.severity?.default_on, ["Emergency admission", "Vasopressors", "Invasive mechanical ventilation", "Creatinine"]);
    assert.throws(() => lockQuestionPlan(draft, { options: { f1: { severity_on: ["SOFA"] } } }, "user"), /not a severity variable/u);

    assert.throws(() => lockQuestionPlan(draft, { methods: { f1: "not.a.method" } }, "user"), PlanLockError);
    assert.throws(() => lockQuestionPlan(draft, { excluded: ["f1"] }, "user"), /No runnable plan/u);
    const locked = lockQuestionPlan(draft, { methods: { f1: "regression.adjusted" } }, "user");
    assert.ok(lockIsIntact(locked));
    assert.equal(lockIsIntact({ ...locked, choices: { ...locked.choices, methods: { f1: "treatment.psm" } } }), false, "an edited lock is rejected");

    const before = mappings;
    const result = await service.runLocked(locked);
    assert.equal(mappings, before, "a locked run never re-maps");
    assert.equal(scans, 1);
    assert.equal(result.plans[0]!.chosen_method, "regression.adjusted");
    assert.equal(result.plans[0]!.status, "completed");
    assert.equal(result.plans[0]!.protocol?.elements.length, 8);
    assert.match(result.plans[0]!.protocol!.elements.find(({ key }) => key === "follow_up")!.emulation, /from 24 hours after time zero \(landmark\)/u);
    const withoutLandmark = await service.runLocked(lockQuestionPlan(draft, { methods: { f1: "regression.adjusted" }, options: { f1: { landmark: false, severity_on: ["Lactate"] } } }, "user"));
    assert.equal(withoutLandmark.plans[0]!.protocol?.design_checks.find(({ check_id }) => check_id === "outcome_after_exposure")?.status, "warn", "switching the landmark off brings the warning back");
    // The protocol names what the model receives: this fake mapping maps Age and Sex only, so switching Lactate on adds nothing.
    assert.equal(withoutLandmark.plans[0]!.protocol!.elements.find(({ key }) => key === "confounders")!.emulation, "Age, Sex");
    assert.deepEqual(result.plan_lock, { lock_id: locked.lock_id, locked_at: locked.locked_at, confirmed_by: "user" });
    await assert.rejects(service.runLocked({ ...locked, choices: { methods: {}, excluded: [] } }), PlanLockError);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("drafts an unanswerable aim as needing clarification and shortens follow-up MIMIC-IV cannot observe", async () => {
  const question = "吸烟对肺癌患者5年生存的影响，以及门诊患者使用某药与死亡";
  const frames = [
    ...buildFrames({ question, sub_question: "吸烟对肺癌患者5年生存的影响", first_id: 1, extraction: extraction({ goal: "relate_factor", outcome_kind: "time_to_event", population: "肺癌患者", exposure: "吸烟", outcomes: ["5年生存"], time_window: "5年" }) }),
    ...buildFrames({ question, sub_question: "门诊患者使用某药与死亡", first_id: 2, extraction: extraction({ population: "门诊患者", exposure: "某药", outcomes: ["死亡"] }) }),
  ];
  const service = new QuestionPipelineService({
    framing: { frame: async () => ({ frame_set: { schema_version: "1.0.0", original_question: question, frames }, audits: [] }) }, model: "test-model", data_source: { id: "simulated", version: "test" },
    catalog, archive_path: "/unused.zip", mapping: { assess: async () => readyReview }, runner, executor: new RStudyMethodExecutor({ timeout_ms: 1_000 }), output_dir: "/unused",
    assess_frame: (frame) => frame.population?.qualified_text === "门诊患者"
      ? { not_answerable: { slot: "population", text: "门诊患者", reason: { en: "No outpatient cohort.", zh: "没有门诊人群。" } } }
      : { follow_up_cap: { max_days: 365, capped_label: { en: "follow-up to one year", zh: "随访至 1 年" }, reason: { en: "Deaths are captured up to one year.", zh: "仅覆盖 1 年。" } } },
  });
  const draft = await service.draft(question);
  const [survival, outpatient] = draft.frame_set.frames;
  assert.equal(survival!.time_window, "365天");
  assert.ok(survival!.assumptions.some((text) => /“5年” is longer than MIMIC-IV observes/u.test(text)));
  assert.equal(outpatient!.status, "needs_clarification");
  assert.deepEqual(draft.unanswered_frames.map(({ reasons }) => reasons[0]), [{ en: "“门诊患者”: No outpatient cohort.", zh: "“门诊患者”：没有门诊人群。" }]);
  assert.ok(draft.plans.every(({ plan }) => plan.frame_id === "f1"));
});

test("a prediction of a numeric outcome stops at planning with the reason, not when R runs", async () => {
  // Cover audit 2026-11-04: the registry offered the prediction methods for every outcome type and R stopped them afterwards
  // ("Prediction methods currently support binary outcomes"), after the plan had been shown and locked.
  const question = "Predict ICU length of stay from first-day lactate";
  const frames = buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction({ goal: "predict", outcome_kind: "value", population: "ICU patients", predictors: ["lactate"], outcomes: ["ICU length of stay"] }) });
  assert.equal(frames[0]!.study_type, "prediction");
  const service = new QuestionPipelineService({
    framing: { frame: async () => ({ frame_set: { schema_version: "1.0.0", original_question: question, frames }, audits: [] }) }, model: "test-model", data_source: { id: "simulated", version: "test" },
    catalog, archive_path: "/unused.zip", mapping: { assess: async () => readyReview }, runner, executor: new RStudyMethodExecutor({ timeout_ms: 1_000 }), output_dir: "/unused",
  });
  const draft = await service.draft(question);
  const plan = draft.plans[0]!;
  assert.equal(plan.status, "blocked");
  const blockers = (plan as { blocked_outcome?: { blockers: Array<{ code: string; message: { en: string; zh: string } }> } }).blocked_outcome!.blockers;
  assert.deepEqual(blockers.map(({ code }) => code), ["PREDICTION_OUTCOME_NOT_BINARY"]);
  assert.match(blockers[0]!.message.en, /yes\/no outcome only/u);
  assert.match(blockers[0]!.message.zh, /是\/否结局/u);
});

test("never adjusts for the exposure itself when a default covariate maps to the same variable", async () => {
  const { methodConfigFor } = await import("../index.js");
  const plan = { plan_id: "f1", frame_id: "f1", study_spec: { schema_version: "1.0.0" as const, intent_family: "association" as const, outcome_structure: "binary" as const }, roles: { mediators: [], modifiers: [], default_covariates: ["Age", "Sex"] } };
  const cohort = { rows: [], quality: { source_rows: {}, analysis_units: 0, complete_rows: 0, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "x", columns: [
    { column: "exposure", role: "exposure" as const, requested_label: "age", mapping_id: "age", value_type: "continuous" as const },
    { column: "covariate_0", role: "covariate" as const, requested_label: "Age", mapping_id: "age", value_type: "continuous" as const },
    { column: "covariate_1", role: "covariate" as const, requested_label: "Sex", mapping_id: "sex", value_type: "categorical" as const },
  ] };
  assert.deepEqual(methodConfigFor(plan, cohort, "regression.adjusted").covariates, ["covariate_1"]);
});

test("computes a ratio exposure per patient and leaves the denominator out of the adjustment set", async () => {
  const { applyRatioExposure, methodConfigFor } = await import("../index.js");
  const plan = { plan_id: "f1.2", frame_id: "f1", study_spec: { schema_version: "1.0.0" as const, intent_family: "association" as const, outcome_structure: "binary" as const }, roles: { mediators: [], modifiers: [], default_covariates: ["Age"], ratio: { numerator: "RDW", denominator: "Albumin", label: "RDW/Albumin ratio" } } };
  const rows = [{ analysis_id: "1", exposure: 15, covariate_0: 70, covariate_1: 3, outcome: true }, { analysis_id: "2", exposure: 14, covariate_0: 60, covariate_1: 0, outcome: false }, { analysis_id: "3", exposure: 12, covariate_0: 50, outcome: false }];
  const cohort = { rows, quality: { source_rows: {}, analysis_units: 3, complete_rows: 3, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "x", columns: [
    { column: "exposure", role: "exposure" as const, requested_label: "RDW", mapping_id: "rdw", value_type: "continuous" as const },
    { column: "covariate_0", role: "covariate" as const, requested_label: "Age", mapping_id: "age", value_type: "continuous" as const },
    { column: "covariate_1", role: "covariate" as const, requested_label: "Albumin", mapping_id: "albumin", value_type: "continuous" as const },
  ] };
  const computed = applyRatioExposure(plan, cohort);
  assert.deepEqual(computed.rows.map(({ exposure }) => exposure), [5, undefined, undefined], "zero or missing denominators leave the ratio missing");
  assert.equal(rows[0]!.exposure, 15, "shared cohort rows are not changed");
  const config = methodConfigFor(plan, computed, "regression.adjusted");
  assert.deepEqual(config.covariates, ["covariate_0"]);
  assert.equal(config.labels?.exposure, "RDW/Albumin ratio");
});

test("computes a formula exposure per patient from its parts and keeps the parts out of the adjustment set", async () => {
  const { applyRatioExposure, methodConfigFor } = await import("../index.js");
  const plan = { plan_id: "f1", frame_id: "f1", study_spec: { schema_version: "1.0.0" as const, intent_family: "association" as const, outcome_structure: "binary" as const },
    roles: { mediators: [], modifiers: [], default_covariates: ["Age"], formula: { label: "ePVS", expression: "(100 - hct) / hb", variables: [{ name: "hct", label: "Hematocrit" }, { name: "hb", label: "Hemoglobin" }] } } };
  const rows = [{ analysis_id: "1", exposure: 40, covariate_0: 70, covariate_1: 10, outcome: true }, { analysis_id: "2", exposure: 30, covariate_0: 60, covariate_1: 0, outcome: false }, { analysis_id: "3", exposure: 30, covariate_0: 50, outcome: false }];
  const cohort = { rows, quality: { source_rows: {}, analysis_units: 3, complete_rows: 3, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "x", columns: [
    { column: "exposure", role: "exposure" as const, requested_label: "Hematocrit", mapping_id: "hct", value_type: "continuous" as const },
    { column: "covariate_0", role: "covariate" as const, requested_label: "Age", mapping_id: "age", value_type: "continuous" as const },
    { column: "covariate_1", role: "covariate" as const, requested_label: "Hemoglobin", mapping_id: "hb", value_type: "continuous" as const },
  ] };
  const computed = applyRatioExposure(plan, cohort);
  assert.deepEqual(computed.rows.map(({ exposure }) => exposure), [6, undefined, undefined], "a zero or missing part leaves the formula missing");
  const config = methodConfigFor(plan, computed, "regression.adjusted");
  assert.deepEqual(config.covariates, ["covariate_0"]);
  assert.equal(config.labels?.exposure, "ePVS");
});

test("compares a continuous grouping variable in age bands or quartiles", async () => {
  const { applyGrouping } = await import("../index.js");
  const question = "What is the in-hospital mortality of patients admitted with diabetic ketoacidosis, by age group?";
  const [frame] = buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction({ goal: "compare_groups", population: "patients admitted with diabetic ketoacidosis", exposure: "age group", outcomes: ["in-hospital mortality"] }) });
  const cohort = (label: string) => ({ rows: [20, 30, 50, 60, 70, 75, 85, 90].map((value, index) => ({ analysis_id: String(index), exposure: value, outcome: index % 2 === 0 })), quality: { source_rows: {}, analysis_units: 8, complete_rows: 8, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "x",
    columns: [{ column: "exposure", role: "exposure" as const, requested_label: label, mapping_id: "m", value_type: "continuous" as const }] });
  const age = applyGrouping(frame!, cohort("Age"));
  assert.deepEqual(age.cohort.rows.map(({ exposure }) => exposure), ["18-44", "18-44", "45-64", "45-64", "65-79", "65-79", "80+", "80+"]);
  assert.match(age.note!.en, /18-44, 45-64, 65-79, 80\+ years/u);
  const lactate = applyGrouping(frame!, cohort("Lactate"));
  assert.deepEqual(new Set(lactate.cohort.rows.map(({ exposure }) => String(exposure).slice(0, 2))), new Set(["Q1", "Q2", "Q3", "Q4"]));
  const [treatment] = buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction({ population: "p", exposure: "drug", outcomes: ["death"] }) });
  assert.equal(applyGrouping(treatment!, cohort("Age")).note, undefined, "only group comparisons are grouped");
});

test("a description grouped by a continuous variable describes age bands or quartiles", async () => {
  const { applyGrouping } = await import("../index.js");
  const question = "按年龄描述心衰住院患者的肌酐";
  const [frame] = buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction({ goal: "describe", outcome_kind: "none", population: "心衰住院患者", exposure: "年龄", outcomes: ["肌酐"] }) });
  assert.equal(frame!.study_type, "descriptive");
  // A description has no outcome column; every unit is kept, including one without the grouping value.
  const cohort = (label: string) => ({ rows: [20, 30, 50, 60, 70, 75, 85, 90, null].map((value, index) => ({ analysis_id: String(index), exposure: value, characteristic_0: 1 + index / 10 })), quality: { source_rows: {}, analysis_units: 9, complete_rows: 9, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "x",
    columns: [{ column: "exposure", role: "exposure" as const, requested_label: label, mapping_id: "m", value_type: "continuous" as const }, { column: "characteristic_0", role: "covariate" as const, requested_label: "Creatinine", mapping_id: "c", value_type: "continuous" as const, characteristic: true }] });
  const age = applyGrouping(frame!, cohort("Age"));
  assert.deepEqual(age.cohort.rows.map(({ exposure }) => exposure), ["18-44", "18-44", "45-64", "45-64", "65-79", "65-79", "80+", "80+", null]);
  assert.match(age.note!.en, /described in the groups 18-44, 45-64, 65-79, 80\+ years/u);
  assert.match(age.note!.zh, /岁分组描述/u);
  assert.deepEqual(age.cohort.rows.map(({ characteristic_0 }) => characteristic_0), cohort("Age").rows.map(({ characteristic_0 }) => characteristic_0), "the characteristics are untouched");
  const lactate = applyGrouping(frame!, cohort("Lactate"));
  assert.deepEqual(new Set(lactate.cohort.rows.slice(0, 8).map(({ exposure }) => String(exposure).slice(0, 2))), new Set(["Q1", "Q2", "Q3", "Q4"]));
  assert.match(lactate.note!.en, /described in quartiles/u);
  // Recorded for fewer than half of the units: still grouped, with quartiles of the recorded values only (a missing value is not a 0).
  const sparse = { ...cohort("Lactate"), rows: [...[1, 2, 3, 4, 5, 6, 7, 8].map((value, index) => ({ analysis_id: String(index), exposure: value })), ...Array.from({ length: 10 }, (_, index) => ({ analysis_id: `m${index}`, exposure: null }))] };
  const grouped = applyGrouping(frame!, sparse);
  assert.deepEqual(grouped.cohort.rows.slice(0, 8).map(({ exposure }) => exposure), ["Q1 (<=2)", "Q1 (<=2)", "Q2 (<=4)", "Q2 (<=4)", "Q3 (<=6)", "Q3 (<=6)", "Q4 (>6)", "Q4 (>6)"]);
  assert.ok(grouped.cohort.rows.slice(8).every(({ exposure }) => exposure === null));
});

test("groups a continuous effect modifier such as age before the interaction analysis", async () => {
  const { applyGrouping } = await import("../index.js");
  const question = "Does the effect of norepinephrine on mortality in septic shock differ by age?";
  const [frame] = buildFrames({ question, sub_question: question, first_id: 1, aim: "effect_modification", extraction: extraction({ population: "patients with septic shock", exposure: "norepinephrine", outcomes: ["mortality"], modifiers: ["age"] }) });
  assert.equal(frame!.study_type, "effect_modification");
  const cohort = { rows: [30, 50, 70, 85, 40, 60, 75, 90].map((value, index) => ({ analysis_id: String(index), exposure: index % 2 === 0, outcome: false, effect_modifier_0: value })), quality: { source_rows: {}, analysis_units: 8, complete_rows: 8, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "x",
    columns: [{ column: "exposure", role: "exposure" as const, requested_label: "Norepinephrine", mapping_id: "n", value_type: "binary" as const }, { column: "effect_modifier_0", role: "covariate" as const, requested_label: "age", mapping_id: "age", value_type: "continuous" as const }] };
  const grouped = applyGrouping(frame!, cohort, "effect_modifier_0");
  assert.deepEqual(grouped.cohort.rows.map((row) => row.effect_modifier_0), ["18-44", "45-64", "65-79", "80+", "18-44", "45-64", "65-79", "80+"]);
  assert.equal(grouped.cohort.rows[0]!.exposure, true, "the exposure is untouched");
});

test("outcome parts known only from undated diagnosis codes become their own aims instead of being dropped", async () => {
  const question = "血压水平与脑血管不良结局的关联";
  const [composite] = buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction({ goal: "relate_factor", exposure: "血压水平", outcomes: ["卒中", "脑出血"], composite_outcome: "脑血管不良结局" }) });
  composite!.outcome!.components_normalized = [{ text: "卒中", label_en: "stroke", category: "diagnosis" }, { text: "短暂性脑缺血发作", label_en: "transient ischemic attack", category: "diagnosis" }, { text: "脑出血", label_en: "cerebral hemorrhage", category: "diagnosis" }];
  const service = new QuestionPipelineService({
    framing: { frame: async () => ({ frame_set: { schema_version: "1.0.0", original_question: question, frames: [composite!] }, audits: [] }) }, model: "test-model", data_source: { id: "simulated", version: "test" },
    catalog, archive_path: "/unused.zip", mapping: { assess: async () => readyReview }, runner, executor: new RStudyMethodExecutor({ timeout_ms: 1_000 }), output_dir: "/unused",
    assess_outcome_components: (components) => ({ kept: [], excluded: components.map(({ text }) => ({ text, reason: { en: "Known only from undated diagnosis codes.", zh: "只有无日期诊断编码。" } })) }),
  });
  const draft = await service.draft(question);
  assert.deepEqual(draft.frame_set.frames.map(({ outcome }) => outcome?.text), ["卒中", "短暂性脑缺血发作", "脑出血"], "the composite has nothing left to combine, so each part is an aim");
  assert.ok(draft.frame_set.frames.every(({ status }) => status === "ready"));
  assert.ok(draft.frame_set.frames.every(({ assumptions }) => assumptions.some((text) => text.includes("association with that diagnosis"))));
  assert.equal(new Set(draft.frame_set.frames.map(({ frame_id }) => frame_id)).size, 3);
});

test("an outcome that names nothing measurable offers readings; a test run takes one, frames the question again and states the reading", async () => {
  const { FileReadingCatalogRepository } = await import("../../question-clarification/index.js");
  const readings = await new FileReadingCatalogRepository(new URL("../../../../config/clarifications/vague-outcome-readings.json", import.meta.url)).load();
  const vague = "某药在高血压患者中的疗效"; const named = "某药在高血压患者中的降压效果";
  const asked: string[] = [];
  const framesFor = (question: string, outcome: string) => ({ schema_version: "1.0.0" as const, original_question: question, frames: buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction({ population: "高血压患者", exposure: "某药", comparator: "不用某药", outcomes: [outcome] }) }) });
  const service = new QuestionPipelineService({
    framing: { frame: async (question) => { asked.push(question); return { frame_set: framesFor(question, question === vague ? "疗效" : "降压效果"), audits: [] }; } },
    clarification_readings: readings, model: "test-model", data_source: { id: "simulated", version: "test" },
    catalog, archive_path: "/unused.zip", mapping: { assess: async () => readyReview }, runner, executor: new RStudyMethodExecutor({ timeout_ms: 1_000 }), output_dir: "/unused",
  });
  const asking = await service.draft(vague);
  assert.deepEqual(asked, [vague]);
  assert.equal(asking.unanswered_frames.length, 1);
  assert.equal(asking.clarifications![0]!.options.length, 3);
  assert.equal(asking.clarifications![0]!.options[0]!.question, named);
  assert.equal(asking.clarifications![0]!.chosen, undefined);

  asked.length = 0;
  const chosen = await service.draft(vague, { clarify: "first" });
  assert.deepEqual(asked, [vague, named]);
  assert.equal(chosen.question, vague);
  assert.equal(chosen.unanswered_frames.length, 0);
  assert.equal(chosen.clarifications![0]!.chosen!.by, "automatic_first");
  assert.ok(chosen.frame_set.frames[0]!.assumptions.some((text) => /read as “Blood pressure lowering”/u.test(text)));
});

test("a question the model cannot read stops with a reason instead of failing the run", async () => {
  const { StudyFramingError } = await import("../../study-framing/index.js");
  const { assessFrame, FileLimitationKnowledgeBaseRepository } = await import("../../mimic-limitations/index.js");
  const knowledge = await new FileLimitationKnowledgeBaseRepository(new URL("../../../../config/mimic-limitations/mimic-iv-3.1.json", import.meta.url)).load();
  const service = new QuestionPipelineService({
    framing: { frame: async () => { throw new StudyFramingError("FRAMING_MODEL_FAILED", "Study framing failed at study_frame_extraction.", []); } },
    model: "test-model", data_source: { id: "simulated", version: "test" }, assess_frame: (frame) => assessFrame(knowledge, frame),
    catalog, archive_path: "/unused.zip", mapping: { assess: async () => readyReview }, runner, executor: new RStudyMethodExecutor({ timeout_ms: 1_000 }), output_dir: "/unused",
  });
  const recommendation = await service.draft("What glucocorticoid dosing strategy should be recommended for patients with sepsis?");
  assert.equal(recommendation.plans.length, 0);
  // Each reason once: the rule reason first, then the unreadable answer.
  const ruled = recommendation.unanswered_frames[0]!.reasons.map(({ en }) => en);
  assert.equal(ruled.length, 2, ruled.join(" | "));
  assert.match(ruled[0]!, /not clinical recommendations/u);
  assert.match(ruled[1]!, /could not be read automatically/u);
  const unreadable = await service.draft("asdf qwer");
  assert.equal(unreadable.unanswered_frames[0]!.reasons.length, 1);
  assert.match(unreadable.unanswered_frames[0]!.reasons[0]!.en, /could not be read automatically/u);
});

test("a local model that does not respond says so with the configured model name, not 'rephrase the question'", async () => {
  const { StudyFramingService } = await import("../../study-framing/index.js");
  const { OpenAiCompatibleStructuredChatClient } = await import("../../model-output/index.js");
  const { assessFrame, FileLimitationKnowledgeBaseRepository } = await import("../../mimic-limitations/index.js");
  const knowledge = await new FileLimitationKnowledgeBaseRepository(new URL("../../../../config/mimic-limitations/mimic-iv-3.1.json", import.meta.url)).load();
  const prompts = { split: { id: "s", version: "1", body: "" }, extraction: { id: "e", version: "1", body: "" } };
  const draftWith = async (fetch: typeof globalThis.fetch, question = "住院患者使用某药与不用某药的死亡差异") => {
    const model = new OpenAiCompatibleStructuredChatClient({ provider: "local", base_url: "http://127.0.0.1:1/v1", model: "configured-model:7b", timeout_ms: 50, fetch });
    const service = new QuestionPipelineService({
      framing: new StudyFramingService({ model, prompts }), model: "configured-model:7b", data_source: { id: "simulated", version: "test" }, assess_frame: (frame) => assessFrame(knowledge, frame),
      catalog, archive_path: "/unused.zip", mapping: { assess: async () => readyReview }, runner, executor: new RStudyMethodExecutor({ timeout_ms: 1_000 }), output_dir: "/unused",
    });
    return service.draft(question);
  };
  const refused = async () => { throw new TypeError("fetch failed"); };
  const hangs = (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const notInstalled = async () => new Response(JSON.stringify({ error: "model not found" }), { status: 404 });
  for (const [fetch, failureClass] of [[refused, "MODEL_UNREACHABLE"], [hangs, "MODEL_TIMEOUT"], [notInstalled, "PROVIDER_HTTP_404"]] as const) {
    const draft = await draftWith(fetch as typeof globalThis.fetch);
    assert.equal(draft.plans.length, 0, failureClass);
    assert.equal(draft.frame_set.frames[0]!.ambiguities[0]!.code, "MODEL_NOT_RESPONDING", failureClass);
    assert.equal(draft.unanswered_frames[0]!.reasons.length, 1, failureClass);
    const [reason] = draft.unanswered_frames[0]!.reasons;
    assert.equal(reason!.en, "The local model did not respond: make sure Ollama is open and the model configured-model:7b is installed, then submit the question again.", failureClass);
    assert.equal(reason!.zh, "本地模型没有响应：请确认 Ollama 已打开、模型 configured-model:7b 已下载，然后重新提交问题。", failureClass);
    assert.ok(!draft.unanswered_frames[0]!.reasons.some(({ en }) => /Rephrase/u.test(en)), failureClass);
    // The failure class is kept in the model audit.
    assert.equal(draft.model_audit.at(-1)!.failure_class, failureClass);
  }
  // A question a rule refuses keeps that reason, and the silent model is reported with it.
  const recommendation = await draftWith(refused as typeof globalThis.fetch, "What glucocorticoid dosing strategy should be recommended for patients with sepsis?");
  const reasons = recommendation.unanswered_frames[0]!.reasons.map(({ en }) => en);
  // Exactly two reasons, each once: the rule reason is not repeated.
  assert.equal(reasons.length, 2, reasons.join(" | "));
  assert.match(reasons[0]!, /not clinical recommendations/u);
  assert.match(reasons[1]!, /The local model did not respond/u);
  assert.ok(!reasons.some((text) => /Rephrase/u.test(text)));
  // A model that answers with something unusable still asks for another wording.
  const garbled = await draftWith((async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 })) as typeof globalThis.fetch);
  assert.match(garbled.unanswered_frames[0]!.reasons[0]!.en, /could not be read automatically/u);
});

test("a variable the mapping only partly covers offers a narrower definition or the broader concept; a test run takes one and the plan is prepared again", async () => {
  const question = "住院患者使用某药与不用某药的死亡差异";
  const frames = buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction({ population: "住院患者", exposure: "某药", comparator: "不用某药", outcomes: ["死亡"] }) });
  const partialReason = "“acute ischemic stroke” was matched to “Stroke”, which does not carry: acute, ischemic. The matched concept is broader than, or only a part of, what was asked.";
  const build = (defined: boolean, acceptedTerm = false): StudyVariableMappingReview => defined || acceptedTerm ? readyReview : { ...readyReview, status: "needs_confirmation", summary: { resolved: 5, needs_confirmation: 1, unmapped: 0 },
    variables: readyReview.variables.map((variable) => variable.role === "exposure" ? { ...variable, requested_term: "acute ischemic stroke", status: "needs_confirmation" as const, reason: partialReason,
      candidates: variable.candidates.map((candidate) => ({ ...candidate, mapping: { ...candidate.mapping, labels: { en: "Stroke" } } })) } : variable) };
  let saved = 0;
  const proposal = { definition: { schema_version: "1.0.0", definition_id: "acute_ischemic_stroke", version: "1.0.0", kind: "diagnosis", labels: { en: "acute ischemic stroke" }, synonyms: [], meaning: "m", status: "researcher_defined", diagnosis: { codes: [{ code: "I63", version: 10 }] } }, facts: { codes: 1, admissions: 900, rows: 900 } };
  const make = (withProposal: boolean) => new QuestionPipelineService({
    framing: { frame: async () => ({ frame_set: { schema_version: "1.0.0", original_question: question, frames: structuredClone(frames) }, audits: [] }) }, model: "test-model", data_source: { id: "simulated", version: "test" },
    ...(withProposal ? { mapping_proposal: { propose: async () => proposal as never, define: async () => { saved += 1; } } } : {}),
    catalog, archive_path: "/unused.zip", mapping: { assess: async () => build(saved > 0) }, runner, executor: new RStudyMethodExecutor({ timeout_ms: 1_000 }), output_dir: "/unused",
  });
  const asking = await make(true).draft(question);
  assert.equal(asking.plans[0]!.status, "blocked");
  assert.deepEqual(asking.mapping_clarifications![0]!.options.map(({ option_id }) => option_id), ["define", "broader", "stop"]);
  assert.equal(asking.mapping_clarifications![0]!.chosen, undefined); assert.equal(saved, 0);
  const first = await make(true).draft(question, { clarify: "first" });
  assert.equal(saved, 1);
  assert.equal(first.plans[0]!.status, "ready");
  assert.equal(first.mapping_clarifications![0]!.chosen!.option_id, "define");
  assert.ok(first.frame_set.frames[0]!.assumptions.some((text) => /dictionary entries that carry it/u.test(text)));
  // The researcher accepted the broader concept: the plan runs and states what was left out.
  saved = 0;
  const accepted = await make(true).draft(question, { accept: ["exposure|acute ischemic stroke"] });
  assert.equal(saved, 0); assert.equal(accepted.plans[0]!.status, "ready");
  assert.equal(accepted.mapping_clarifications![0]!.chosen!.by, "user");
  assert.ok(accepted.frame_set.frames[0]!.assumptions.some((text) => /analysed as the broader “Stroke”/u.test(text)));
});

test("a term nothing matched is drafted from the dictionary, and an automatic choice takes the definition before the broader concept", async () => {
  const { chooseMappingOption, fidelityStops } = await import("../../question-clarification/index.js");
  const unmapped = [{ role: "exposure", requested_term: "serum chloride", status: "unmapped", candidates: [], reason: "No reusable mapping" }, { role: "index_time", requested_term: "ICU admission", status: "unmapped", candidates: [] }];
  assert.deepEqual(fidelityStops(unmapped), [{ role: "exposure", term: "serum chloride", uncovered: ["chloride"] }]);
  const both = { plan_id: "p", term: "t", options: [{ option_id: "define" as const, label: { en: "", zh: "" } }, { option_id: "broader" as const, label: { en: "", zh: "" } }, { option_id: "stop" as const, label: { en: "", zh: "" } }] };
  for (const key of ["a", "b", "c", "d", "e", "f"]) assert.equal(chooseMappingOption("random", key, both), "define");
  assert.equal(chooseMappingOption("random", "x", { ...both, options: both.options.slice(1) }), "broader");
  assert.equal(chooseMappingOption("ask", "x", both), undefined);
});

// Review of 43ab060: the report's adjustment row split the study spec's covariates only on the switched-off ones, so an age
// effect read "adjusted for Age" and a ratio exposure listed its own denominator as adjusted for.
test("a run records which adjustment variables the model did not receive and why; the severity check counts only modelled ones", async () => {
  const { runPreparedPlan } = await import("../index.js");
  const covariate = (name: string) => ({ name, role: "covariate" as const, operational_definition: `${name}.` });
  const plan = { plan_id: "f1", frame_id: "f1", study_spec: { schema_version: "1.0.0" as const, intent_family: "treatment_effect" as const, outcome_structure: "binary" as const,
    exposure_or_predictors: [{ name: "age", role: "exposure" as const, operational_definition: "Age." }], outcome: { name: "Death", role: "outcome" as const, operational_definition: "Death." },
    covariates: [covariate("Age"), covariate("Sex"), covariate("gender"), covariate("SOFA score"), covariate("Lactate"), covariate("Albumin")] },
    roles: { mediators: [], modifiers: [], default_covariates: ["Age", "Sex"], severity: ["SOFA score", "Lactate"], severity_off: ["Lactate"] } };
  const rows = Array.from({ length: 40 }, (_, index) => ({ analysis_id: String(index), exposure: 50 + index, covariate_0: 50 + index, covariate_1: index % 2 ? "F" : "M", covariate_2: index % 2 ? "F" : "M", covariate_3: index % 5, covariate_4: 2, outcome: index % 3 === 0 }));
  const columns = [
    { column: "exposure", role: "exposure" as const, requested_label: "age", mapping_id: "age", value_type: "continuous" as const },
    { column: "covariate_0", role: "covariate" as const, requested_label: "Age", mapping_id: "age", value_type: "continuous" as const },
    { column: "covariate_1", role: "covariate" as const, requested_label: "Sex", mapping_id: "sex", value_type: "categorical" as const },
    { column: "covariate_2", role: "covariate" as const, requested_label: "gender", mapping_id: "sex", value_type: "categorical" as const },
    { column: "covariate_3", role: "covariate" as const, requested_label: "SOFA score", mapping_id: "sofa", value_type: "continuous" as const },
    { column: "covariate_4", role: "covariate" as const, requested_label: "Lactate", mapping_id: "lactate", value_type: "continuous" as const },
    { column: "outcome", role: "outcome" as const, requested_label: "Death", mapping_id: "death", value_type: "binary" as const },
  ];
  let received: string[] | undefined;
  const dependencies = {
    catalog: {} as never, archive_path: "unused", output_dir: "unused", mapping: { assess: async () => { throw new Error("not used"); } },
    runner: { run: async () => ({ rows, columns, quality: { source_rows: {}, analysis_units: 40, complete_rows: 40, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "sha256:x" }) },
    executor: { run: async (_rows: unknown, config: { covariates?: string[] }) => { received = config.covariates; return { method_id: "treatment.iptw", method_library_version: "test", status: "completed" as const, n_input: 40, n_analysed: 40, output_dir: "unused", estimates: [{ term: "exposure", label: "age", measure: "odds_ratio", estimate: 1.1, ci_low: 1, ci_high: 1.2, p_value: 0.04 }], diagnostics: {}, warnings: [], tables: {}, figures: [] }; } },
    result_checks: undefined, choose_method: () => "treatment.iptw",
  } as unknown as PlanExecutionDependencies;
  const frame = buildFrames({ question: "q", sub_question: "q", first_id: 1, extraction: { goal: "evaluate_treatment", outcome_kind: "event", dose_question: false, population: "ICU", exposure: "age", exposure_categories: [], comparator: "", outcomes: ["death"], composite_outcome: "", modifiers: [], mediators: [], predictors: [], time_window: "" } })[0]!;
  const outcome = await runPreparedPlan(plan, frame, { kind: "prepared", mapping: [], manifest: { manifest_id: "m", status: "ready", sources: [] } as never }, dependencies);
  assert.deepEqual(received, ["covariate_1", "covariate_3"], "the model gets Sex once and SOFA; not Age (the exposure) or Lactate (off)");
  assert.deepEqual(outcome.covariates_not_modelled, [{ name: "Age", reason: "exposure" }, { name: "Lactate", reason: "switched_off" }, { name: "Albumin", reason: "not_mapped" }], "gender shares Sex's mapping, so it is in the model");
});

// Second review of 92b516f: a blocked plan's report listed the exposure as adjusted for while its protocol left it out; every
// mediator was left out of the protocol although only the first is analysed; a change outcome's baseline mean was merged
// with the severity maximum of the same mapping, or dropped because the severity variable was switched off.
test("the plan says which variables will not be adjusted for before any data, with only the analysed mediator", async () => {
  const { plannedNotModelled, withNotModelled } = await import("../index.js");
  const covariate = (name: string) => ({ name, role: "covariate" as const, operational_definition: `${name}.` });
  const plan = { plan_id: "f1", frame_id: "f1", study_spec: { schema_version: "1.0.0" as const, intent_family: "association" as const,
    exposure_or_predictors: [{ name: "age", role: "exposure" as const, operational_definition: "Age." }],
    covariates: [covariate("Age"), covariate("Sex"), covariate("Lactate"), covariate("Heart rate"), covariate("Albumin"), covariate("SOFA score")] },
    roles: { mediators: ["lactate", "heart rate"], modifiers: [], default_covariates: ["Age", "Sex"], ratio: { numerator: "RDW", denominator: "Albumin", label: "RDW/Albumin" }, severity: ["SOFA score"], severity_off: ["SOFA score"] } };
  assert.deepEqual(plannedNotModelled(plan), [{ name: "Age", reason: "exposure" }, { name: "Lactate", reason: "mediator" }, { name: "Albumin", reason: "exposure_part" }, { name: "SOFA score", reason: "switched_off" }], "heart rate, the second mediator, is adjusted for");
  const prediction = { ...plan, study_spec: { ...plan.study_spec, intent_family: "prediction" as const, exposure_or_predictors: [{ name: "Age", role: "predictor" as const, operational_definition: "Age." }] }, roles: { ...plan.roles, mediators: [], ratio: undefined } as never };
  assert.deepEqual(plannedNotModelled(prediction), [{ name: "Age", reason: "predictor" }, { name: "SOFA score", reason: "switched_off" }]);
  assert.equal("covariates_not_modelled" in withNotModelled({ covariates_not_modelled: [{ name: "Age", reason: "exposure" as const }] }, []), false);
});

test("one adjustment variable is one mapping read with one summary", async () => {
  const { methodConfigFor } = await import("../index.js");
  const plan = { plan_id: "f1", frame_id: "f1", study_spec: { schema_version: "1.0.0" as const, intent_family: "treatment_effect" as const, outcome_structure: "continuous" as const }, roles: { mediators: [], modifiers: [], default_covariates: ["Age"], severity: ["Creatinine", "Lactate"], severity_off: ["Lactate"] } };
  const cohort = { rows: [], quality: { source_rows: {}, analysis_units: 0, complete_rows: 0, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "x", columns: [
    { column: "exposure", role: "exposure" as const, requested_label: "Furosemide", mapping_id: "furosemide", value_type: "continuous" as const, aggregation: "sum" as const },
    { column: "covariate_0", role: "covariate" as const, requested_label: "Creatinine", mapping_id: "creatinine", value_type: "continuous" as const },
    { column: "covariate_1", role: "covariate" as const, requested_label: "Baseline creatinine", mapping_id: "creatinine", value_type: "continuous" as const, aggregation: "mean" as const },
    { column: "covariate_2", role: "covariate" as const, requested_label: "Lactate", mapping_id: "lactate", value_type: "continuous" as const },
    { column: "covariate_3", role: "covariate" as const, requested_label: "Baseline lactate", mapping_id: "lactate", value_type: "continuous" as const, aggregation: "mean" as const },
    { column: "covariate_4", role: "covariate" as const, requested_label: "Sex", mapping_id: "sex", value_type: "categorical" as const },
    { column: "covariate_5", role: "covariate" as const, requested_label: "gender", mapping_id: "sex", value_type: "categorical" as const },
  ] };
  assert.deepEqual(methodConfigFor(plan, cohort, "treatment.iptw").covariates, ["covariate_0", "covariate_1", "covariate_3", "covariate_4"], "the baseline mean is kept beside the severity maximum and is not dropped with switched-off Lactate; Sex and gender stay one");
});

// Third review of 2214a18: keyed by mapping and summary, the default covariate Age (no summary) no longer matched the
// exposure "age" read as its first value (compiled manifests give it "first"), so the model got the same column twice.
test("the exposure and predictors reserve their whole mapping, whatever summary a compiled manifest gives them", async () => {
  const { methodConfigFor } = await import("../index.js");
  const empty = { rows: [], quality: { source_rows: {}, analysis_units: 0, complete_rows: 0, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "x" };
  const defaults = [
    { column: "covariate_0", role: "covariate" as const, requested_label: "Age", mapping_id: "mimic-iv.age.v1", value_type: "continuous" as const },
    { column: "covariate_1", role: "covariate" as const, requested_label: "Sex", mapping_id: "mimic-iv.sex.v1", value_type: "categorical" as const },
    { column: "covariate_2", role: "covariate" as const, requested_label: "Charlson comorbidity index", mapping_id: "mimic-iv.charlson.v1", value_type: "continuous" as const },
  ];
  const association = { plan_id: "f1", frame_id: "f1", study_spec: { schema_version: "1.0.0" as const, intent_family: "association" as const, outcome_structure: "binary" as const }, roles: { mediators: [], modifiers: [], default_covariates: ["Age", "Sex", "Charlson comorbidity index"] } };
  const exposureAge = { ...empty, columns: [{ column: "exposure", role: "exposure" as const, requested_label: "Age", mapping_id: "mimic-iv.age.v1", value_type: "continuous" as const, aggregation: "first" as const }, ...defaults] };
  assert.deepEqual(methodConfigFor(association, exposureAge, "regression.adjusted").covariates, ["covariate_1", "covariate_2"]);
  const prediction = { ...association, study_spec: { ...association.study_spec, intent_family: "prediction" as const } };
  const predictors = { ...empty, columns: [
    { column: "predictor_0", role: "predictor" as const, requested_label: "age", mapping_id: "mimic-iv.age.v1", value_type: "continuous" as const, aggregation: "first" as const },
    { column: "predictor_1", role: "predictor" as const, requested_label: "sex", mapping_id: "mimic-iv.sex.v1", value_type: "categorical" as const, aggregation: "first" as const }, ...defaults] };
  assert.deepEqual(methodConfigFor(prediction, predictors, "prediction.logistic").covariates, ["covariate_2"], "the comparison model holds only what the predictors are not");
});

// Fourth review of 9d14d97: the protocol matched the exposure by name, so an exposure "Gender" next to the default covariate
// "Sex" (one mapping) left Sex in the protocol's adjusted-for row while the model dropped it.
test("before any data, the frozen manifest says what the model will receive, with two names of one mapping seen as one", async () => {
  const { manifestNotModelled } = await import("../index.js");
  const variable = (role: string, label: string, mapping: string, extra: Record<string, unknown> = {}) => ({ role, requested_label: label, mapping_id: mapping, mapping_version: "1", source_id: "s", value_type: "continuous", value_rule: { kind: "direct", column: "c" }, temporal_rule: "t", missingness_rule: "m", ...extra });
  const covariate = (name: string) => ({ name, role: "covariate" as const, operational_definition: `${name}.` });
  const plan = { plan_id: "f1", frame_id: "f1", study_spec: { schema_version: "1.0.0" as const, intent_family: "association" as const, outcome_structure: "binary" as const,
    exposure_or_predictors: [{ name: "Gender", role: "exposure" as const, operational_definition: "Gender." }], covariates: [covariate("Age"), covariate("Sex"), covariate("Lactate"), covariate("Albumin")] },
    roles: { mediators: [], modifiers: [], default_covariates: ["Age", "Sex"], severity: ["Lactate"], severity_off: ["Lactate"] } };
  const manifest = { variables: [variable("index_time", "admission", "adm"), variable("exposure", "Gender", "mimic-iv.sex.v1", { aggregation: "first" }), variable("outcome", "Death", "death"),
    variable("covariate", "Age", "mimic-iv.age.v1"), variable("covariate", "Sex", "mimic-iv.sex.v1"), variable("covariate", "Lactate", "mimic-iv.lactate.v1")] } as never;
  assert.deepEqual(manifestNotModelled(plan, manifest, "regression.adjusted"), [{ name: "Sex", reason: "exposure" }, { name: "Lactate", reason: "switched_off" }, { name: "Albumin", reason: "not_mapped" }]);
  const lactateOn = { ...plan, roles: { ...plan.roles, excluded_covariates: [] } };
  assert.deepEqual(manifestNotModelled(lactateOn, manifest, "regression.adjusted"), [{ name: "Sex", reason: "exposure" }, { name: "Albumin", reason: "not_mapped" }], "switched on, Lactate is adjusted for");
  assert.deepEqual(manifestNotModelled(plan, undefined, "regression.adjusted"), [{ name: "Lactate", reason: "switched_off" }], "without a manifest only the plan's names are known");
});

test("a saved run and draft are shown with the sentences the report prints (an old run's change outcome included)", async () => {
  const { restateDraft, restateRun } = await import("../index.js");
  const spec = { schema_version: "1.0.0" as const, intent_family: "treatment_effect" as const, outcome: { name: "SBP change", role: "outcome" as const, operational_definition: "x", derivation: {} as never },
    assumptions: ["Outcomes are followed until the end of the index encounter because no horizon was stated."],
    time_windows: [{ purpose: "baseline" as const, anchor: "index_time" as const, start_offset: 0, end_offset: 24, unit: "hour" as const }, { purpose: "follow_up" as const, anchor: "index_time" as const, start_offset: 24, end_offset: 72, unit: "hour" as const }] };
  const run = restateRun({ plans: [{ plan_id: "f1", study_spec: spec }] } as never);
  assert.deepEqual(run.plans[0]!.study_spec.assumptions, ["Outcomes are followed for 72 hour(s) after time zero."]);
  const draft = restateDraft({ plans: [{ plan: { plan_id: "f1", study_spec: spec } }] } as never);
  assert.deepEqual(draft.plans[0]!.plan.study_spec.assumptions, ["Outcomes are followed for 72 hour(s) after time zero."]);
});
