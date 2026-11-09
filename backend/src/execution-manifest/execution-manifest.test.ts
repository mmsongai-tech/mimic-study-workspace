import assert from "node:assert/strict";
import test from "node:test";
import { compileExecutionManifest } from "./index.js";
import type { ClinicalDatabaseCatalog } from "../clinical-database/index.js";
import type { StudyVariableMappingReview, VariableMappingRecord } from "../variable-mapping/index.js";

const catalog: ClinicalDatabaseCatalog = { schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "local", inspected_at: "2026-09-08T00:00:00.000Z", relation_count: 2, column_count: 7, relations: [
  { schema: "mimiciv_hosp", name: "admissions", relation_type: "table", columns: ["subject_id", "hadm_id", "hospital_expire_flag", "itemid", "admittime"].map((name) => ({ name, data_type: "integer", nullable: false })) },
  { schema: "mimiciv_hosp", name: "patients", relation_type: "table", columns: ["subject_id", "anchor_age", "gender"].map((name) => ({ name, data_type: "text", nullable: false })) },
] };
const record = (id: string, table: string, columns: string[], value_type: VariableMappingRecord["value_type"]): VariableMappingRecord => ({ schema_version: "1.0.0", mapping_id: id, concept_id: id, mapping_version: "1", labels: { en: id }, synonyms: [], category: "outcome", value_type, definition: { summary: id, temporal_rule: "At admission", value_rule: "Source value", missingness_rule: "Exclude missing" }, sources: [{ kind: "direct_field", schema: "mimiciv_hosp", table, columns }], status: "validated", provenance: "team_validation", evidence: {}, created_at: "2026-09-08T00:00:00.000Z", updated_at: "2026-09-08T00:00:00.000Z" });
const review = (records: Array<{ role: "population" | "index_time" | "exposure" | "outcome" | "covariate"; mapping: VariableMappingRecord }>): StudyVariableMappingReview => ({ schema_version: "1.0.0", status: "ready", summary: { resolved: records.length, needs_confirmation: 0, unmapped: 0 }, verification_available: true, variables: records.map(({ role, mapping }) => ({ schema_version: "1.0.0", requested_term: mapping.labels.en, role, status: "resolved", candidates: [{ candidate_id: mapping.mapping_id, requested_term: mapping.labels.en, normalized_term: mapping.labels.en, role, mapping, match_basis: ["validated_mapping"], confidence: "high", requires_clinician_confirmation: false, explanation: "validated" }] })) });

test("compiles reviewed fields and catalog joins into a stable execution graph", () => {
  const input = { study: { schema_version: "1.0.0" as const, intent_family: "association" as const }, mapping: review([{ role: "exposure", mapping: record("age", "patients", ["subject_id", "anchor_age"], "continuous") }, { role: "outcome", mapping: record("mortality", "admissions", ["subject_id", "hadm_id", "hospital_expire_flag"], "binary") }]), catalog };
  const first = compileExecutionManifest(input); const second = compileExecutionManifest(input);
  assert.equal(first.status, "ready"); assert.equal(first.joins[0]?.left_column, "subject_id"); assert.equal(first.variables[0]?.value_rule.kind, "direct"); assert.equal(first.manifest_id, second.manifest_id);
});

test("blocks dictionary mappings without frozen identifiers", () => {
  const mapping = record("lab", "admissions", ["subject_id", "hadm_id", "hospital_expire_flag"], "continuous"); mapping.sources[0] = { ...mapping.sources[0]!, dictionary_table: "d_labitems" };
  const result = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "association" }, mapping: review([{ role: "exposure", mapping }]), catalog });
  assert.equal(result.status, "blocked"); assert.ok(result.blockers.some(({ code }) => code === "DICTIONARY_VALUES_UNRESOLVED"));
});

test("blocks a condition leaf without aggregate local-data evidence", () => {
  const age = record("age", "patients", ["subject_id", "anchor_age"], "continuous");
  const mapping = review([{ role: "exposure", mapping: age }]);
  mapping.variables[0]!.role = "population";
  mapping.variables[0]!.condition_id = "population.adult";
  mapping.variables[0]!.semantic_condition = { condition_id: "population.adult", source_text: "adult", kind: "numeric_comparison", concept: "age", operator: "gte", value: 18, unit: "year" };
  const result = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "association", population: { description: "Adults", criteria: mapping.variables[0]!.semantic_condition } }, mapping, catalog });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some(({ code, condition_id }) => code === "DATA_EVIDENCE_MISSING" && condition_id === "population.adult"));
});

