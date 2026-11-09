import assert from "node:assert/strict";
import test from "node:test";
import { VariableMappingDiscoveryService, type MimicTerminologySearchGateway, type VariableMappingRecord, type VariableMappingRepository, type VariableMappingStatus } from "../index.js";

class MemoryMappings implements VariableMappingRepository {
  private readonly records = new Map<string, VariableMappingRecord>();
  async save(record: VariableMappingRecord): Promise<boolean> { this.records.set(record.mapping_id, structuredClone(record)); return true; }
  async findById(mappingId: string): Promise<VariableMappingRecord | undefined> { return this.records.get(mappingId); }
  async findByTerm(): Promise<VariableMappingRecord[]> { return []; }
  async listByStatus(statuses: VariableMappingStatus[]): Promise<VariableMappingRecord[]> { return [...this.records.values()].filter(({ status }) => statuses.includes(status)); }
}

test("combines model-supplied code prefixes only after dictionary verification", async () => {
  const searched: string[] = [];
  const terminology: MimicTerminologySearchGateway = { async search(term) {
    searched.push(term);
    if (term === "A10") return [{ dictionary: "d_icd_diagnoses", identifier: "A100", label: "First verified diagnosis", code_version: 10 }, { dictionary: "d_icd_diagnoses", identifier: "A101", label: "Second verified diagnosis", code_version: 10 }];
    if (term === "B20") return [{ dictionary: "d_icd_diagnoses", identifier: "B200", label: "Third verified diagnosis", code_version: 10 }, { dictionary: "d_icd_diagnoses", identifier: "Z999", label: "Label-only B20 coincidence", code_version: 10 }];
    return [];
  } };
  const result = await new VariableMappingDiscoveryService({ mappings: new MemoryMappings(), terminology, now: () => "2026-09-14T00:00:00.000Z" }).search({ term: "任意诊断概念", role: "exposure", expected_value_type: "binary", dictionary_code_hints: ["A10", "B20"], allow_live_search: true });
  const mapping = result.candidates.find(({ mapping }) => mapping.evidence.semantic_code_hints)?.mapping;
  assert.deepEqual(mapping?.sources[0]?.codes, [{ code: "A100", version: 10 }, { code: "A101", version: 10 }, { code: "B200", version: 10 }]);
  assert.deepEqual(mapping?.evidence.semantic_code_hints, { requested_prefixes: ["A10", "B20"], checked_prefixes: ["A10", "B20"], matched_prefixes: ["A10", "B20"], match_mode: "dictionary_prefix" });
  assert.deepEqual(searched, ["A10", "B20"]);
});

test("reuses a validated mixed-language acronym mapping across equivalent local wording", async () => {
  const mappings = new MemoryMappings();
  await mappings.save({
    schema_version: "1.0.0", mapping_id: "encounter.v1", concept_id: "critical-care-encounter", mapping_version: "1.0.0",
    labels: { en: "Critical care encounter", zh: "ICU 入院" }, synonyms: ["ICU admission"], category: "encounter", value_type: "categorical",
    definition: { summary: "Critical care encounter", temporal_rule: "At entry", value_rule: "One encounter row", missingness_rule: "Missing encounter blocks inclusion" },
    sources: [{ kind: "direct_field", schema: "mimiciv_icu", table: "icustays", columns: ["subject_id", "hadm_id", "stay_id", "intime"] }],
    status: "validated", provenance: "team_validation", evidence: {}, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  });
  await mappings.save({
    schema_version: "1.0.0", mapping_id: "unrelated-diagnosis.v1", concept_id: "unrelated-diagnosis", mapping_version: "1.0.0",
    labels: { en: "Unrelated diagnosis", zh: "糖尿病在 ICU 入住时记录" }, synonyms: ["ICU 入住时记录的糖尿病诊断"], category: "diagnosis", value_type: "binary",
    definition: { summary: "Unrelated diagnosis", temporal_rule: "Before admission", value_rule: "Any code", missingness_rule: "No code" },
    sources: [{ kind: "diagnosis_code", schema: "mimiciv_hosp", table: "diagnoses_icd", columns: ["subject_id", "hadm_id", "icd_code", "icd_version"], dictionary_table: "d_icd_diagnoses", codes: [{ code: "A100", version: 10 }] }],
    status: "database_verified", provenance: "realtime_discovery", evidence: {}, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  });
  const result = await new VariableMappingDiscoveryService({ mappings }).search({ term: "患者 ICU 入住", role: "population" });
  assert.equal(result.status, "resolved");
  assert.equal(result.candidates[0]?.mapping.mapping_id, "encounter.v1");
  const severity = await new VariableMappingDiscoveryService({ mappings }).search({ term: "入 ICU 时疾病严重程度", role: "covariate" });
  assert.equal(severity.candidates.some(({ mapping }) => mapping.mapping_id === "unrelated-diagnosis.v1"), false);
  assert.equal(severity.candidates.some(({ mapping }) => mapping.mapping_id === "encounter.v1"), false);
});

