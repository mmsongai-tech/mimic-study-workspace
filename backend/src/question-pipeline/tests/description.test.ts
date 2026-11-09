import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClinicalDatabaseCatalog } from "../../clinical-database/index.js";
import type { StudyVariableMappingReview, VariableMappingRecord } from "../../variable-mapping/index.js";
import { buildFrames, type FrameExtraction, type StudyFrameSet } from "../../study-framing/index.js";
import { RStudyMethodExecutor } from "../../study-analysis/index.js";
import { FileResultCheckRulesRepository } from "../../result-checks/index.js";
import { buildReportDocument, renderMarkdown } from "../../study-report/index.js";
import { familyPValue, planHeadline, profileDataset, QuestionPipelineService, type PlanExecutionDependencies } from "../index.js";

// A description-only question end to end on simulated rows (no patient data): framing, compilation, mapping, the frozen manifest,
// the runner's columns, the R description, the result checks, the headline and the report.
const columns = (names: string[]) => names.map((name) => ({ name, data_type: "text", nullable: false }));
const catalog: ClinicalDatabaseCatalog = { schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "local", inspected_at: "2026-11-04T00:00:00.000Z", relation_count: 3, column_count: 12, relations: [
  { schema: "mimiciv_hosp", name: "admissions", relation_type: "table", columns: columns(["subject_id", "hadm_id", "admittime", "hospital_expire_flag", "deathtime", "charlson"]) },
  { schema: "mimiciv_hosp", name: "patients", relation_type: "table", columns: columns(["subject_id", "anchor_age", "gender"]) },
  { schema: "mimiciv_hosp", name: "labevents", relation_type: "table", columns: columns(["subject_id", "hadm_id", "itemid", "charttime", "valuenum"]) },
] };
const record = (id: string, table: string, sourceColumns: string[], value_type: VariableMappingRecord["value_type"], category: VariableMappingRecord["category"]): VariableMappingRecord => ({ schema_version: "1.0.0", mapping_id: id, concept_id: id, mapping_version: "1", labels: { en: id }, synonyms: [], category, value_type, definition: { summary: id, temporal_rule: "As defined", value_rule: "Source value", missingness_rule: "Missing" }, sources: [{ kind: "direct_field", schema: "mimiciv_hosp", table, columns: sourceColumns }], status: "validated", provenance: "team_validation", evidence: {}, created_at: "2026-11-04T00:00:00.000Z", updated_at: "2026-11-04T00:00:00.000Z" });
const resolved = (role: StudyVariableMappingReview["variables"][number]["role"], mapping: VariableMappingRecord, conditionId?: string): StudyVariableMappingReview["variables"][number] => ({ schema_version: "1.0.0", requested_term: mapping.labels.en, role, status: "resolved",
  ...(conditionId ? { condition_id: conditionId, semantic_condition: { condition_id: conditionId, source_text: mapping.labels.en, kind: "concept" as const, concept: mapping.labels.en, assertion: "present" as const } } : {}),
  candidates: [{ candidate_id: mapping.mapping_id, requested_term: mapping.labels.en, normalized_term: mapping.labels.en, role, mapping, match_basis: ["validated_mapping"], confidence: "high", requires_clinician_confirmation: false, explanation: "validated" }] });