test("normalizes reviewed categorical labels to source values", () => {
  const sex = record("sex", "patients", ["subject_id", "gender"], "categorical"); sex.definition.category_values = [{ source_value: "M", labels: ["男", "男性"] }, { source_value: "F", labels: ["女", "女性"] }]; sex.evidence.data_profile = { source_id: "mimiciv_hosp.patients", matched_record_count: 10, missing_value_count: 0, distinct_value_count: 2, units: [], top_values: [{ value: "M", count: 6 }, { value: "F", count: 4 }], profiled_at: "2026-09-08T00:00:00.000Z" };
  const mapping = review([{ role: "covariate", mapping: sex }]); mapping.variables[0]!.condition_id = "cov-sex"; mapping.variables[0]!.semantic_condition = { condition_id: "cov-sex", source_text: "性别", kind: "category_comparison", concept: "性别", operator: "in", values: ["男", "女"] };
  const result = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "treatment_effect", covariates: [{ name: "sex", role: "covariate", operational_definition: "sex", aggregation: "any", contrast: { kind: "as_recorded" } }], effect_modifiers: [{ variable_name: "sex", analysis: "interaction_and_stratified" }] }, mapping, catalog });
  assert.equal(result.status, "ready"); assert.deepEqual(result.variables[0]?.semantic_condition && "values" in result.variables[0].semantic_condition ? result.variables[0].semantic_condition.values : [], ["M", "F"]);
});

test("a population criterion on sex reads the gender field, not the patient identifier", () => {
  const sex = record("sex", "patients", ["subject_id", "gender"], "categorical"); sex.definition.category_values = [{ source_value: "M", labels: ["男", "男性"] }, { source_value: "F", labels: ["女", "女性"] }]; sex.evidence.data_profile = { source_id: "mimiciv_hosp.patients", matched_record_count: 10, missing_value_count: 0, distinct_value_count: 2, units: [], top_values: [{ value: "M", count: 6 }, { value: "F", count: 4 }], profiled_at: "2026-09-08T00:00:00.000Z" };
  const mapping = review([{ role: "population", mapping: sex }]); mapping.variables[0]!.condition_id = "population.sex";
  const condition = { condition_id: "population.sex", source_text: "女性", kind: "category_comparison" as const, concept: "Sex", operator: "in" as const, values: ["F"] };
  mapping.variables[0]!.semantic_condition = condition;
  const result = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "treatment_effect", population: { description: "Women", criteria: condition } }, mapping, catalog });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.variables[0]?.value_rule, { kind: "direct", column: "gender" });
});

test("defaults binary event item mappings to any and chooses a shared admission unit", () => {
  const medication = record("drug", "admissions", ["subject_id", "hadm_id", "itemid"], "binary"); medication.sources[0] = { kind: "dictionary_item", schema: "mimiciv_hosp", table: "admissions", columns: ["subject_id", "hadm_id", "itemid"], dictionary_table: "d_items", item_ids: [1] }; medication.status = "database_verified";
  const outcome = record("death", "admissions", ["subject_id", "hadm_id", "hospital_expire_flag"], "binary");
  const mapping = review([{ role: "exposure", mapping: medication }, { role: "outcome", mapping: outcome }]);
  const study = { schema_version: "1.0.0" as const, intent_family: "treatment_effect" as const, exposure_or_predictors: [{ name: "drug", role: "exposure" as const, operational_definition: "drug", contrast: { kind: "binary_presence" as const } }], outcome: { name: "death", role: "outcome" as const, operational_definition: "death", contrast: { kind: "binary_presence" as const } } };
  const result = compileExecutionManifest({ study, mapping, catalog, allowDatabaseVerified: true });
  assert.equal(result.variables.find(({ role }) => role === "exposure")?.aggregation, "any"); assert.equal(result.analysis_unit?.column, "hadm_id");
});

