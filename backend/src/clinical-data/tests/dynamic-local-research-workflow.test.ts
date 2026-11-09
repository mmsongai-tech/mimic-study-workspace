import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ExecutionManifest } from "../../execution-manifest/index.js";
import type { StudyVariableMappingReview } from "../../variable-mapping/index.js";
import { DynamicLocalResearchWorkflow } from "../index.js";

const study = { schema_version: "1.0.0" as const, intent_family: "association" as const, research_question: "Dynamic question", population: { description: "Adults", criteria: { condition_id: "population.adult", source_text: "Adult at admission", kind: "concept" as const, concept: "Adult", assertion: "present" as const } }, index_time: { event: "Admission", selection_rule: "First eligible admission" }, exposure_or_predictors: [{ name: "Exposure", role: "exposure" as const, operational_definition: "Recorded exposure", definition: { condition_id: "exposure.recorded", source_text: "Recorded exposure", kind: "event_exists" as const, concept: "Exposure", occurrence: "present" as const } }], outcome: { name: "Outcome", role: "outcome" as const, operational_definition: "Recorded outcome", definition: { condition_id: "outcome.recorded", source_text: "Recorded binary outcome", kind: "concept" as const, concept: "Outcome", assertion: "present" as const } }, outcome_structure: "binary" as const, time_windows: [{ purpose: "outcome" as const, anchor: "index_time" as const, start_offset: 0, end_offset: 1, unit: "day" as const }], estimand: { target_population: "Adults", exposure_contrast: "Exposed versus unexposed", outcome_measure: "Risk", summary_measure: "Odds ratio" }, analysis_family: "association" as const };
const ready: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:ready", study_integrity_id: "sha256:study", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: "mimiciv_hosp.admissions", column: "hadm_id" }, sources: [], joins: [], variables: [], time_windows: [], blockers: [] };
const publication_outputs = { tables: ["table_1", "primary_results", "model_diagnostics", "sensitivity_analysis"].map((id) => ({ id, title: id, columns: ["name"], rows: [["value"]] })), listings: [{ id: "cohort_flow", title: "Cohort flow", columns: ["stage"], rows: [["complete"]], privacy: "aggregate_only" as const }], figures: [{ id: "effect", title: "Effect", mime_type: "image/svg+xml" as const, content: "<svg></svg>" }] };
const input = { study, mapping: { schema_version: "1.0.0" as const, status: "ready" as const, variables: [], summary: { resolved: 0, needs_confirmation: 0, unmapped: 0 }, verification_available: true }, catalog: { schema_version: "1.0.0" as const, data_model: "MIMIC-IV" as const, source_service: "test", relations: [], relation_count: 0, column_count: 0, inspected_at: "2026-09-08T00:00:00.000Z" }, archive_path: "/not-read", provenance: { data_source_id: "local", data_source_version: "3.1", archive_sha256: `sha256:${"a".repeat(64)}` } };