const creatinine = record("Creatinine", "labevents", ["subject_id", "hadm_id", "itemid", "charttime", "valuenum"], "continuous", "laboratory");
creatinine.sources[0] = { ...creatinine.sources[0]!, kind: "dictionary_item", dictionary_table: "d_labitems", item_ids: [50912] }; creatinine.definition.aggregation = "first";
const review: StudyVariableMappingReview = { schema_version: "1.0.0", status: "ready", summary: { resolved: 7, needs_confirmation: 0, unmapped: 0 }, verification_available: true, variables: [
  resolved("population", record("Heart failure", "admissions", ["subject_id", "hadm_id"], "categorical", "diagnosis"), "population.target"),
  resolved("index_time", record("hospital admission", "admissions", ["subject_id", "hadm_id", "admittime"], "categorical", "encounter")),
  resolved("exposure", record("Sex", "patients", ["subject_id", "gender"], "categorical", "demographic")),
  resolved("covariate", record("Age", "patients", ["subject_id", "anchor_age"], "continuous", "demographic"), "characteristic.1"),
  resolved("covariate", creatinine, "characteristic.2"),
  resolved("outcome", record("In-hospital mortality", "admissions", ["subject_id", "hadm_id", "hospital_expire_flag", "deathtime"], "binary", "outcome"), "characteristic.3"),
  resolved("covariate", record("Charlson comorbidity index", "admissions", ["subject_id", "hadm_id", "charlson"], "continuous", "score")),
] };
const rows = Array.from({ length: 400 }, (_, index) => ({ analysis_id: String(index), exposure: index % 2 ? "F" : "M", characteristic_0: 40 + (index % 50), ...(index % 5 ? { characteristic_1: 0.6 + (index % 17) / 10 } : {}), characteristic_2: index % 7 === 0, covariate_0: index % 6 }));
const runner = { run: async () => ({ rows, columns: [
  { column: "exposure", role: "exposure" as const, requested_label: "Sex", mapping_id: "Sex", value_type: "categorical" as const },
  { column: "characteristic_0", role: "covariate" as const, characteristic: true, requested_label: "Age", mapping_id: "Age", value_type: "continuous" as const },
  { column: "characteristic_1", role: "covariate" as const, characteristic: true, requested_label: "Creatinine", mapping_id: "Creatinine", value_type: "continuous" as const },
  { column: "characteristic_2", role: "outcome" as const, characteristic: true, requested_label: "In-hospital mortality", mapping_id: "In-hospital mortality", value_type: "binary" as const },
  { column: "covariate_0", role: "covariate" as const, requested_label: "Charlson comorbidity index", mapping_id: "Charlson comorbidity index", value_type: "continuous" as const },
], quality: { source_rows: {}, analysis_units: 450, complete_rows: 400, excluded_rows: 50, exclusion_reasons: { not_in_population: 50 } }, cohort_integrity_id: "sha256:simulated-description" }) };
const extraction = (overrides: Partial<FrameExtraction>): FrameExtraction => ({ goal: "describe", outcome_kind: "value", dose_question: false, population: "", exposure: "", exposure_categories: [], comparator: "", outcomes: [], composite_outcome: "", modifiers: [], mediators: [], predictors: [], time_window: "", ...overrides });