test("does not compile a database-verified candidate that still requires clinical confirmation", () => {
  const medication = record("drug-review", "admissions", ["subject_id", "hadm_id", "itemid"], "binary");
  medication.status = "database_verified";
  medication.sources[0] = { kind: "dictionary_item", schema: "mimiciv_hosp", table: "admissions", columns: ["subject_id", "hadm_id", "itemid"], dictionary_table: "d_items", item_ids: [1] };
  const mapping = review([{ role: "exposure", mapping: medication }]);
  mapping.status = "needs_confirmation";
  mapping.variables[0]!.status = "needs_confirmation";
  mapping.variables[0]!.candidates[0]!.requires_clinician_confirmation = true;
  const result = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "association" }, mapping, catalog, allowDatabaseVerified: true });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some(({ code }) => code === "MAPPING_UNRESOLVED"));
});

test("accepts a dictionary-verified code prefix set without relying on truncated top values", () => {
  const diagnosis = record("diagnosis", "admissions", ["subject_id", "hadm_id", "itemid"], "binary");
  diagnosis.status = "database_verified";
  diagnosis.provenance = "realtime_discovery";
  diagnosis.sources[0] = { kind: "diagnosis_code", schema: "mimiciv_hosp", table: "admissions", columns: ["subject_id", "hadm_id", "itemid"], dictionary_table: "d_icd_diagnoses", codes: [{ code: "A100", version: 10 }] };
  diagnosis.evidence.semantic_code_hints = { requested_prefixes: ["A10"], matched_prefixes: ["A10"], match_mode: "dictionary_prefix" };
  diagnosis.evidence.data_profile = { source_id: "mimiciv_hosp.admissions", matched_record_count: 25, missing_value_count: 0, distinct_value_count: 1, units: [], top_values: [], profiled_at: "2026-09-14T00:00:00.000Z" };
  const mapping = review([{ role: "population", mapping: diagnosis }]);
  mapping.variables[0]!.condition_id = "population.code-set";
  mapping.variables[0]!.semantic_condition = { condition_id: "population.code-set", source_text: "verified code family", kind: "category_comparison", concept: "diagnosis family", operator: "in", values: ["A10"] };
  mapping.variables[0]!.candidates[0]!.requires_clinician_confirmation = false;
  const result = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "association", population: { description: "coded population", criteria: mapping.variables[0]!.semantic_condition } }, mapping, catalog, allowDatabaseVerified: true });
  assert.equal(result.status, "ready");
  assert.equal(result.variables[0]?.semantic_condition?.kind, "concept");
});

test("blocks a declared matched prefix that has no frozen source code", () => {
  const diagnosis = record("invalid-prefix-evidence", "admissions", ["subject_id", "hadm_id", "itemid"], "binary");
  diagnosis.status = "database_verified";
  diagnosis.provenance = "realtime_discovery";
  diagnosis.sources[0] = { kind: "diagnosis_code", schema: "mimiciv_hosp", table: "admissions", columns: ["subject_id", "hadm_id", "itemid"], dictionary_table: "d_icd_diagnoses", codes: [{ code: "B200", version: 10 }] };
  diagnosis.evidence.semantic_code_hints = { requested_prefixes: ["A10"], matched_prefixes: ["A10"], match_mode: "dictionary_prefix" };
  diagnosis.evidence.data_profile = { source_id: "mimiciv_hosp.admissions", matched_record_count: 25, missing_value_count: 0, distinct_value_count: 1, units: [], top_values: [], profiled_at: "2026-09-14T00:00:00.000Z" };
  const mapping = review([{ role: "population", mapping: diagnosis }]);
  mapping.variables[0]!.condition_id = "population.invalid-code-set";
  mapping.variables[0]!.semantic_condition = { condition_id: "population.invalid-code-set", source_text: "invalid evidence", kind: "category_comparison", concept: "diagnosis family", operator: "in", values: ["A10"] };
  mapping.variables[0]!.candidates[0]!.requires_clinician_confirmation = false;
  const result = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "association", population: { description: "coded population", criteria: mapping.variables[0]!.semantic_condition } }, mapping, catalog, allowDatabaseVerified: true });
  assert.ok(result.blockers.some(({ code }) => code === "CATEGORY_VALUE_UNVERIFIED"));
});