test("creates a reproducible completed report from one manifest-bound run", async () => {
  const workflow = new DynamicLocalResearchWorkflow({
    compile: () => ready,
    runner: { run: async () => ({ rows: Array.from({ length: 20 }, (_, index) => ({ analysis_id: String(index), exposure: index % 2 === 0, outcome: index % 3 === 0 })), quality: { source_rows: { admissions: 20 }, analysis_units: 20, complete_rows: 20, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "sha256:cohort" }) },
    statistics: { execute: async () => ({ status: "completed", study_family: "association", outcome_structure: "binary", registered_method_id: "association.binary.v1", registered_method_version: "1.0.0", method: "generic", counts: { total: 1 }, estimates: { estimate: 1 }, diagnostics: { converged: true, parameters: 1 }, sensitivity: { analysis: "crude", estimate: 1 }, publication_outputs, runtime: { language: "r", version: "4.5" } }) },
    now: () => new Date("2026-09-08T00:00:00.000Z"),
  });
  const first = await workflow.run(input); const second = await workflow.run(input);
  assert.equal(first.artifact.status, "completed"); assert.equal(first.artifact.reproducibility_id, second.artifact.reproducibility_id); assert.match(first.report_markdown, /Statistical result/u);
  const schema = JSON.parse(readFileSync(new URL("../../../../contracts/research-execution/dynamic-local-run.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(first.artifact), true, JSON.stringify(validate.errors));
});

test("executes a legacy narrative outcome only when a reviewed outcome mapping is bound in the ready manifest", async () => {
  const { definition: _definition, ...legacyOutcome } = structuredClone(study.outcome);
  const legacyStudy = { ...structuredClone(study), outcome: legacyOutcome };
  const outcomeMapping = {
    schema_version: "1.0.0" as const,
    mapping_id: "mapping:reviewed-outcome",
    concept_id: "reviewed_outcome",
    mapping_version: "1",
    labels: { en: "Reviewed outcome" },
    synonyms: [],
    category: "outcome" as const,
    value_type: "binary" as const,
    definition: { summary: "Reviewed binary outcome", temporal_rule: "During encounter", value_rule: "Recorded flag", missingness_rule: "Exclude missing" },
    sources: [{ kind: "direct_field" as const, schema: "mimiciv_hosp" as const, table: "admissions", columns: ["hadm_id", "hospital_expire_flag"] }],
    status: "validated" as const,
    provenance: "team_validation" as const,
    evidence: {},
    created_at: "2026-09-15T00:00:00.000Z",
    updated_at: "2026-09-15T00:00:00.000Z",
  };
  const mapping: StudyVariableMappingReview = {
    ...input.mapping,
    summary: { resolved: 1, needs_confirmation: 0, unmapped: 0 },
    variables: [{
      schema_version: "1.0.0" as const,
      requested_term: "Outcome",
      role: "outcome" as const,
      status: "resolved" as const,
      candidates: [{ candidate_id: "candidate:reviewed-outcome", requested_term: "Outcome", normalized_term: "outcome", role: "outcome" as const, mapping: outcomeMapping, match_basis: ["validated_mapping" as const], confidence: "high" as const, requires_clinician_confirmation: false, explanation: "Validated outcome mapping" }],
    }],
  };
  const manifest: ExecutionManifest = { ...ready, variables: [{ role: "outcome", requested_label: "Outcome", mapping_id: outcomeMapping.mapping_id, mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, temporal_rule: "During encounter", missingness_rule: "Exclude missing" }] };
  const workflow = new DynamicLocalResearchWorkflow({
    compile: () => manifest,
    runner: { run: async () => ({ rows: Array.from({ length: 20 }, (_, index) => ({ analysis_id: String(index), exposure: index % 2 === 0, outcome: index % 3 === 0 })), quality: { source_rows: { admissions: 20 }, analysis_units: 20, complete_rows: 20, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "sha256:legacy-outcome" }) },
    statistics: { execute: async () => ({ status: "completed", study_family: "association", outcome_structure: "binary", registered_method_id: "association.binary.v1", registered_method_version: "1.0.0", method: "generic", counts: { total: 20 }, estimates: { estimate: 1 }, diagnostics: { converged: true, parameters: 1 }, sensitivity: { analysis: "crude", estimate: 1 }, publication_outputs, runtime: { language: "r", version: "4.5" } }) },
    now: () => new Date("2026-09-15T00:00:00.000Z"),
  });

  const result = await workflow.run({ ...input, study: legacyStudy, mapping });
  assert.equal(result.artifact.status, "completed");
  assert.ok(result.artifact.warnings.some((warning) => warning.startsWith("STRUCTURED_OUTCOME_RESOLVED_BY_MAPPING")));
  assert.equal(result.artifact.study.outcome?.definition, undefined);
});

test("creates a terminal blocked report without reading data", async () => {
  let read = false; const blocked: ExecutionManifest = { ...ready, status: "blocked", blockers: [{ code: "MAPPING_UNRESOLVED", message: "No evidence" }] };
  const workflow = new DynamicLocalResearchWorkflow({ compile: () => blocked, runner: { run: async () => { read = true; throw new Error("unreachable"); } }, statistics: { execute: async () => { throw new Error("unreachable"); } }, now: () => new Date("2026-09-08T00:00:00.000Z") });
  const result = await workflow.run(input); assert.equal(result.artifact.status, "blocked"); assert.equal(read, false); assert.match(result.report_markdown, /MAPPING_UNRESOLVED/u);
});

test("does not read local data while a variable mapping still needs confirmation", async () => {
  let read = false;
  const workflow = new DynamicLocalResearchWorkflow({ compile: () => ready, runner: { run: async () => { read = true; throw new Error("unreachable"); } }, statistics: { execute: async () => { throw new Error("unreachable"); } }, now: () => new Date("2026-09-08T00:00:00.000Z") });
  const result = await workflow.run({ ...input, mapping: { ...input.mapping, status: "needs_confirmation" } });
  assert.equal(result.artifact.status, "blocked"); assert.equal(read, false); assert.equal(result.artifact.blockers[0]?.code, "MAPPING_REVIEW_REQUIRED");
});

test("retains safe variable-level mapping review reasons in a blocked report", async () => {
  const workflow = new DynamicLocalResearchWorkflow({ compile: () => ready, runner: { run: async () => { throw new Error("unreachable"); } }, statistics: { execute: async () => { throw new Error("unreachable"); } }, now: () => new Date("2026-09-08T00:00:00.000Z") });
  const mapping = { ...input.mapping, status: "blocked" as const, variables: [{ schema_version: "1.0.0" as const, requested_term: "研究变量", role: "exposure" as const, status: "unmapped" as const, candidates: [], reason: "Automated review found insufficient supplied dictionary evidence." }], summary: { resolved: 0, needs_confirmation: 0, unmapped: 1 } };
  const result = await workflow.run({ ...input, mapping });
  assert.equal(result.artifact.status, "blocked");
  assert.match(result.report_markdown, /研究变量/u);
  assert.match(result.report_markdown, /insufficient supplied dictionary evidence/u);
});

test("does not let allow_database_verified bypass candidate-level clinical confirmation", async () => {
  let read = false;
  const workflow = new DynamicLocalResearchWorkflow({ compile: () => ready, runner: { run: async () => { read = true; throw new Error("unreachable"); } }, statistics: { execute: async () => { throw new Error("unreachable"); } }, now: () => new Date("2026-09-08T00:00:00.000Z") });
  const mapping = { schema_version: "1.0.0" as const, status: "needs_confirmation" as const, summary: { resolved: 0, needs_confirmation: 1, unmapped: 0 }, verification_available: true, variables: [{ schema_version: "1.0.0" as const, requested_term: "Generic concept", role: "exposure" as const, status: "needs_confirmation" as const, candidates: [{ candidate_id: "candidate:generic", requested_term: "Generic concept", normalized_term: "generic concept", role: "exposure" as const, mapping: { schema_version: "1.0.0" as const, mapping_id: "mapping:generic", concept_id: "generic", mapping_version: "1", labels: { en: "Generic" }, synonyms: [], category: "laboratory" as const, value_type: "continuous" as const, definition: { summary: "Generic", temporal_rule: "At index", value_rule: "Recorded", missingness_rule: "Exclude" }, sources: [], status: "database_verified" as const, provenance: "realtime_discovery" as const, evidence: {}, created_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z" }, match_basis: ["database_dictionary" as const], confidence: "medium" as const, requires_clinician_confirmation: true, explanation: "Needs review" }] }] };
  const result = await workflow.run({ ...input, mapping, allow_database_verified: true });
  assert.equal(result.artifact.status, "blocked");
  assert.equal(read, false);
  assert.ok(result.artifact.blockers.some(({ code }) => code === "MAPPING_REVIEW_REQUIRED"));
});

test("omits only unsupported ordinary covariates while preserving a warning and executable core variables", async () => {
  let compiledCovariates: string[] = [];
  const unresolved = { schema_version: "1.0.0" as const, requested_term: "Optional baseline measure", role: "covariate" as const, status: "unmapped" as const, candidates: [], reason: "No local evidence" };
  const mapping = { ...input.mapping, status: "blocked" as const, variables: [unresolved], summary: { resolved: 0, needs_confirmation: 0, unmapped: 1 } };
  const workflow = new DynamicLocalResearchWorkflow({
    compile: ({ study: preparedStudy }) => { compiledCovariates = (preparedStudy.covariates ?? []).map(({ name }) => name); return ready; },
    runner: { run: async () => ({ rows: Array.from({ length: 20 }, (_, index) => ({ analysis_id: String(index), exposure: index % 2 === 0, outcome: index % 3 === 0 })), quality: { source_rows: { admissions: 20 }, analysis_units: 20, complete_rows: 20, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "sha256:optional" }) },
    statistics: { execute: async () => ({ status: "completed", study_family: "association", outcome_structure: "binary", registered_method_id: "association.binary.v1", registered_method_version: "1.0.0", method: "generic", counts: { total: 20 }, estimates: { estimate: 1 }, diagnostics: { converged: true, parameters: 1 }, sensitivity: { analysis: "crude", estimate: 1 }, publication_outputs, runtime: { language: "r", version: "4.5" } }) },
    now: () => new Date("2026-09-14T00:00:00.000Z"),
  });
  const result = await workflow.run({ ...input, study: { ...study, covariates: [{ name: "Optional baseline measure", role: "covariate", operational_definition: "Before index" }] }, mapping });
  assert.equal(result.artifact.status, "completed");
  assert.deepEqual(compiledCovariates, []);
  assert.match(result.artifact.warnings[0] ?? "", /PRESPECIFIED_COVARIATES_OMITTED/u);
});

test("does not omit an unresolved effect modifier", async () => {
  let read = false;
  const unresolved = { schema_version: "1.0.0" as const, requested_term: "Modifier", role: "covariate" as const, status: "unmapped" as const, candidates: [], reason: "No local evidence" };
  const mapping = { ...input.mapping, status: "blocked" as const, variables: [unresolved], summary: { resolved: 0, needs_confirmation: 0, unmapped: 1 } };
  const workflow = new DynamicLocalResearchWorkflow({ compile: () => ready, runner: { run: async () => { read = true; throw new Error("unreachable"); } }, statistics: { execute: async () => { throw new Error("unreachable"); } }, now: () => new Date("2026-09-14T00:00:00.000Z") });
  const result = await workflow.run({ ...input, study: { ...study, covariates: [{ name: "Modifier", role: "covariate", operational_definition: "Before index" }], effect_modifiers: [{ variable_name: "Modifier", analysis: "interaction_and_stratified" }] }, mapping });
  assert.equal(result.artifact.status, "blocked");
  assert.equal(read, false);
  assert.ok(result.artifact.blockers.some(({ code }) => code === "VARIABLE_UNMAPPED"));
});

test("retains local-data evidence and suppresses executor internals when statistics fail", async () => {
  const workflow = new DynamicLocalResearchWorkflow({
    compile: () => ready,
    runner: { run: async () => ({ rows: [{ analysis_id: "1", exposure: true, outcome: true }], quality: { source_rows: { admissions: 1 }, analysis_units: 1, complete_rows: 1, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "sha256:cohort" }) },
    statistics: { execute: async () => { throw new Error("Command failed at /private/secret/path"); } },
    now: () => new Date("2026-09-08T00:00:00.000Z"),
  });
  const result = await workflow.run(input);
  assert.equal(result.artifact.status, "blocked");
  assert.equal(result.artifact.evidence_level, "local_mimic_archive_execution");
  assert.equal(result.artifact.cohort?.complete_rows, 1);
  assert.doesNotMatch(JSON.stringify(result), /private\/secret/u);
});

test("blocks sparse cohorts before invoking the registered R method", async () => {
  let invoked = false;
  const workflow = new DynamicLocalResearchWorkflow({ compile: () => ready, runner: { run: async () => ({ rows: Array.from({ length: 12 }, (_, index) => ({ analysis_id: String(index), exposure: index % 2, outcome: index % 3 === 0 })), quality: { source_rows: { admissions: 12 }, analysis_units: 12, complete_rows: 12, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "sha256:sparse" }) }, statistics: { execute: async () => { invoked = true; throw new Error("unreachable"); } }, now: () => new Date("2026-09-08T00:00:00.000Z") });
  const result = await workflow.run(input);
  assert.equal(invoked, false);
  assert.equal(result.artifact.blockers[0]?.code, "INSUFFICIENT_COMPLETE_RECORDS");
});

test("uses the fixed reduced-adjustment fallback when one non-modifier covariate makes the association model infeasible", async () => {
  const adjustedManifest: ExecutionManifest = { ...ready, variables: [
    { role: "covariate", requested_label: "well observed", mapping_id: "covariate:well", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "continuous", value_rule: { kind: "direct", column: "well" }, temporal_rule: "baseline", missingness_rule: "explicit" },
    { role: "covariate", requested_label: "sparse covariate", mapping_id: "covariate:sparse", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "continuous", value_rule: { kind: "direct", column: "sparse" }, temporal_rule: "baseline", missingness_rule: "explicit" },
  ] };
  let receivedRows: Array<Record<string, unknown>> = [];
  const workflow = new DynamicLocalResearchWorkflow({
    compile: () => adjustedManifest,
    runner: { run: async () => ({ rows: Array.from({ length: 25 }, (_, index) => ({ analysis_id: String(index), exposure: index % 2 === 0, outcome: index % 3 === 0, covariate_0: index, ...(index < 5 ? { covariate_1: index } : {}) })), quality: { source_rows: { admissions: 25 }, analysis_units: 25, complete_rows: 5, excluded_rows: 20, exclusion_reasons: { incomplete_model_variables: 20 } }, cohort_integrity_id: "sha256:adjusted" }) },
    statistics: { execute: async ({ rows }) => { receivedRows = rows; return { status: "completed", study_family: "association", outcome_structure: "binary", registered_method_id: "association.binary.v1", registered_method_version: "1.0.0", method: "multivariable_logistic_regression", counts: { total: rows.length }, estimates: { estimate: 1 }, diagnostics: { converged: true, parameters: 2 }, sensitivity: { analysis: "crude", estimate: 1 }, publication_outputs, runtime: { language: "r", version: "4.5" } }; } },
    now: () => new Date("2026-09-14T00:00:00.000Z"),
  });
  const result = await workflow.run(input);
  assert.equal(result.artifact.status, "completed");
  assert.equal(receivedRows.length, 25);
  assert.equal(receivedRows.some((row) => "covariate_1" in row), false);
  assert.match(result.artifact.warnings[0] ?? "", /PRIMARY_ADJUSTMENT_REDUCED/u);
  assert.equal(result.artifact.diagnostic_decision, "reportable_with_warnings");
});

test("attributes code-prefix warnings only to the manifest-selected variable identity", async () => {
  const codeMapping = {
    schema_version: "1.0.0" as const, mapping_id: "mapping:codes", concept_id: "codes", mapping_version: "1", labels: { en: "Code set" }, synonyms: [], category: "diagnosis" as const, value_type: "binary" as const,
    definition: { summary: "Code set", temporal_rule: "During encounter", value_rule: "Any code", missingness_rule: "No recorded code" },
    sources: [{ kind: "diagnosis_code" as const, schema: "mimiciv_hosp" as const, table: "diagnoses_icd", columns: ["subject_id", "hadm_id", "icd_code", "icd_version"], dictionary_table: "d_icd_diagnoses" as const, codes: [{ code: "A100", version: 10 as const }] }],
    status: "database_verified" as const, provenance: "realtime_discovery" as const,
    evidence: { semantic_code_hints: { requested_prefixes: ["A10", "B20"], checked_prefixes: ["A10", "B20"], matched_prefixes: ["A10"], match_mode: "dictionary_prefix" as const } },
    created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  };
  const candidate = (role: "population" | "exposure", requestedTerm: string, conditionId: string) => ({
    schema_version: "1.0.0" as const, requested_term: requestedTerm, role, condition_id: conditionId, status: "resolved" as const,
    candidates: [{ candidate_id: `candidate:${role}`, requested_term: requestedTerm, normalized_term: requestedTerm, role, mapping: codeMapping, match_basis: ["database_dictionary" as const], confidence: "medium" as const, requires_clinician_confirmation: false, explanation: "Verified" }],
  });
  const selectedManifest: ExecutionManifest = { ...ready, variables: [{ role: "exposure", condition_id: "exposure.codes", requested_label: "Exposure", mapping_id: codeMapping.mapping_id, mapping_version: "1", source_id: "mimiciv_hosp.diagnoses_icd", value_type: "binary", value_rule: { kind: "codes", code_column: "icd_code", version_column: "icd_version", codes: [{ code: "A100", version: 10 }] }, temporal_rule: "During encounter", missingness_rule: "No recorded code" }] };
  const mapping = { ...input.mapping, variables: [candidate("population", "Adults", "population.codes"), candidate("exposure", "Exposure", "exposure.codes")], summary: { resolved: 2, needs_confirmation: 0, unmapped: 0 } };
  const workflow = new DynamicLocalResearchWorkflow({
    compile: () => selectedManifest,
    runner: { run: async () => ({ rows: Array.from({ length: 20 }, (_, index) => ({ analysis_id: String(index), exposure: index % 2 === 0, outcome: index % 3 === 0 })), quality: { source_rows: { diagnoses_icd: 20 }, analysis_units: 20, complete_rows: 20, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "sha256:codes" }) },
    statistics: { execute: async () => ({ status: "completed", study_family: "association", outcome_structure: "binary", registered_method_id: "association.binary.v1", registered_method_version: "1.0.0", method: "generic", counts: { total: 20 }, estimates: { estimate: 1 }, diagnostics: { converged: true, parameters: 1 }, sensitivity: { analysis: "crude", estimate: 1 }, publication_outputs, runtime: { language: "r", version: "4.5" } }) },
    now: () => new Date("2026-09-14T00:00:00.000Z"),
  });
  const result = await workflow.run({ ...input, mapping });
  assert.equal(result.artifact.warnings.length, 1);
  assert.match(result.artifact.warnings[0] ?? "", /^exposure /u);
  assert.doesNotMatch(result.artifact.warnings[0] ?? "", /population/u);
});