test("reuses an exact specific local term embedded in a frozen longer description", async () => {
  const mappings = new MemoryMappings();
  await mappings.save({
    schema_version: "1.0.0", mapping_id: "medication.v1", concept_id: "generic-medication", mapping_version: "1.0.0",
    labels: { en: "Generic medication" }, synonyms: ["特定药物治疗及其完整时间窗描述"], category: "medication", value_type: "binary",
    definition: { summary: "Medication exposure", temporal_rule: "In the exposure window", aggregation: "any", value_rule: "Any frozen medication label", missingness_rule: "No record means no recorded exposure" },
    sources: [{ kind: "medication_label", schema: "mimiciv_hosp", table: "prescriptions", columns: ["subject_id", "hadm_id", "drug"], dictionary_table: "prescriptions_drug", value_filters: [{ column: "drug", values: ["Generic medication"] }] }],
    status: "model_reviewed", provenance: "automated_model_review", evidence: {}, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  });
  const result = await new VariableMappingDiscoveryService({ mappings }).search({ term: "特定药物治疗", role: "exposure", expected_value_type: "binary" });
  assert.equal(result.status, "resolved");
  assert.equal(result.candidates[0]?.mapping.mapping_id, "medication.v1");
});

test("reuses a role-compatible reviewed Chinese phrase but not an incompatible reviewed category", async () => {
  const mapping = (mapping_id: string, category: "medication" | "vital_sign", synonyms: string[]) => ({
    schema_version: "1.0.0" as const, mapping_id, concept_id: mapping_id, mapping_version: "1", labels: { en: mapping_id }, synonyms, category,
    value_type: "binary" as const, definition: { summary: mapping_id, temporal_rule: "At index", value_rule: "Recorded", missingness_rule: "Explicit" },
    sources: [{ kind: "dictionary_item" as const, schema: "mimiciv_icu" as const, table: "inputevents", columns: ["stay_id", "itemid"], dictionary_table: "d_items" as const, item_ids: [1] }],
    status: "model_reviewed" as const, provenance: "automated_model_review" as const, evidence: {}, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  });
  const records = [mapping("reviewed-medication", "medication", ["通用药物处方及给药记录"]), mapping("reviewed-vital", "vital_sign", ["通用疾病诊断记录"] )];
  const repository = { findByTerm: async () => [], listByStatus: async () => records, save: async () => true };
  const medication = await new VariableMappingDiscoveryService({ mappings: repository as never }).search({ term: "通用药物治疗", role: "exposure" });
  const population = await new VariableMappingDiscoveryService({ mappings: repository as never }).search({ term: "通用疾病诊断", role: "population" });
  assert.equal(medication.candidates[0]?.mapping.mapping_id, "reviewed-medication");
  assert.equal(medication.status, "resolved");
  assert.equal(population.status, "needs_confirmation");
});

test("reuses only an exact complete frozen code-prefix expansion without another model call", async () => {
  const frozen = {
    schema_version: "1.0.0" as const, mapping_id: "frozen:codes", concept_id: "codes", mapping_version: "1", labels: { en: "Frozen code set" }, synonyms: ["目标诊断. 完整定义"], category: "diagnosis" as const, value_type: "binary" as const,
    definition: { summary: "Frozen", temporal_rule: "During encounter", value_rule: "Any code", missingness_rule: "No code" },
    sources: [{ kind: "diagnosis_code" as const, schema: "mimiciv_hosp" as const, table: "diagnoses_icd", columns: ["hadm_id", "icd_code", "icd_version"], dictionary_table: "d_icd_diagnoses" as const, codes: [{ code: "A100", version: 10 as const }, { code: "B200", version: 10 as const }] }],
    status: "database_verified" as const, provenance: "realtime_discovery" as const,
    evidence: { semantic_code_hints: { requested_prefixes: ["A10", "B20"], checked_prefixes: ["A10", "B20"], matched_prefixes: ["A10", "B20"], match_mode: "dictionary_prefix" as const } },
    created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  };
  const repository = { findByTerm: async () => [frozen], listByStatus: async () => [frozen], save: async () => true };
  const exact = await new VariableMappingDiscoveryService({ mappings: repository as never }).search({ term: "目标诊断. 完整定义", role: "population" });
  const changed = await new VariableMappingDiscoveryService({ mappings: repository as never }).search({ term: "目标诊断. 不同定义", role: "population" });
  assert.equal(exact.status, "resolved");
  assert.equal(changed.status, "needs_confirmation");
});