test("freezes a reviewed measurement difference and its two windows", () => {
  const derived = record("derived-change", "admissions", ["subject_id", "hadm_id", "itemid", "admittime"], "continuous");
  derived.definition.derivation = { schema_version: "1.0.0", operator: "difference", baseline: { purpose: "baseline", aggregation: "first" }, follow_up: { purpose: "follow_up", aggregation: "first" }, direction: "baseline_minus_follow_up" };
  derived.evidence.data_profile = { source_id: "mimiciv_hosp.admissions", matched_record_count: 10, missing_value_count: 0, distinct_value_count: 5, units: [], top_values: [], profiled_at: "2026-09-14T00:00:00.000Z" };
  const mapping = review([{ role: "outcome", mapping: derived }]); mapping.variables[0]!.condition_id = "outcome.change";
  const study = { schema_version: "1.0.0" as const, intent_family: "association" as const, outcome: { name: "derived-change", role: "outcome" as const, operational_definition: "first change", definition: { condition_id: "outcome.change", source_text: "change", kind: "numeric_comparison" as const, concept: "generic_change", operator: "gt" as const, value: 0 } }, time_windows: [{ purpose: "baseline" as const, anchor: "index_time" as const, start_offset: -1, end_offset: 0, unit: "day" as const }, { purpose: "follow_up" as const, anchor: "index_time" as const, start_offset: 1, end_offset: 2, unit: "day" as const }] };
  const result = compileExecutionManifest({ study, mapping, catalog });
  assert.equal(result.status, "ready");
  assert.equal(result.variables[0]?.derivation?.direction, "baseline_minus_follow_up");
});

test("a validated condition mapping without an aggregate profile is not blocked", () => {
  const mortality = record("mortality", "admissions", ["subject_id", "hadm_id", "hospital_expire_flag"], "binary");
  const mapping = review([{ role: "outcome", mapping: mortality }]);
  mapping.variables[0]!.condition_id = "outcome.target";
  mapping.variables[0]!.semantic_condition = { condition_id: "outcome.target", source_text: "death", kind: "event_exists", concept: "death", occurrence: "present" };
  const validated = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "association" }, mapping, catalog });
  assert.ok(!validated.blockers.some(({ code }) => code === "DATA_EVIDENCE_MISSING"));
  mapping.variables[0]!.candidates[0]!.mapping = { ...mortality, status: "database_verified" };
  const unreviewed = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "association" }, mapping, catalog, allowDatabaseVerified: true });
  assert.ok(unreviewed.blockers.some(({ code }) => code === "DATA_EVIDENCE_MISSING"));
});

test("removes comorbidity-score groups that contain the exposure's own codes", () => {
  const diabetes = record("diabetes", "admissions", ["subject_id", "hadm_id", "itemid"], "binary");
  diabetes.sources[0] = { kind: "diagnosis_code", schema: "mimiciv_hosp", table: "admissions", columns: ["subject_id", "hadm_id", "itemid"], dictionary_table: "d_icd_diagnoses", codes: [{ code: "E119", version: 10 }, { code: "25000", version: 9 }] };
  const charlson = record("charlson", "admissions", ["subject_id", "hadm_id", "itemid"], "continuous");
  charlson.sources[0] = { kind: "diagnosis_code_score", schema: "mimiciv_hosp", table: "admissions", columns: ["subject_id", "hadm_id", "itemid"], score_groups: [
    { group_id: "mi", label: "Myocardial infarction", weight: 1, code_prefixes: [{ prefix: "I21", version: 10 }] },
    { group_id: "diabetes", label: "Diabetes", weight: 1, code_prefixes: [{ prefix: "E11", version: 10 }, { prefix: "250", version: 9 }] },
    { group_id: "diabetes_complicated", label: "Diabetes with complications", weight: 2, code_prefixes: [{ prefix: "E112", version: 10 }], supersedes: ["diabetes"] },
  ] } as typeof charlson.sources[0];
  const mortality = record("mortality", "admissions", ["subject_id", "hadm_id", "hospital_expire_flag"], "binary");
  const result = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "association" }, mapping: review([{ role: "exposure", mapping: diabetes }, { role: "outcome", mapping: mortality }, { role: "covariate", mapping: charlson }]), catalog });
  assert.equal(result.status, "ready", JSON.stringify(result.blockers));
  const score = result.variables.find(({ role }) => role === "covariate")!.value_rule;
  assert.equal(score.kind, "code_score");
  assert.deepEqual(score.kind === "code_score" ? score.groups.map(({ group_id }) => group_id) : [], ["mi", "diabetes_complicated"]);
  assert.deepEqual(score.kind === "code_score" ? score.groups[1]!.supersedes : undefined, []);
  assert.deepEqual(result.score_exclusions, [{ variable: "charlson", removed_groups: ["diabetes"], because_of: "diabetes" }]);
});