test("a description-only question reaches counts, Table 1 by group and each characteristic with its interval", { timeout: 300_000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), "question-description-test-"));
  try {
    const question = "按性别描述心衰住院患者的年龄、肌酐和住院死亡率";
    const frames = buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction({ population: "心衰住院患者", exposure: "性别", exposure_categories: ["男性", "女性"], outcomes: ["年龄", "肌酐", "住院死亡率"] }) });
    frames[0]!.population!.normalized = { label_en: "Heart failure", category: "diagnosis" };
    frames[0]!.exposure!.normalized = { label_en: "Sex", category: "demographic" };
    const labels: Record<string, { label_en: string; category: "demographic" | "laboratory" | "outcome" }> = { 年龄: { label_en: "Age", category: "demographic" }, 肌酐: { label_en: "Creatinine", category: "laboratory" }, 住院死亡率: { label_en: "In-hospital mortality", category: "outcome" } };
    for (const slot of frames[0]!.characteristics ?? []) slot.normalized = labels[slot.text]!;
    const frameSet: StudyFrameSet = { schema_version: "1.0.0", original_question: question, frames };
    const mapping: PlanExecutionDependencies["mapping"] = { assess: async () => review };
    const service = new QuestionPipelineService({
      framing: { frame: async () => ({ frame_set: frameSet, audits: [] }) }, model: "test-model", data_source: { id: "simulated", version: "test" },
      catalog, archive_path: "/unused.zip", mapping, runner, executor: new RStudyMethodExecutor({ timeout_ms: 120_000 }), output_dir: output,
      result_checks: await new FileResultCheckRulesRepository(new URL("../../../../config/result-checks/result-checks.json", import.meta.url)).load(),
    });
    const result = await service.run(question);
    const plan = result.plans[0]!;
    assert.equal(result.plans.length, 1);
    assert.equal(plan.status, "completed", JSON.stringify(plan.blockers));
    assert.equal(plan.chosen_method, "descriptive.summary");
    assert.equal(plan.cohort?.rows, 400);
    assert.equal(plan.result?.n_analysed, 400, "no row is dropped for a missing characteristic");
    // The manifest marks each characteristic; the death rate is a record presence, not the outcome.
    assert.equal(plan.manifest?.status, "ready");
    // Each characteristic overall and in each sex, with intervals.
    const estimate = (label: string) => plan.result!.estimates.find((row) => row.label === label);
    const death = estimate("In-hospital mortality (overall)");
    assert.equal(death?.measure, "proportion");
    assert.ok(death && Number(death.ci_low) < Number(death.estimate) && Number(death.estimate) < Number(death.ci_high));
    assert.equal(estimate("Creatinine in Sex = F")?.measure, "mean");
    assert.equal(estimate("Sex: F (overall)")?.measure, "proportion", "each group's share of the cohort");
    // Table 1 by group, with a missing column.
    const table1 = plan.result!.tables.table1!;
    assert.deepEqual(Object.keys(table1[0]!), ["variable", "overall", "Sex = F", "Sex = M", "missing"]);
    assert.ok(table1.some((row) => row.variable === "Charlson comorbidity index"), "the default Table 1 variables are listed");
    assert.equal(table1.find((row) => row.variable === "Creatinine")?.missing, "80");
    // Checks: nothing reads the death rate as an outcome, nothing fails.
    const checks = new Map(plan.quality!.checks.map((check) => [check.check_id, check]));
    assert.equal(checks.has("outcome_events"), false);
    assert.equal(checks.has("effect_size_plausible"), false);
    assert.equal(checks.get("characteristics_recorded")?.status, "pass");
    assert.notEqual(plan.quality!.status, "fail");
    // The headline is the description; it adds no P value to a multiple-comparison family.
    const headline = planHeadline(plan);
    assert.equal(headline.kind, "description");
    assert.equal(familyPValue(plan), undefined);
    assert.equal(result.multiplicity, undefined);
    // The protocol and the report describe a description, in both languages.
    assert.ok(plan.protocol?.elements.some(({ label }) => label.en === "Characteristics described"));
    assert.deepEqual(plan.protocol?.design_checks, []);
    const english = renderMarkdown(buildReportDocument(result, "en"), output); const chinese = renderMarkdown(buildReportDocument(result, "zh"), output);
    assert.match(english, /Characteristics described/u);
    assert.match(english, /400 patients: /u);
    assert.match(english, /a difference between groups is not an effect/u);
    assert.doesNotMatch(english, /not proof of causation/u);
    assert.match(chinese, /描述的特征/u);
    assert.match(chinese, /共 400 例患者/u);
    assert.match(chinese, /住院死亡率（总体）/u, "the characteristic is labelled with the researcher's own words");
    // Sex and age are recorded for the patient, not read in the first 24 hours (review of 2026-11-04).
    assert.match(english, /\| Grouping \| Sex: Sex as recorded for the patient \(a demographic attribute, not read in a time window\)\. \|/u);
    assert.match(english, /Age: Age as recorded for the patient \(a demographic attribute, not read in a time window\)\./u);
    assert.doesNotMatch(english, /Sex within the first 24 hours|Age as its variable definition specifies, read within/u);
    assert.match(chinese, /\| 分组 \| 性别：患者记录的性别（人口学属性，不按时间窗读取） \|/u);
    assert.match(chinese, /年龄：患者记录的年龄（人口学属性，不按时间窗读取）/u);
    assert.match(chinese, /肌酐：时间零点后 0–24 小时内/u, "a laboratory value keeps its window");
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("a description's dataset has no events, so no method is unavailable for an outcome that 'does not vary'", () => {
  const profile = profileDataset(rows, { covariates: [], predictors: [] }, "binary", true);
  assert.equal(profile.events, undefined);
  assert.equal(profileDataset(rows, { covariates: [], predictors: [] }, "binary").events, 0, "other designs keep their event count");
});
