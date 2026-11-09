import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { DynamicLocalRunBundle } from "../clinical-data/index.js";
import type { ObjectiveCoverageReview, ResearchObjectiveList } from "../research-objectives/index.js";
import { MultiObjectiveReportError, MultiObjectiveReportService } from "./index.js";

const objectiveList: ResearchObjectiveList = {
  schema_version: "1.0.0",
  original_question: "比较治疗效果和死亡，并评估性别修饰作用",
  objectives: [
    { objective_id: "bp", purpose: "treatment_effect", relationship: "primary", question: "治疗对血压的影响", population: "目标人群", exposure_or_predictors: ["治疗"], comparator: "未治疗", outcome: "血压", effect_modifiers: [], source_claims: ["比较降压效果"] },
    { objective_id: "death", purpose: "treatment_effect", relationship: "secondary", question: "治疗对死亡的影响", population: "目标人群", exposure_or_predictors: ["治疗"], comparator: "未治疗", outcome: "死亡", effect_modifiers: [], source_claims: ["比较死亡"] },
    { objective_id: "sex", purpose: "treatment_effect", relationship: "effect_modification", question: "性别是否修饰治疗效果", population: "目标人群", exposure_or_predictors: ["治疗"], comparator: "未治疗", outcome: "血压", effect_modifiers: ["性别"], source_claims: ["评估性别修饰"] },
  ],
  ambiguities: [],
};
const coverage: ObjectiveCoverageReview = { schema_version: "1.0.0", decision: "pass", covered_claims: ["all"], missing_claims: [], altered_claims: [], unsupported_additions: [], explanation: "Covered" };
const completedRun = (suffix: string): DynamicLocalRunBundle => ({
  artifact: {
    schema_version: "2.0.0", run_id: `run:${suffix.repeat(20).slice(0, 20)}`, created_at: "2026-09-10T00:00:00.000Z", status: "completed", evidence_level: "local_mimic_archive_execution",
    study: {} as DynamicLocalRunBundle["artifact"]["study"], manifest: {} as DynamicLocalRunBundle["artifact"]["manifest"],
    data_provenance: { data_source_id: "local", data_source_version: "3.1", archive_sha256: `sha256:${"a".repeat(64)}` }, diagnostic_decision: "reportable", blockers: [], warnings: [],
    cohort: { source_rows: { admissions: 10 }, analysis_units: 10, complete_rows: 9, excluded_rows: 1, exclusion_reasons: { missing: 1 }, cohort_integrity_id: "sha256:cohort" },
    analysis: { status: "completed", study_family: "treatment_effect", outcome_structure: "binary", registered_method_id: "treatment_effect.binary.v1", registered_method_version: "1.0.0", method: "fixed_method", counts: { total: 9 }, estimates: { estimate: 0.5 }, diagnostics: { converged: true }, sensitivity: { analysis: "complete_case", estimate: 0.5 }, publication_outputs: { tables: [], listings: [], figures: [] }, runtime: { language: "r", version: "4.5" } },
    reproducibility_id: `sha256:${suffix.repeat(64).slice(0, 64)}`, integrity_id: `sha256:${suffix.repeat(64).slice(0, 64)}`,
  },
  report_markdown: "# Child report",
});

test("creates a schema-valid partial report while preserving objective order and evidence", () => {
  const service = new MultiObjectiveReportService(() => new Date("2026-09-10T00:00:00.000Z"));
  const bundle = service.create({ objective_list: objectiveList, coverage_review: coverage, terminal_results: [
    { objective_id: "sex", result: { status: "blocked", stage: "variable_mapping", code: "MAPPING_NOT_FOUND", message: "No verified sex mapping." } },
    { objective_id: "bp", result: completedRun("b") },
    { objective_id: "death", result: completedRun("d") },
  ] });
  assert.equal(bundle.artifact.status, "partial");
  assert.deepEqual(bundle.artifact.objectives.map(({ objective_id }) => objective_id), ["bp", "death", "sex"]);
  assert.deepEqual(bundle.artifact.objective_counts, { total: 3, completed: 2, blocked: 1 });
  assert.match(bundle.report_markdown, /MAPPING_NOT_FOUND/u);
  assert.match(bundle.report_markdown, /fixed_method/u);
  assert.doesNotMatch(bundle.report_markdown, /Child report/u);
  const schema = JSON.parse(readFileSync(new URL("../../../contracts/research-execution/multi-objective-report.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: true, formats: { "date-time": true } }).compile(schema);
  assert.equal(validate(bundle.artifact), true, JSON.stringify(validate.errors));
});

test("is reproducible across creation times while artifact integrity remains timestamp-bound", () => {
  const terminal_results = objectiveList.objectives.map(({ objective_id }, index) => ({ objective_id, result: completedRun(String(index + 1)) }));
  const first = new MultiObjectiveReportService(() => new Date("2026-09-10T00:00:00.000Z")).create({ objective_list: objectiveList, coverage_review: coverage, terminal_results });
  const repeated_results = terminal_results.map(({ objective_id, result }, index) => ({
    objective_id,
    result: {
      ...result,
      artifact: {
        ...result.artifact,
        created_at: "2026-09-11T00:00:00.000Z",
        integrity_id: `sha256:${String(index + 4).repeat(64).slice(0, 64)}`,
      },
    },
  }));
  const second = new MultiObjectiveReportService(() => new Date("2026-09-11T00:00:00.000Z")).create({ objective_list: objectiveList, coverage_review: coverage, terminal_results: repeated_results });
  assert.equal(first.artifact.status, "completed");
  assert.equal(first.artifact.reproducibility_id, second.artifact.reproducibility_id);
  assert.notEqual(first.artifact.objectives[0]?.run_integrity_id, second.artifact.objectives[0]?.run_integrity_id);
  assert.notEqual(first.artifact.integrity_id, second.artifact.integrity_id);
});

test("fails closed when any reviewed objective has no terminal result", () => {
  const service = new MultiObjectiveReportService(() => new Date("2026-09-10T00:00:00.000Z"));
  assert.throws(() => service.create({ objective_list: objectiveList, coverage_review: coverage, terminal_results: [{ objective_id: "bp", result: completedRun("b") }] }), (error: unknown) => error instanceof MultiObjectiveReportError && error.code === "OBJECTIVE_RESULTS_INCOMPLETE");
});

test("rejects duplicate and unknown objective results", () => {
  const service = new MultiObjectiveReportService(() => new Date("2026-09-10T00:00:00.000Z"));
  assert.throws(() => service.create({ objective_list: { ...objectiveList, objectives: [objectiveList.objectives[0]!] }, coverage_review: coverage, terminal_results: [
    { objective_id: "unknown", result: completedRun("a") },
  ] }), (error: unknown) => error instanceof MultiObjectiveReportError && error.code === "OBJECTIVE_RESULT_MISMATCH");
});