test("compiles a yes/no event covariate without an aggregation as any recorded event", () => {
  const vasopressors = record("vasopressors", "admissions", ["subject_id", "hadm_id", "itemid"], "binary");
  vasopressors.sources[0] = { kind: "dictionary_item", schema: "mimiciv_hosp", table: "admissions", columns: ["subject_id", "hadm_id", "itemid"], dictionary_table: "d_items", item_ids: [221906] };
  const mortality = record("mortality", "admissions", ["subject_id", "hadm_id", "hospital_expire_flag"], "binary");
  const age = record("age", "patients", ["subject_id", "anchor_age"], "continuous");
  const result = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "association" }, mapping: review([{ role: "exposure", mapping: age }, { role: "outcome", mapping: mortality }, { role: "covariate", mapping: vasopressors }]), catalog });
  assert.equal(result.status, "ready", JSON.stringify(result.blockers));
  assert.equal(result.variables.find(({ role }) => role === "covariate")?.aggregation, "any");
});

test("compiles a source with amount conversions into a weighted-amount rule that keeps every item/unit factor", () => {
  const dose = record("dose", "admissions", ["subject_id", "hadm_id", "itemid", "amount", "amountuom"], "continuous");
  dose.sources[0] = { kind: "dictionary_item", schema: "mimiciv_hosp", table: "admissions", columns: ["subject_id", "hadm_id", "itemid", "amount", "amountuom"], dictionary_table: "d_items", item_ids: [1, 2],
    amount_conversions: [{ item_id: 1, unit: "mg", factor: 1 }, { item_id: 2, unit: "mcg", factor: 0.1 }] };
  const outcome = record("death", "admissions", ["subject_id", "hadm_id", "hospital_expire_flag"], "binary");
  const study = { schema_version: "1.0.0" as const, intent_family: "association" as const, exposure_or_predictors: [{ name: "dose", role: "exposure" as const, operational_definition: "dose", contrast: { kind: "as_recorded" as const }, aggregation: "sum" as const }], outcome: { name: "death", role: "outcome" as const, operational_definition: "death", contrast: { kind: "binary_presence" as const } } };
  const withAmounts: ClinicalDatabaseCatalog = { ...catalog, relations: catalog.relations.map((relation) => relation.name === "admissions" ? { ...relation, columns: [...relation.columns, ...["amount", "amountuom"].map((name) => ({ name, data_type: "text", nullable: true }))] } : relation) };
  const result = compileExecutionManifest({ study, mapping: review([{ role: "exposure", mapping: dose }, { role: "outcome", mapping: outcome }]), catalog: withAmounts, allowDatabaseVerified: true });
  const rule = result.variables.find(({ role }) => role === "exposure")?.value_rule;
  assert.deepEqual(rule, { kind: "weighted_amount", id_column: "itemid", value_column: "amount", unit_column: "amountuom", conversions: [{ item_id: 1, unit: "mg", factor: 1 }, { item_id: 2, unit: "mcg", factor: 0.1 }] });
});