test("refreshes an incomplete frozen prefix set and prefers broader verified coverage", async () => {
  const mappings = new MemoryMappings();
  await mappings.save({
    schema_version: "1.0.0", mapping_id: "diagnosis.partial.v1", concept_id: "partial", mapping_version: "1.0.0",
    labels: { en: "Partial diagnosis", zh: "目标诊断" }, synonyms: [], category: "diagnosis", value_type: "binary",
    definition: { summary: "Partial code set", temporal_rule: "During encounter", value_rule: "Any code", missingness_rule: "No code means no recorded diagnosis" },
    sources: [{ kind: "dictionary_item", schema: "mimiciv_icu", table: "chartevents", columns: ["subject_id", "hadm_id", "itemid", "valuenum"], dictionary_table: "d_items", item_ids: [1] }],
    status: "database_verified", provenance: "realtime_discovery", evidence: { semantic_code_hints: { requested_prefixes: ["A10", "B20"], matched_prefixes: ["A10"], match_mode: "dictionary_prefix" } }, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  });
  await mappings.save({
    schema_version: "1.0.0", mapping_id: "diagnosis.legacy-no-hints.v1", concept_id: "legacy", mapping_version: "1.0.0",
    labels: { en: "Legacy diagnosis", zh: "目标诊断" }, synonyms: [], category: "diagnosis", value_type: "binary",
    definition: { summary: "Legacy code set", temporal_rule: "During encounter", value_rule: "Any code", missingness_rule: "No code means no recorded diagnosis" },
    sources: [{ kind: "diagnosis_code", schema: "mimiciv_hosp", table: "diagnoses_icd", columns: ["subject_id", "hadm_id", "icd_code", "icd_version"], dictionary_table: "d_icd_diagnoses", codes: [{ code: "A100", version: 10 }] }],
    status: "database_verified", provenance: "realtime_discovery", evidence: {}, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  });
  const terminology: MimicTerminologySearchGateway = { async search(term) {
    if (term === "A10") return [{ dictionary: "d_icd_diagnoses", identifier: "A100", label: "First family", code_version: 10 }];
    if (term === "B20") return [{ dictionary: "d_icd_diagnoses", identifier: "B200", label: "Second family", code_version: 10 }];
    return [];
  } };
  const result = await new VariableMappingDiscoveryService({ mappings, terminology, now: () => "2026-09-14T00:00:00.000Z" }).search({ term: "目标诊断", role: "population", expected_value_type: "binary", dictionary_code_hints: ["A10", "B20"], allow_live_search: true });
  assert.deepEqual(result.candidates[0]?.mapping.evidence.semantic_code_hints?.matched_prefixes, ["A10", "B20"]);
  assert.deepEqual(result.candidates[0]?.mapping.sources[0]?.codes, [{ code: "A100", version: 10 }, { code: "B200", version: 10 }]);
});

test("reuses a checked partial code set without repeatedly searching locally absent prefixes", async () => {
  const mappings = new MemoryMappings();
  await mappings.save({
    schema_version: "1.0.0", mapping_id: "diagnosis.checked-partial.v1", concept_id: "checked-partial", mapping_version: "1.0.0",
    labels: { en: "Checked diagnosis", zh: "已检查诊断" }, synonyms: [], category: "diagnosis", value_type: "binary",
    definition: { summary: "Checked code set", temporal_rule: "During encounter", value_rule: "Any code", missingness_rule: "No code means no recorded diagnosis" },
    sources: [{ kind: "diagnosis_code", schema: "mimiciv_hosp", table: "diagnoses_icd", columns: ["subject_id", "hadm_id", "icd_code", "icd_version"], dictionary_table: "d_icd_diagnoses", codes: [{ code: "A100", version: 10 }] }],
    status: "database_verified", provenance: "realtime_discovery", evidence: { semantic_code_hints: { requested_prefixes: ["A10", "B20"], checked_prefixes: ["A10", "B20"], matched_prefixes: ["A10"], match_mode: "dictionary_prefix" } }, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  });
  let searches = 0;
  const terminology: MimicTerminologySearchGateway = { async search() { searches += 1; return []; } };
  const result = await new VariableMappingDiscoveryService({ mappings, terminology }).search({ term: "已检查诊断", role: "population", expected_value_type: "binary", dictionary_code_hints: ["A10", "B20"], allow_live_search: true });
  assert.equal(searches, 0);
  assert.equal(result.candidates[0]?.mapping.mapping_id, "diagnosis.checked-partial.v1");
});