test("an admission-level analysis joins ICU tables on the admission, even when its first table also has an ICU stay column", () => {
  // Readmission analyses start from the derived events, whose admission-level events leave the stay empty; joined on the stay,
  // vasopressors and ventilation reached no patient (MIMIC questions 2.2, 2.4 and 2.9, 2026-10-27).
  type Schema = ClinicalDatabaseCatalog["relations"][number]["schema"];
  const relation = (schema: Schema, name: string, columns: string[]) => ({ schema, name, relation_type: "table" as const, columns: columns.map((column) => ({ name: column, data_type: "text", nullable: true })) });
  const icuCatalog: ClinicalDatabaseCatalog = { ...catalog, relation_count: 5, relations: [relation("mimiciv_derived", "derived_events", ["subject_id", "hadm_id", "stay_id", "flag"]), relation("mimiciv_hosp", "admissions", ["subject_id", "hadm_id", "admission_type"]), relation("mimiciv_hosp", "labevents", ["subject_id", "hadm_id", "valuenum"]), relation("mimiciv_hosp", "prescriptions", ["subject_id", "hadm_id", "drug"]), relation("mimiciv_icu", "inputevents", ["subject_id", "hadm_id", "stay_id", "amount"])] };
  const at = (id: string, schema: Schema, table: string, columns: string[], type: VariableMappingRecord["value_type"]): VariableMappingRecord => { const mapping = record(id, table, columns, type); mapping.sources[0] = { kind: "direct_field", schema, table, columns }; return mapping; };
  const mapping = review([
    { role: "outcome", mapping: at("readmission", "mimiciv_derived", "derived_events", ["subject_id", "hadm_id", "stay_id", "flag"], "binary") },
    { role: "exposure", mapping: at("drug", "mimiciv_hosp", "prescriptions", ["subject_id", "hadm_id", "drug"], "binary") },
    { role: "covariate", mapping: at("emergency", "mimiciv_hosp", "admissions", ["subject_id", "hadm_id", "admission_type"], "binary") },
    { role: "covariate", mapping: at("creatinine", "mimiciv_hosp", "labevents", ["subject_id", "hadm_id", "valuenum"], "continuous") },
    { role: "covariate", mapping: at("vasopressors", "mimiciv_icu", "inputevents", ["subject_id", "hadm_id", "stay_id", "amount"], "binary") },
  ]);
  const result = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "association" }, mapping, catalog: icuCatalog });
  assert.equal(result.status, "ready", JSON.stringify(result.blockers));
  assert.deepEqual(result.analysis_unit, { source_id: "mimiciv_derived.derived_events", column: "hadm_id" });
  assert.equal(result.joins.find(({ right_source_id }) => right_source_id === "mimiciv_icu.inputevents")?.left_column, "hadm_id");
});

// The tables of MIMIC questions 3.3 (ICU admission) and 4.4 (hospital admission), 2026-10-26: most tables carry the other
// identifier, so counting tables chose the wrong unit for both.
type Schema = ClinicalDatabaseCatalog["relations"][number]["schema"];
const mimicTables: Array<[Schema, string, string[]]> = [
  ["mimiciv_icu", "icustays", ["subject_id", "hadm_id", "stay_id", "intime", "outtime"]],
  ["mimiciv_icu", "chartevents", ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "valuenum"]],
  ["mimiciv_icu", "procedureevents", ["subject_id", "hadm_id", "stay_id", "itemid", "starttime", "value"]],
  ["mimiciv_derived", "derived_events", ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "valuenum"]],
  ["mimiciv_hosp", "admissions", ["subject_id", "hadm_id", "admittime", "dischtime", "hospital_expire_flag"]],
  ["mimiciv_hosp", "diagnoses_icd", ["subject_id", "hadm_id", "icd_code", "icd_version"]],
  ["mimiciv_hosp", "patients", ["subject_id", "anchor_age", "gender"]],
];
const mimicCatalog: ClinicalDatabaseCatalog = { ...catalog, relation_count: mimicTables.length, relations: mimicTables.map(([schema, name, columns]) => ({ schema, name, relation_type: "table" as const, columns: columns.map((column) => ({ name: column, data_type: "text", nullable: true })) })) };
const onTable = (id: string, table: string, columns: string[], type: VariableMappingRecord["value_type"] = "continuous"): VariableMappingRecord => {
  const [schema] = mimicTables.find(([, name]) => name === table)!; const mapping = record(id, table, columns, type);
  mapping.sources[0] = { kind: "direct_field", schema, table, columns, ...(table === "diagnoses_icd" ? { codes: [{ code: "I10", version: 10 as const }] } : {}) }; return mapping;
};
const joinOf = (manifest: ReturnType<typeof compileExecutionManifest>, table: string) => manifest.joins.find(({ right_source_id }) => right_source_id.endsWith(`.${table}`));

test("an ICU-admission study is analysed per ICU stay, rooted at the ICU stays, although most of its tables carry only the admission", () => {
  const mapping = review([
    { role: "index_time", mapping: onTable("ICU admission", "icustays", ["subject_id", "hadm_id", "stay_id", "intime", "outtime"]) },
    // A population table that sorts before the ICU stays does not become the root.
    { role: "population", mapping: onTable("sepsis", "derived_events", ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "valuenum"], "binary") },
    { role: "exposure", mapping: onTable("SOFA score", "derived_events", ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "valuenum"]) },
    { role: "outcome", mapping: onTable("in-hospital death", "admissions", ["subject_id", "hadm_id", "hospital_expire_flag"], "binary") },
    { role: "covariate", mapping: onTable("comorbidity", "diagnoses_icd", ["subject_id", "hadm_id", "icd_code", "icd_version"], "binary") },
    { role: "covariate", mapping: onTable("age", "patients", ["subject_id", "anchor_age"]) },
  ]);
  const result = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "association", index_time: { event: "ICU admission", selection_rule: "first ICU stay per patient" } }, mapping, catalog: mimicCatalog });
  assert.equal(result.status, "ready", JSON.stringify(result.blockers));
  assert.deepEqual(result.analysis_unit, { source_id: "mimiciv_icu.icustays", column: "stay_id" });
  assert.equal(result.sources[0]?.id, "mimiciv_icu.icustays");
  assert.deepEqual(result.extraction, { unit_selection: "first_per_subject" });
  assert.deepEqual([joinOf(result, "derived_events")?.left_column, joinOf(result, "admissions")?.left_column, joinOf(result, "diagnoses_icd")?.left_column, joinOf(result, "patients")?.left_column], ["stay_id", "hadm_id", "hadm_id", "subject_id"]);
});

test("a hospital-admission study is analysed per admission, with its ICU tables joined on the admission, although most of its tables carry an ICU stay", () => {
  const mapping = review([
    { role: "index_time", mapping: onTable("hospital admission", "admissions", ["subject_id", "hadm_id", "admittime", "dischtime"]) },
    { role: "exposure", mapping: onTable("heart rate", "chartevents", ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "valuenum"]) },
    { role: "covariate", mapping: onTable("temperature", "derived_events", ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "valuenum"]) },
    { role: "outcome", mapping: onTable("invasive ventilation", "procedureevents", ["subject_id", "hadm_id", "stay_id", "itemid", "starttime", "value"], "binary") },
    { role: "covariate", mapping: onTable("comorbidity", "diagnoses_icd", ["subject_id", "hadm_id", "icd_code", "icd_version"], "binary") },
    { role: "covariate", mapping: onTable("age", "patients", ["subject_id", "anchor_age"]) },
  ]);
  const result = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "prediction", index_time: { event: "hospital admission", selection_rule: "first hospital admission per patient" } }, mapping, catalog: mimicCatalog });
  assert.equal(result.status, "ready", JSON.stringify(result.blockers));
  assert.deepEqual(result.analysis_unit, { source_id: "mimiciv_hosp.admissions", column: "hadm_id" });
  for (const table of ["chartevents", "procedureevents", "derived_events", "diagnoses_icd"]) assert.deepEqual([joinOf(result, table)?.left_source_id, joinOf(result, table)?.left_column], ["mimiciv_hosp.admissions", "hadm_id"], table);
});

test("a description's characteristics are marked, a yes/no one is a record presence, and none is the outcome", () => {
  const death = record("mortality", "admissions", ["subject_id", "hadm_id", "hospital_expire_flag"], "binary");
  const age = record("age", "patients", ["subject_id", "anchor_age"], "continuous");
  const mapping = review([{ role: "outcome", mapping: death }, { role: "covariate", mapping: age }]);
  mapping.variables[0]!.condition_id = "characteristic.1"; mapping.variables[1]!.condition_id = "characteristic.2";
  const characteristic = (name: string, role: "outcome" | "covariate", id: string) => ({ name, role, operational_definition: name, definition: { condition_id: id, source_text: name, kind: "concept" as const, concept: name, assertion: "present" as const } });
  const result = compileExecutionManifest({ study: { schema_version: "1.0.0", intent_family: "association", time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }], characteristics: [characteristic("mortality", "outcome", "characteristic.1"), characteristic("age", "covariate", "characteristic.2")] }, mapping, catalog });
  assert.equal(result.status, "ready");
  const [deathVariable, ageVariable] = result.variables;
  assert.equal(deathVariable?.characteristic, true); assert.equal(ageVariable?.characteristic, true);
  // In-hospital death read from a flag: a survivor has no death record in the window, which is "no", not missing.
  assert.deepEqual(deathVariable?.contrast, { kind: "binary_presence" }); assert.equal(deathVariable?.aggregation, "any");
  assert.equal(ageVariable?.contrast, undefined);
  assert.equal(result.extraction?.outcome_timing, undefined);
});
