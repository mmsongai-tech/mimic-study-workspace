import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClinicalDatabaseCatalog } from "../../clinical-database/index.js";
import {
  FileVariableMappingPackRepository,
  SqliteVariableMappingRepository,
  VariableMappingDiscoveryService,
  VariableMappingLifecycleService,
  VariableMappingPackService,
  VariableMappingVerificationService,
  type MimicTerminologySearchGateway,
  type VariableMappingRecord,
} from "../index.js";

const createRepository = async () => {
  const directory = await mkdtemp(join(tmpdir(), "variable-mapping-test-"));
  return new SqliteVariableMappingRepository(join(directory, "mappings.sqlite"));
};

test("seeds reusable mappings from a versioned data pack instead of hard-coded service branches", async () => {
  const mappings = await createRepository();
  const service = new VariableMappingPackService({
    pack: new FileVariableMappingPackRepository(new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url)),
    mappings, now: () => "2026-09-02T00:00:00.000Z",
  });
  assert.equal(await service.seed(), 198);
  assert.ok((await mappings.findByTerm("全因死亡")).some(({ concept_id, status }) => concept_id === "all_cause_death" && status === "validated"));
  const diabetes = await mappings.findByTerm("糖尿病");
  assert.ok(diabetes.some(({ concept_id, status }) => concept_id === "diabetes_mellitus" && status === "validated"));
  assert.equal((await mappings.findByTerm("院内死亡"))[0]?.status, "validated");
  const triglycerides = await mappings.findByTerm("甘油三酯");
  assert.ok(triglycerides.some(({ concept_id, status }) => concept_id === "triglycerides" && status === "validated"));
  const race = await mappings.findByTerm("race");
  assert.ok(race.some(({ concept_id, status }) => concept_id === "race_ethnicity" && status === "validated"));
  const pain = await mappings.findByTerm("疼痛评分");
  assert.ok(pain.some(({ concept_id, status, value_type }) => concept_id === "pain_score" && status === "validated" && value_type === "continuous"));
  const opioidDose = (await mappings.findByTerm("阿片类药物镇痛剂量")).find(({ concept_id }) => concept_id === "icu_iv_opioid_morphine_equivalents");
  assert.ok(opioidDose && opioidDose.status === "validated");
  assert.ok(opioidDose.sources[0]!.amount_conversions!.every(({ factor }) => factor > 0));
  mappings.close();
});

test("preserves aggregate profile evidence when the same mapping is rediscovered", async () => {
  const mappings = await createRepository();
  const record: VariableMappingRecord = {
    schema_version: "1.0.0", mapping_id: "mapping:profiled", concept_id: "profiled", mapping_version: "1.0.0", labels: { en: "Profiled concept" }, synonyms: [], category: "laboratory", value_type: "continuous",
    definition: { summary: "Profiled concept", temporal_rule: "During encounter", value_rule: "Recorded value", missingness_rule: "Missing remains missing" },
    sources: [{ kind: "dictionary_item", schema: "mimiciv_hosp", table: "labevents", columns: ["subject_id", "hadm_id", "itemid", "valuenum"], dictionary_table: "d_labitems", item_ids: [1] }],
    status: "database_verified", provenance: "realtime_discovery", evidence: { dictionary_entries: [{ evidence_key: "d_labitems:item:1", dictionary: "d_labitems", identifier: "1", label: "Profiled concept" }], data_profile: { source_id: "mimiciv_hosp.labevents", matched_record_count: 25, missing_value_count: 0, distinct_value_count: 5, units: [], top_values: [], profiled_at: "2026-09-14T00:00:00.000Z" } }, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:01:00.000Z",
  };
  await mappings.save(record);
  await mappings.save({ ...record, evidence: { ...(record.evidence.dictionary_entries ? { dictionary_entries: record.evidence.dictionary_entries } : {}) }, updated_at: "2026-09-14T00:02:00.000Z" });
  assert.equal((await mappings.findById(record.mapping_id))?.evidence.data_profile?.matched_record_count, 25);
  mappings.close();
});

test("does not let automatic rediscovery downgrade a clinician-confirmed mapping", async () => {
  const mappings = await createRepository();
  const record: VariableMappingRecord = {
    schema_version: "1.0.0", mapping_id: "mapping:reviewed-derived", concept_id: "reviewed-derived", mapping_version: "1.0.0", labels: { en: "Reviewed derived measurement" }, synonyms: ["derived measurement"], category: "vital_sign", value_type: "continuous",
    definition: { summary: "Reviewed change", temporal_rule: "Frozen windows", value_rule: "Baseline minus follow-up", missingness_rule: "Missing remains missing" },
    sources: [{ kind: "dictionary_item", schema: "mimiciv_icu", table: "chartevents", columns: ["stay_id", "itemid", "charttime", "valuenum"], dictionary_table: "d_items", item_ids: [220050] }],
    status: "clinician_confirmed", provenance: "clinician_review", evidence: { reviewer_note: "Reviewed source and derivation." }, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:01:00.000Z",
  };
  await mappings.save(record);
  await mappings.save({ ...record, status: "database_verified", provenance: "realtime_discovery", evidence: { dictionary_entries: [{ evidence_key: "d_items:item:220050", dictionary: "d_items", identifier: "220050", label: "Arterial Blood Pressure systolic" }] }, updated_at: "2026-09-14T00:02:00.000Z" });

  const stored = await mappings.findById(record.mapping_id);
  assert.equal(stored?.status, "clinician_confirmed");
  assert.equal(stored?.provenance, "clinician_review");
  assert.equal(stored?.evidence.reviewer_note, "Reviewed source and derivation.");
  assert.equal(stored?.evidence.dictionary_entries?.[0]?.identifier, "220050");
  mappings.close();
});

test("resolves validated terms and returns ambiguous clinical definitions for review", async () => {
  const mappings = await createRepository();
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url)), mappings }).seed();
  const discovery = new VariableMappingDiscoveryService({ mappings });
  assert.equal((await discovery.search({ term: "院内死亡", role: "outcome" })).status, "resolved");
  const encounterIndex = await discovery.search({ term: "首次可观察到的高血压记录/就诊时点", role: "index_time" });
  assert.equal(encounterIndex.candidates[0]?.mapping.concept_id, "hospitalized_patient");
  const icuIndex = await discovery.search({ term: "ICU入院（ICU admission）", role: "index_time" });
  assert.equal(icuIndex.candidates[0]?.mapping.concept_id, "icu_stay");
  const noisy = structuredClone((await mappings.findByTerm("糖尿病"))[0]!);
  noisy.mapping_id = "mimic-iv.noisy-death-candidate.v1";
  noisy.synonyms = ["院内死亡"];
  await mappings.save(noisy);
  assert.equal((await discovery.search({ term: "院内死亡", role: "outcome" })).status, "resolved");
  assert.equal((await discovery.search({ term: "Synthetic adult ICU admissions", role: "population" })).candidates.some(({ mapping }) => mapping.concept_id === "diabetes_history"), false);
  const uremia = await discovery.search({ term: "尿毒症", role: "exposure" });
  assert.equal(uremia.candidates[0]?.mapping.concept_id, "end_stage_kidney_disease", "uremia is read as the coded end-stage kidney disease");
  assert.match(uremia.candidates[0]?.mapping.definition.summary ?? "", /Dialysis during the admission is a procedure/u);
  const combined = await discovery.search({ term: "ICU 糖尿病患者", role: "population" });
  assert.equal(combined.status, "resolved");
  assert.equal(combined.candidates[0]?.mapping.concept_id, "icu_stay");
  const durationOutcome = await discovery.search({ term: "ICU住院时长", role: "outcome" });
  assert.equal(durationOutcome.candidates.some(({ mapping }) => mapping.concept_id === "hospitalized_patient"), false);
  mappings.close();
});

test("discovers a previously unknown term from a live dictionary gateway and caches it", async () => {
  const mappings = await createRepository();
  let calls = 0;
  const terminology: MimicTerminologySearchGateway = { async search() { calls += 1; return [{ dictionary: "d_icd_diagnoses", identifier: "I48", label: "Atrial fibrillation", code_version: 10 }]; } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, now: () => "2026-09-02T00:00:00.000Z" });
  const first = await discovery.search({ term: "atrial fibrillation", role: "exposure", allow_live_search: true });
  assert.equal(first.status, "needs_confirmation");
  assert.equal(first.candidates[0]?.mapping.sources[0]?.codes?.[0]?.code, "I48");
  const second = await discovery.search({ term: "atrial fibrillation", role: "exposure", allow_live_search: true });
  assert.equal(second.candidates.length, 1);
  assert.equal(calls, 1);
  mappings.close();
});

test("rejects weak dictionary labels before offering a clinical mapping for confirmation", async () => {
  const mappings = await createRepository();
  let calls = 0;
  const terminology: MimicTerminologySearchGateway = { async search() { calls += 1; return [
    { dictionary: "d_items", identifier: "1", label: "Blood", category: "Routine Vital Signs", source_table: "chartevents" },
    { dictionary: "d_items", identifier: "2", label: "Pressure ulcer #2 - Dressing change", category: "Skin - Impairment", source_table: "chartevents" },
    { dictionary: "d_items", identifier: "4", label: "Blood Pressure Alarm - High", category: "Alarms", source_table: "chartevents" },
    { dictionary: "d_items", identifier: "3", label: "Non Invasive Blood Pressure systolic", category: "Routine Vital Signs", source_table: "chartevents" },
  ]; } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology });

  const first = await discovery.search({ term: "blood_pressure_absolute_change", role: "outcome", expected_value_type: "continuous", allow_live_search: true });
  const second = await discovery.search({ term: "blood_pressure_absolute_change", role: "outcome", expected_value_type: "continuous", allow_live_search: true });

  assert.deepEqual(first.candidates.map(({ mapping }) => mapping.labels.en), ["Non Invasive Blood Pressure systolic"]);
  assert.deepEqual(second.candidates.map(({ mapping }) => mapping.labels.en), ["Non Invasive Blood Pressure systolic"]);
  assert.equal(first.status, "needs_confirmation");
  assert.equal(calls, 1);
  mappings.close();
});

test("groups diagnosis matches into one executable review candidate and ranks it above an unfrozen seed", async () => {
  const mappings = await createRepository();
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("./fixtures/candidate-pack.json", import.meta.url)), mappings }).seed();
  const terminology: MimicTerminologySearchGateway = { async search() { return [
    { dictionary: "d_icd_diagnoses", identifier: "25000", label: "Diabetes mellitus", code_version: 9 },
    { dictionary: "d_icd_diagnoses", identifier: "E119", label: "Type 2 diabetes mellitus", code_version: 10 },
  ]; } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, now: () => "2026-09-02T00:00:00.000Z" });

  const result = await discovery.search({ term: "糖尿病", role: "exposure", allow_live_search: true });

  assert.equal(result.status, "needs_confirmation");
  assert.deepEqual(result.candidates[0]?.mapping.sources[0]?.codes, [
    { code: "25000", version: 9 }, { code: "E119", version: 10 },
  ]);
  assert.equal(result.candidates[0]?.mapping.labels.zh, "糖尿病候选编码集");
  mappings.close();
});

test("keeps diagnosis evidence from different expanded search terms in separate review candidates", async () => {
  const mappings = await createRepository();
  const terminology: MimicTerminologySearchGateway = { async search(term) { return term === "acute kidney injury" ? [{ dictionary: "d_icd_diagnoses", identifier: "N17", label: "Acute kidney failure", code_version: 10 }] : [{ dictionary: "d_icd_diagnoses", identifier: "Z380", label: "Single liveborn infant, born in hospital", code_version: 10 }]; } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, termExpander: { expand: async () => ({ normalized_label_en: "acute kidney injury", synonyms: ["hospital occurrence"], category: "diagnosis", ambiguities: [] }) } });
  const result = await discovery.search({ term: "院内急性肾损伤发生率", role: "outcome", allow_live_search: true });
  assert.ok(result.candidates.some(({ mapping }) => mapping.sources[0]?.codes?.length === 1 && mapping.sources[0]?.codes?.[0]?.code === "N17"));
  assert.equal(result.candidates.some(({ mapping }) => mapping.sources[0]?.codes?.some(({ code }) => code === "N17") && mapping.sources[0]?.codes?.some(({ code }) => code === "Z380")), false);
  mappings.close();
});

test("verifies only real catalog fields and enforces the mapping promotion lifecycle", async () => {
  const mappings = await createRepository();
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("./fixtures/candidate-pack.json", import.meta.url)), mappings }).seed();
  const diabetes = (await mappings.findByTerm("糖尿病"))[0]!;
  diabetes.mapping_version = "1.0.1";
  diabetes.sources[0]!.codes = [{ code: "25000", version: 9 }, { code: "E119", version: 10 }];
  const catalog = {
    schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "test", relation_count: 1, column_count: 5, inspected_at: "2026-09-02T00:00:00.000Z",
    relations: [
      { schema: "mimiciv_hosp", name: "diagnoses_icd", relation_type: "table", columns: ["subject_id", "hadm_id", "seq_num", "icd_code", "icd_version"].map((name) => ({ name, data_type: "text", nullable: false })) },
      { schema: "mimiciv_hosp", name: "d_icd_diagnoses", relation_type: "table", columns: ["icd_code", "icd_version", "long_title"].map((name) => ({ name, data_type: "text", nullable: false })) },
    ],
  } as ClinicalDatabaseCatalog;
  const verified = new VariableMappingVerificationService(catalog, () => "2026-09-02T00:01:00.000Z").verify(diabetes);
  await mappings.save(verified);
  const lifecycle = new VariableMappingLifecycleService(mappings, () => "2026-09-02T00:02:00.000Z");
  assert.equal((await lifecycle.transition(verified.mapping_id, "clinician_confirmed", { reviewer_note: "Use admission diagnosis codes." })).status, "clinician_confirmed");
  assert.equal((await new VariableMappingDiscoveryService({ mappings }).search({ term: "糖尿病", role: "exposure" })).status, "resolved");
  assert.equal((await lifecycle.transition(verified.mapping_id, "validated")).status, "validated");
  await assert.rejects(() => lifecycle.transition(verified.mapping_id, "discovered"));
  mappings.close();
});

test("keeps a confirmed executable mapping ahead of a live expanded candidate", async () => {
  const mappings = await createRepository();
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("./fixtures/candidate-pack.json", import.meta.url)), mappings }).seed();
  const confirmed = structuredClone((await mappings.findByTerm("糖尿病"))[0]!);
  confirmed.mapping_id = "confirmed-diabetes";
  confirmed.sources[0]!.codes = [{ code: "E119", version: 10 }];
  confirmed.status = "clinician_confirmed";
  confirmed.provenance = "clinician_review";
  await mappings.save(confirmed);
  const competing = structuredClone(confirmed);
  competing.mapping_id = "expanded-diabetes-field";
  competing.concept_id = "expanded_diabetes_field";
  competing.labels = { en: "Diabetes" };
  competing.synonyms = [];
  competing.status = "database_verified";
  competing.provenance = "realtime_discovery";
  competing.sources = [{ kind: "dictionary_item", schema: "mimiciv_icu", table: "chartevents", columns: ["itemid"], dictionary_table: "d_items", item_ids: [1] }];
  await mappings.save(competing);
  const discovery = new VariableMappingDiscoveryService({
    mappings,
    termExpander: { expand: async () => ({ normalized_label_en: "diabetes", synonyms: [], category: "diagnosis", ambiguities: [] }) },
  });

  const result = await discovery.search({ term: "糖尿病", role: "exposure", allow_live_search: true });

  assert.equal(result.status, "resolved");
  assert.equal(result.candidates[0]?.mapping.mapping_id, confirmed.mapping_id);
  mappings.close();
});

test("prefers validated demographic fields over executable diagnosis lookalikes", async () => {
  const mappings = await createRepository();
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url)), mappings }).seed();
  const diagnosis = structuredClone((await mappings.findByTerm("糖尿病"))[0]!);
  diagnosis.mapping_id = "wrong-sex-diagnosis"; diagnosis.synonyms = ["性别"]; diagnosis.sources[0]!.codes = [{ code: "30285", version: 9 }]; diagnosis.status = "clinician_confirmed";
  await mappings.save(diagnosis);
  const discovery = new VariableMappingDiscoveryService({ mappings, termExpander: { expand: async () => ({ normalized_label_en: "administrative sex", synonyms: ["gender"], category: "demographic", ambiguities: [] }) } });

  const result = await discovery.search({ term: "性别", role: "covariate", allow_live_search: true });

  assert.equal(result.candidates[0]?.mapping.mapping_id, "mimic-iv.sex.v1");
  mappings.close();
});

test("uses dictionary category evidence to prefer medication items", async () => {
  const mappings = await createRepository();
  const terminology: MimicTerminologySearchGateway = { async search() { return [
    { dictionary: "d_items", identifier: "225974", label: "Metoprolol", category: "Medications" },
    { dictionary: "d_icd_procedures", identifier: "001", label: "Unrelated procedure", code_version: 10 },
  ]; } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, termExpander: { expand: async () => ({ normalized_label_en: "metoprolol", synonyms: [], category: "medication", ambiguities: [] }) } });

  const result = await discovery.search({ term: "美托洛尔", role: "exposure", allow_live_search: true });

  assert.equal(result.candidates[0]?.mapping.category, "medication");
  assert.deepEqual(result.candidates[0]?.mapping.sources[0]?.item_ids, [225974]);
  mappings.close();
});

test("groups verified prescription labels into one reviewable medication exposure", async () => {
  const mappings = await createRepository();
  const terminology: MimicTerminologySearchGateway = { async search() { return [
    { dictionary: "prescriptions_drug", identifier: "Metoprolol", label: "Metoprolol", category: "Medication", source_table: "prescriptions" },
    { dictionary: "prescriptions_drug", identifier: "metoprolol tartrate", label: "metoprolol tartrate", category: "Medication", source_table: "prescriptions" },
  ]; } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, termExpander: { expand: async () => ({ normalized_label_en: "metoprolol", synonyms: [], category: "medication", ambiguities: [] }) } });
  const result = await discovery.search({ term: "美托洛尔", role: "exposure", allow_live_search: true });
  const source = result.candidates[0]?.mapping.sources[0];
  assert.equal(source?.kind, "medication_label");
  assert.deepEqual(source?.value_filters?.[0]?.values, ["Metoprolol", "metoprolol tartrate"]);
  mappings.close();
});

test("verifies the virtual prescription drug dictionary against its real source column", async () => {
  const mappings = await createRepository();
  const terminology: MimicTerminologySearchGateway = { async search() { return [
    { dictionary: "prescriptions_drug", identifier: "Example Drug", label: "Example Drug", category: "Medication", source_table: "prescriptions" },
  ]; } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, termExpander: { expand: async () => ({ normalized_label_en: "example drug", synonyms: [], category: "medication", ambiguities: [] }) } });
  const mapping = (await discovery.search({ term: "示例药物", role: "exposure", allow_live_search: true })).candidates[0]!.mapping;
  const columns = ["subject_id", "hadm_id", "starttime", "stoptime", "drug", "dose_val_rx", "dose_unit_rx", "route"];
  const catalog = { schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "test", relation_count: 1, column_count: columns.length, inspected_at: "2026-09-14T00:00:00.000Z", relations: [{ schema: "mimiciv_hosp", name: "prescriptions", relation_type: "table", columns: columns.map((name) => ({ name, data_type: "text", nullable: true })) }] } as ClinicalDatabaseCatalog;

  const verified = new VariableMappingVerificationService(catalog).verify(mapping);

  assert.equal(verified.status, "database_verified");
  mappings.close();
});

test("keeps prescription evidence when a medication is broadly classified as an intervention", async () => {
  const mappings = await createRepository();
  const terminology: MimicTerminologySearchGateway = { async search() { return [
    { dictionary: "prescriptions_drug", identifier: "Example Drug", label: "Example Drug", category: "Medication", source_table: "prescriptions" },
  ]; } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, termExpander: { expand: async () => ({ normalized_label_en: "example drug", synonyms: [], category: "intervention", ambiguities: [] }) } });

  const result = await discovery.search({ term: "示例药物", role: "exposure", allow_live_search: true });

  assert.equal(result.candidates[0]?.mapping.category, "medication");
  assert.deepEqual(result.candidates[0]?.mapping.sources[0]?.value_filters?.[0]?.values, ["Example Drug"]);
  mappings.close();
});

test("searches medication labels even when unverified code hints have no local ICD match", async () => {
  const mappings = await createRepository();
  let medicationSearches = 0;
  const terminology: MimicTerminologySearchGateway = {
    async search() { return []; },
    async searchCodePrefix() { return []; },
    async searchMedication(term) {
      medicationSearches += 1;
      return term.toLocaleLowerCase().includes("example drug") ? [
        { dictionary: "prescriptions_drug", identifier: "Example Drug", label: "Example Drug", category: "Medication", source_table: "prescriptions" },
      ] : [];
    },
  };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, termExpander: { expand: async () => ({ normalized_label_en: "Example Drug", synonyms: [], code_hints: ["C01AA01"], category: "medication", ambiguities: [] }) } });

  const result = await discovery.search({ term: "示例药物", role: "exposure", allow_live_search: true });

  assert.ok(medicationSearches > 0);
  assert.equal(result.candidates[0]?.mapping.category, "medication");
  assert.deepEqual(result.candidates[0]?.mapping.sources[0]?.value_filters?.[0]?.values, ["Example Drug"]);
  mappings.close();
});

test("keeps index-time role evidence ahead of a model-suggested medication", async () => {
  const mappings = await createRepository();
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url)), mappings }).seed();
  const medication = structuredClone((await mappings.findByTerm("乳酸"))[0]!);
  medication.mapping_id = "wrong-index-medication"; medication.category = "medication"; medication.synonyms = ["同次住院开始时的固定基线评估日"]; medication.status = "clinician_confirmed";
  await mappings.save(medication);
  const discovery = new VariableMappingDiscoveryService({ mappings, termExpander: { expand: async () => ({ normalized_label_en: "medication baseline", synonyms: [], category: "medication", ambiguities: [] }) } });
  const result = await discovery.search({ term: "同次住院开始时的固定基线评估日", role: "index_time", allow_live_search: true });
  assert.equal(result.candidates[0]?.mapping.concept_id, "hospitalized_patient");
  mappings.close();
});

test("retrieves a confirmed Chinese code set through a shared clinical phrase", async () => {
  const mappings = await createRepository();
  const confirmed = {
    schema_version: "1.0.0" as const, mapping_id: "confirmed-code-set", concept_id: "confirmed-code-set", mapping_version: "1.0.0",
    labels: { en: "Confirmed diagnosis code set", zh: "糖尿病 ICD 编码候选编码集" }, synonyms: ["糖尿病 ICD 编码"], category: "diagnosis" as const, value_type: "binary" as const,
    definition: { summary: "Confirmed diagnosis codes", temporal_rule: "At admission", value_rule: "Any confirmed code", missingness_rule: "No matching code is absence" },
    sources: [{ kind: "diagnosis_code" as const, schema: "mimiciv_hosp" as const, table: "diagnoses_icd", columns: ["hadm_id", "icd_code", "icd_version"], dictionary_table: "d_icd_diagnoses" as const, codes: [{ code: "E119", version: 10 as const }] }],
    status: "clinician_confirmed" as const, provenance: "clinician_review" as const, evidence: {}, created_at: "2026-09-09T00:00:00.000Z", updated_at: "2026-09-09T00:00:00.000Z",
  };
  await mappings.save(confirmed);

  const result = await new VariableMappingDiscoveryService({ mappings }).search({ term: "既往糖尿病史", role: "exposure" });

  assert.equal(result.status, "resolved");
  assert.equal(result.candidates[0]?.mapping.mapping_id, confirmed.mapping_id);
  mappings.close();
});

test("indexes inspected schema columns without inventing a clinical interpretation", async () => {
  const mappings = await createRepository();
  const catalog = {
    schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "test", relation_count: 1, column_count: 2, inspected_at: "2026-09-02T00:00:00.000Z",
    relations: [{ schema: "mimiciv_hosp", name: "admissions", relation_type: "table", columns: [{ name: "hospital_expire_flag", data_type: "integer", nullable: false }, { name: "hadm_id", data_type: "integer", nullable: false }] }],
  } as ClinicalDatabaseCatalog;
  const result = await new VariableMappingDiscoveryService({ mappings, catalog }).search({ term: "hospital expire flag", role: "outcome" });
  assert.equal(result.status, "needs_confirmation");
  assert.deepEqual(result.candidates[0]?.match_basis, ["schema_catalog"]);
  assert.equal(result.candidates[0]?.mapping.status, "database_verified");
  mappings.close();
});

test("blocks a dictionary-backed mapping when its dictionary relation is absent", async () => {
  const mappings = await createRepository();
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url)), mappings }).seed();
  const diabetes = (await mappings.findByTerm("糖尿病"))[0]!;
  const catalog = { schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "test", relation_count: 1, column_count: 5, inspected_at: "2026-09-02T00:00:00.000Z", relations: [{ schema: "mimiciv_hosp", name: "diagnoses_icd", relation_type: "table", columns: ["subject_id", "hadm_id", "seq_num", "icd_code", "icd_version"].map((name) => ({ name, data_type: "text", nullable: false })) }] } as ClinicalDatabaseCatalog;
  assert.throws(() => new VariableMappingVerificationService(catalog).verify(diabetes), /dictionary\.d_icd_diagnoses/u);
  mappings.close();
});

test("blocks dictionary verification until reviewed identifiers are frozen", async () => {
  const mappings = await createRepository();
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("./fixtures/candidate-pack.json", import.meta.url)), mappings }).seed();
  const diabetes = (await mappings.findByTerm("糖尿病"))[0]!;
  const catalog = { schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "test", relation_count: 2, column_count: 8, inspected_at: "2026-09-02T00:00:00.000Z", relations: [
    { schema: "mimiciv_hosp", name: "diagnoses_icd", relation_type: "table", columns: diabetes.sources[0]!.columns.map((name) => ({ name, data_type: "text", nullable: false })) },
    { schema: "mimiciv_hosp", name: "d_icd_diagnoses", relation_type: "table", columns: ["icd_code", "icd_version", "long_title"].map((name) => ({ name, data_type: "text", nullable: false })) },
  ] } as ClinicalDatabaseCatalog;
  assert.throws(() => new VariableMappingVerificationService(catalog).verify(diabetes), /reviewed_codes/u);
  mappings.close();
});

test("keeps model-hinted codes only when their labels share a word stem with the requested term", async () => {
  const { sharesWordStem } = await import("../index.js");
  assert.equal(sharesWordStem("Essential (primary) hypertension", ["Hypertensive"]), true);
  assert.equal(sharesWordStem("Hypertensive heart disease without heart failure", ["Hypertension"]), true);
  assert.equal(sharesWordStem("Accident caused by electric current", ["Hypertensive", "high blood pressure"]), false);
});

test("drops a synonym's drug-label subset when the requested ingredient's set contains it", async () => {
  const mappings = await createRepository();
  const labels = ["metoprolol", "Metoprolol Tartrate", "Metoprolol Succinate XL", "Metoprolol XL (Toprol XL)", "toprol", "Metoprol"];
  const terminology: MimicTerminologySearchGateway = {
    async search(term: string) { return (term === "Metoprolol Tartrate" ? ["Metoprolol Tartrate"] : labels).map((label) => ({ dictionary: "prescriptions_drug" as const, identifier: label, label })); },
  };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, termExpander: { expand: async () => ({ normalized_label_en: "Metoprolol", synonyms: ["Metoprolol Tartrate"], code_hints: [], category: "medication", ambiguities: [] }) }, now: () => "2026-09-24T00:00:00.000Z" });
  const assessment = await discovery.search({ term: "Metoprolol", role: "exposure", allow_live_search: true });
  const sets = assessment.candidates.map(({ mapping }) => mapping.sources[0]?.value_filters?.[0]?.values.length);
  assert.deepEqual(sets, [labels.length]);
  mappings.close();
});

test("skips a stored automatic derivation whose source mapping has a newer version", async () => {
  const mappings = await createRepository();
  const source: VariableMappingRecord = { schema_version: "1.0.0", mapping_id: "seed:sbp", concept_id: "sbp", mapping_version: "1.1.0", labels: { en: "Systolic blood pressure" }, synonyms: [], category: "vital_sign", value_type: "continuous",
    definition: { summary: "SBP", temporal_rule: "charted", value_rule: "valuenum", missingness_rule: "missing", valid_range: { min: 0, max: 400 } },
    sources: [{ kind: "dictionary_item", schema: "mimiciv_icu", table: "chartevents", columns: ["hadm_id", "itemid", "charttime", "valuenum"], dictionary_table: "d_items", item_ids: [220050] }],
    status: "validated", provenance: "versioned_seed", evidence: {}, created_at: "2026-09-24T00:00:00.000Z", updated_at: "2026-09-24T00:00:00.000Z" };
  const derived = (id: string, version: string): VariableMappingRecord => ({ ...source, mapping_id: id, concept_id: id, mapping_version: "1.0.0", labels: { en: `SBP change ${version}` }, synonyms: ["blood pressure change"], provenance: "realtime_discovery",
    definition: { ...source.definition, derivation: { schema_version: "1.0.0", operator: "difference", baseline: { purpose: "baseline", aggregation: "mean" }, follow_up: { purpose: "follow_up", aggregation: "mean" }, direction: "follow_up_minus_baseline" } },
    evidence: { derived_from: { mapping_id: "seed:sbp", mapping_version: version } } });
  await mappings.save(source); await mappings.save(derived("derived:old", "1.0.0")); await mappings.save(derived("derived:current", "1.1.0"));
  const assessment = await new VariableMappingDiscoveryService({ mappings }).search({ term: "blood pressure change", role: "outcome" });
  const ids = assessment.candidates.map(({ mapping }) => mapping.mapping_id);
  assert.ok(ids.includes("derived:current"));
  assert.ok(!ids.includes("derived:old"));
  mappings.close();
});

test("a plain variable request never resolves to a stored derived change variable", async () => {
  const mappings = await createRepository();
  const source: VariableMappingRecord = { schema_version: "1.0.0", mapping_id: "seed:sbp", concept_id: "sbp", mapping_version: "1.1.0", labels: { en: "Systolic blood pressure" }, synonyms: ["blood pressure change"], category: "vital_sign", value_type: "continuous",
    definition: { summary: "SBP", temporal_rule: "charted", value_rule: "valuenum", missingness_rule: "missing", valid_range: { min: 0, max: 400 } },
    sources: [{ kind: "dictionary_item", schema: "mimiciv_icu", table: "chartevents", columns: ["hadm_id", "itemid", "charttime", "valuenum"], dictionary_table: "d_items", item_ids: [220050] }],
    status: "validated", provenance: "versioned_seed", evidence: {}, created_at: "2026-09-24T00:00:00.000Z", updated_at: "2026-09-24T00:00:00.000Z" };
  const derived: VariableMappingRecord = { ...source, mapping_id: "derived:sbp-change", concept_id: "derived:sbp-change", mapping_version: "1.0.0", labels: { en: "SBP change" }, provenance: "realtime_discovery",
    definition: { ...source.definition, derivation: { schema_version: "1.0.0", operator: "difference", baseline: { purpose: "baseline", aggregation: "mean" }, follow_up: { purpose: "follow_up", aggregation: "mean" }, direction: "follow_up_minus_baseline" } },
    evidence: { derived_from: { mapping_id: "seed:sbp", mapping_version: "1.1.0" } } };
  await mappings.save(source); await mappings.save(derived);
  const service = new VariableMappingDiscoveryService({ mappings });
  const plain = (await service.search({ term: "blood pressure change", role: "covariate", exclude_derived: true })).candidates.map(({ mapping }) => mapping.mapping_id);
  assert.ok(!plain.includes("derived:sbp-change"));
  const asked = (await service.search({ term: "blood pressure change", role: "outcome" })).candidates.map(({ mapping }) => mapping.mapping_id);
  assert.ok(asked.includes("derived:sbp-change"));
  mappings.close();
});

test("a specific drug never resolves to the stored mapping of the class it belongs to", async () => {
  const mappings = await createRepository();
  const base: VariableMappingRecord = { schema_version: "1.0.0", mapping_id: "x", concept_id: "x", mapping_version: "1.0.0", labels: { en: "x" }, synonyms: [], category: "medication", value_type: "binary",
    definition: { summary: "x", temporal_rule: "any prescription", value_rule: "present", missingness_rule: "absent means not prescribed" },
    sources: [{ kind: "dictionary_item", schema: "mimiciv_hosp", table: "prescriptions", columns: ["hadm_id", "drug"], dictionary_table: "prescriptions_drug", item_ids: [] }],
    status: "validated", provenance: "versioned_seed", evidence: {}, created_at: "2026-10-18T00:00:00.000Z", updated_at: "2026-10-18T00:00:00.000Z" };
  const classMapping: VariableMappingRecord = { ...base, mapping_id: "class", concept_id: "drug_class_angiotensin_receptor_blockers", labels: { en: "Angiotensin II receptor blockers (ATC C09C)" }, synonyms: ["candesartan", "ARB"] };
  const drugMapping: VariableMappingRecord = { ...base, mapping_id: "drug", concept_id: "candesartan", labels: { en: "Candesartan" }, synonyms: [] };
  await mappings.save(classMapping); await mappings.save(drugMapping);
  const knowledge = { schema_version: "1.0.0" as const, knowledge_version: "t", provenance: "test", classes: [{ class_id: "angiotensin_receptor_blockers", atc: "C09C", labels: { en: "Angiotensin II receptor blockers", zh: "ARB" }, synonyms: ["ARB"], ingredients: ["candesartan", "losartan"] }] };
  const service = new VariableMappingDiscoveryService({ mappings, drugClasses: knowledge });
  const ids = (await service.search({ term: "candesartan", role: "exposure" })).candidates.map(({ mapping }) => mapping.mapping_id);
  assert.ok(!ids.includes("class"), ids.join(","));
  assert.ok(ids.includes("drug"));
  const classIds = (await service.search({ term: "ARB", role: "exposure" })).candidates.map(({ mapping }) => mapping.mapping_id);
  assert.ok(classIds.includes("class"), "asking for the class still finds the class");
  mappings.close();
});

test("resolves a drug class to the local labels of its member ingredients", async () => {
  const { FileDrugClassRepository, matchDrugClass } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  assert.equal(matchDrugClass(knowledge, "Beta Blockers")?.class_id, "beta_blockers");
  assert.equal(matchDrugClass(knowledge, "β受体阻滞剂")?.class_id, "beta_blockers");
  assert.equal(matchDrugClass(knowledge, "ACE inhibitor")?.class_id, "ace_inhibitors");
  assert.equal(matchDrugClass(knowledge, "Metoprolol"), undefined);
  const mappings = await createRepository();
  const labels: Record<string, string[]> = { lisinopril: ["Lisinopril", "lisinopril-hydrochlorothiazide"], enalapril: ["Enalapril Maleate"], captopril: [] };
  const terminology: MimicTerminologySearchGateway = { async search() { return []; }, async searchMedication(term: string) { return (labels[term] ?? []).concat(term === "lisinopril" ? ["Lorazepam"] : []).map((label) => ({ dictionary: "prescriptions_drug" as const, identifier: label, label })); } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, drugClasses: knowledge, now: () => "2026-09-24T00:00:00.000Z" });
  const assessment = await discovery.search({ term: "ACEI", role: "exposure", allow_live_search: true });
  assert.equal(assessment.status, "resolved");
  assert.deepEqual(assessment.candidates[0]?.mapping.sources[0]?.value_filters?.[0]?.values, ["Enalapril Maleate", "Lisinopril", "lisinopril-hydrochlorothiazide"]);
  assert.equal(assessment.candidates[0]?.mapping.evidence.derived_from?.mapping_id, "drug-class:ace_inhibitors");
  mappings.close();
});

test("does not turn a specific drug into its class through the model's synonyms", async () => {
  const { FileDrugClassRepository } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  const mappings = await createRepository();
  const terminology: MimicTerminologySearchGateway = { async search() { return []; }, async searchMedication(term: string) { return (term === "atenolol" || term.toLowerCase() === "atenolol" ? ["Atenolol"] : term === "metoprolol" ? ["Metoprolol"] : []).map((label) => ({ dictionary: "prescriptions_drug" as const, identifier: label, label })); } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, drugClasses: knowledge, termExpander: { expand: async () => ({ normalized_label_en: "Atenolol", synonyms: ["beta blocker"], code_hints: [], category: "medication", ambiguities: [] }) }, now: () => "2026-09-24T00:00:00.000Z" });
  const assessment = await discovery.search({ term: "Atenolol", role: "exposure", allow_live_search: true });
  assert.ok(!assessment.candidates.some(({ mapping }) => mapping.concept_id.startsWith("drug_class_")));
  mappings.close();
});

test("finds reusable mappings by whole words only, so short terms do not match inside other words", async () => {
  const mappings = await createRepository();
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url)), mappings, now: () => "2026-09-27T00:00:00.000Z" }).seed();
  const age = (await mappings.findByTerm("age"))[0]!;
  await mappings.save({ ...age, mapping_id: "test.beta-blockers.v1", concept_id: "beta_blockers", labels: { en: "Beta blockers" }, synonyms: ["beta-adrenergic blocking agent"], category: "medication" });
  // "age" must find Age, not the drug class through "blocking agent".
  assert.deepEqual((await mappings.findByTerm("age")).map(({ concept_id }) => concept_id), ["age"]);
  assert.ok((await mappings.findByTerm("blocking agent")).some(({ concept_id }) => concept_id === "beta_blockers"));
  mappings.close();
});

test("resolves common clinical terms to the matching core concept of the validated library", async () => {
  const mappings = await createRepository();
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url)), mappings }).seed();
  const discovery = new VariableMappingDiscoveryService({ mappings });
  const cases: Array<[string, "population" | "exposure" | "outcome" | "covariate", string]> = [
    ["糖尿病", "exposure", "diabetes_mellitus"], ["糖尿病酮症酸中毒", "population", "diabetic_ketoacidosis"], ["diabetic ketoacidosis", "population", "diabetic_ketoacidosis"],
    ["脓毒症", "population", "sepsis"], ["sepsis", "population", "sepsis"], ["脓毒性休克", "population", "septic_shock"], ["septic shock", "population", "septic_shock"],
    ["肝硬化", "population", "cirrhosis"], ["机械通气", "exposure", "invasive_ventilation"], ["去甲肾上腺素", "exposure", "norepinephrine"], ["norepinephrine", "exposure", "norepinephrine"],
    ["乳酸", "exposure", "lactate"], ["ICU住院时长", "outcome", "icu_length_of_stay"], ["ICU stay duration", "outcome", "icu_length_of_stay"], ["谵妄", "outcome", "delirium"],
    ["丙泊酚输注速度", "exposure", "propofol_rate"], ["吸烟", "exposure", "smoking"], ["氢化可的松", "exposure", "hydrocortisone_systemic"], ["房颤", "outcome", "atrial_fibrillation"],
    ["连续性肾脏替代治疗", "exposure", "crrt"], ["肾脏替代治疗", "exposure", "renal_replacement_therapy"], ["肺癌", "population", "lung_cancer"],
    ["急性肾损伤", "outcome", "acute_kidney_injury_kdigo"], ["acute kidney injury", "outcome", "acute_kidney_injury_kdigo"], ["eGFR", "outcome", "egfr"],
    ["Hospitalization due to heart failure", "outcome", "readmission_for_heart_failure_365d"], ["因心衰入院", "outcome", "readmission_for_heart_failure_365d"], ["30天内因心衰再入院", "outcome", "readmission_for_heart_failure_30d"],
    ["30-day readmission", "outcome", "readmission_any_30d"], ["再入院", "outcome", "readmission_any_365d"], ["既往心衰", "covariate", "history_of_heart_failure"], ["Discharged alive", "population", "discharged_alive"],
    ["SOFA评分", "covariate", "sofa_score"], ["SOFA score", "covariate", "sofa_score"], ["28天无呼吸机天数", "outcome", "ventilator_free_days_28"], ["有创机械通气时长", "outcome", "invasive_ventilation_hours"],
    ["血压变异性", "exposure", "sbp_variability"], ["blood pressure variability", "exposure", "sbp_variability"], ["血糖变异性", "exposure", "glucose_variability"], ["心率变异性", "exposure", "heart_rate_variability"],
    // The diagnosis of an outcome is the diagnosis, never the readmission or history concept that carries its name.
    ["Heart Failure", "outcome", "heart_failure"], ["Myocardial Infarction", "outcome", "myocardial_infarction"], ["stroke", "outcome", "stroke"], ["Atrial Fibrillation", "outcome", "atrial_fibrillation"],
    ["arrhythmia", "outcome", "arrhythmia"], ["Coronary Heart Disease", "outcome", "coronary_heart_disease"], ["transient ischemic attack", "outcome", "transient_ischemic_attack"], ["心衰", "outcome", "heart_failure"], ["心肌梗死", "outcome", "myocardial_infarction"],
    ["Sepsis-3", "population", "sepsis3_icu_admission"], ["Sepsis-3定义的脓毒症", "population", "sepsis3_icu_admission"], ["体温", "exposure", "temperature"],
    ["OASIS评分", "covariate", "oasis_score"], ["OASIS score", "covariate", "oasis_score"], ["SAPS II", "covariate", "sapsii_score"], ["SAPS II评分", "covariate", "sapsii_score"], ["终末期肾病", "population", "end_stage_kidney_disease"], ["ESRD", "population", "end_stage_kidney_disease"],
    ["Emergency admission", "covariate", "emergency_admission"], ["Vasopressors", "covariate", "vasopressors"], ["Invasive mechanical ventilation", "covariate", "invasive_ventilation"], ["Creatinine", "covariate", "creatinine"],
  ];
  const wrong: string[] = [];
  for (const [term, role, expected] of cases) {
    const result = await discovery.search({ term, role });
    const top = result.candidates[0]?.mapping.concept_id;
    if (top !== expected) wrong.push(`${term} → ${top ?? "none"} (expected ${expected})`);
  }
  assert.deepEqual(wrong, []);
  mappings.close();
});

test("a drug named in Chinese or by an alternative name is looked up in the catalog, never translated by the model", async () => {
  const { FileDrugClassRepository, ingredientFor, namesIngredient } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  assert.equal(ingredientFor(knowledge, "奥美沙坦"), "olmesartan", "the small model once turned this into omeprazole");
  assert.equal(ingredientFor(knowledge, "Salbutamol"), "albuterol", "the archive records salbutamol as albuterol");
  assert.equal(ingredientFor(knowledge, "沙丁胺醇"), "albuterol");
  assert.equal(ingredientFor(knowledge, "Omeprazole"), "omeprazole", "proton pump inhibitors are in the catalogue since 1.3.0");
  assert.equal(ingredientFor(knowledge, "Thiamine"), undefined);
  assert.ok(namesIngredient(knowledge, "缬沙坦") && !namesIngredient(knowledge, "ARB"));
  const everyIngredient = new Set(knowledge.classes.flatMap((drugClass) => drugClass.ingredients));
  for (const [ingredient] of Object.entries(knowledge.ingredient_names ?? {})) assert.ok(everyIngredient.has(ingredient), `${ingredient} is a catalog ingredient`);
});

test("sacubitril-valsartan is not counted as valsartan", async () => {
  const { FileDrugClassRepository, drugClassMapping, ingredientClass } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  const valsartan = ingredientClass(knowledge, "Valsartan")!;
  const match = (label: string) => ({ dictionary: "prescriptions_drug" as const, identifier: label, label });
  const mapping = drugClassMapping(knowledge, valsartan, "Valsartan", [match("Valsartan"), match("Sacubitril-Valsartan (49mg-51mg)"), match("valsartan-hydrochlorothiazide")] as never, "2026-10-19T00:00:00.000Z")!;
  const labels = mapping.sources[0]!.value_filters?.[0]?.values ?? [];
  assert.deepEqual(labels, ["Valsartan", "valsartan-hydrochlorothiazide"], "the sacubitril combination is a different drug and is left out");
});

test("a named drug with no prescription record is reported absent, never replaced by a neighbouring drug", async () => {
  const { FileDrugClassRepository } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  const mappings = await createRepository();
  const base: VariableMappingRecord = { schema_version: "1.0.0", mapping_id: "formoterol", concept_id: "drug_formoterol", mapping_version: "1.0.0", labels: { en: "Formoterol (ATC R03AC/R03CC)" }, synonyms: ["Formoterol", "indacaterol", "long-acting beta agonist"], category: "medication", value_type: "binary",
    definition: { summary: "x", temporal_rule: "any prescription", value_rule: "present", missingness_rule: "absent means not prescribed" },
    sources: [{ kind: "medication_label", schema: "mimiciv_hosp", table: "prescriptions", columns: ["hadm_id", "drug"], dictionary_table: "prescriptions_drug", item_ids: [] }],
    status: "validated", provenance: "versioned_seed", evidence: {}, created_at: "2026-10-19T00:00:00.000Z", updated_at: "2026-10-19T00:00:00.000Z" };
  await mappings.save(base);
  const terminology: MimicTerminologySearchGateway = { async search() { return []; }, async searchMedication() { return []; } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, drugClasses: knowledge, termExpander: { expand: async () => ({ normalized_label_en: "Indacaterol", synonyms: ["long-acting beta agonist", "formoterol"], code_hints: [], category: "medication" }) } as never });
  const assessment = await discovery.search({ term: "Indacaterol", role: "exposure", allow_live_search: true });
  assert.equal(assessment.status, "unmapped");
  assert.equal(assessment.candidates.length, 0);
  assert.match(assessment.reason ?? "", /no prescription record/u);
  mappings.close();
});

test("a stored mapping of another drug is not offered for a named drug even when its synonyms mention it", async () => {
  const { FileDrugClassRepository } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  const mappings = await createRepository();
  await mappings.save({ schema_version: "1.0.0", mapping_id: "formoterol", concept_id: "drug_formoterol", mapping_version: "1.0.0", labels: { en: "Formoterol (ATC R03AC/R03CC)" }, synonyms: ["Formoterol", "indacaterol"], category: "medication", value_type: "binary",
    definition: { summary: "x", temporal_rule: "any prescription", value_rule: "present", missingness_rule: "absent means not prescribed" },
    sources: [{ kind: "medication_label", schema: "mimiciv_hosp", table: "prescriptions", columns: ["hadm_id", "drug"], dictionary_table: "prescriptions_drug", item_ids: [] }],
    status: "validated", provenance: "versioned_seed", evidence: {}, created_at: "2026-10-19T00:00:00.000Z", updated_at: "2026-10-19T00:00:00.000Z" });
  const discovery = new VariableMappingDiscoveryService({ mappings, drugClasses: knowledge });
  const stored = await discovery.search({ term: "印达特罗", role: "exposure" });
  assert.ok(!stored.candidates.some(({ mapping }) => mapping.mapping_id === "formoterol"));
  mappings.close();
});

test("a pack entry whose only change is its review status is seeded again", async () => {
  const mappings = await createRepository();
  const entry = (status: "database_verified" | "validated") => ({
    schema_version: "1.0.0" as const, mapping_id: "pack.example.v1", concept_id: "example", mapping_version: "1.0.0", labels: { en: "Example" }, synonyms: [], category: "laboratory" as const, value_type: "continuous" as const,
    definition: { summary: "s", temporal_rule: "t", value_rule: "v", missingness_rule: "m" }, sources: [], status });
  const load = (status: "database_verified" | "validated") => ({ load: async () => ({ schema_version: "1.0.0" as const, pack_id: "p", pack_version: "1", license: "MIT", provenance: "test", mappings: [entry(status)] }) });
  await new VariableMappingPackService({ pack: load("database_verified"), mappings }).seed();
  assert.equal((await mappings.findById("pack.example.v1"))!.status, "database_verified");
  await new VariableMappingPackService({ pack: load("validated"), mappings }).seed();
  assert.equal((await mappings.findById("pack.example.v1"))!.status, "validated");
  mappings.close();
});

test("mappings found by a live search are dropped when the discovery rules change, packs and clinician-reviewed mappings stay", async () => {
  const mappings = await createRepository();
  const base = { schema_version: "1.0.0" as const, mapping_version: "1.0.0", labels: { en: "x" }, synonyms: [], category: "diagnosis" as const, value_type: "binary" as const, definition: { summary: "s", temporal_rule: "t", value_rule: "v", missingness_rule: "m" }, sources: [], evidence: {}, created_at: "2026-10-21T00:00:00.000Z", updated_at: "2026-10-21T00:00:00.000Z" };
  await mappings.save({ ...base, mapping_id: "found", concept_id: "found", status: "database_verified", provenance: "realtime_discovery" });
  await mappings.save({ ...base, mapping_id: "pack", concept_id: "pack", status: "validated", provenance: "versioned_seed" });
  await mappings.save({ ...base, mapping_id: "reviewed", concept_id: "reviewed", status: "clinician_confirmed", provenance: "clinician_review" });
  assert.equal(mappings.invalidateDiscoveries("v1"), 1);
  assert.equal(await mappings.findById("found"), undefined);
  assert.ok(await mappings.findById("pack")); assert.ok(await mappings.findById("reviewed"));
  assert.equal(mappings.invalidateDiscoveries("v1"), 0, "the same version drops nothing again");
  mappings.close();
});

test("a request the model shortened is still judged by the researcher's words", async () => {
  const mappings = await createRepository();
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url)), mappings }).seed();
  const shortened = { normalized_label_en: "Sepsis", synonyms: [] as string[], category: "diagnosis" as const, ambiguities: [], code_hints: [] as string[] };
  const result = await new VariableMappingDiscoveryService({ mappings, termExpander: { expand: async () => shortened } }).search({ term: "Sepsis with myocardial injury", role: "population" });
  assert.equal(result.status, "needs_confirmation");
  assert.match(result.reason ?? "", /does not carry: myocardial, injury/u);
  assert.equal((await new VariableMappingDiscoveryService({ mappings, termExpander: { expand: async () => shortened } }).search({ term: "Sepsis", role: "population" })).status, "resolved");
  mappings.close();
});

test("a single drug name that is not in the catalogue resolves to every prescription label that contains it", async () => {
  const mappings = await createRepository();
  const labels = ["Heparin", "Heparin Sodium (Porcine)", "Heparin Flush (100 units/ml)", "Enoxaparin"];
  const terminology: MimicTerminologySearchGateway = { async search() { return []; }, async searchMedication(term: string) { return labels.filter((label) => label.toLowerCase().includes(term.toLowerCase())).map((label) => ({ dictionary: "prescriptions_drug" as const, identifier: label, label })); } };
  const knowledge = { schema_version: "1.0.0" as const, knowledge_version: "t", provenance: "t", classes: [] };
  const expander = { expand: async () => ({ normalized_label_en: "Heparin", synonyms: [], category: "medication" as const, ambiguities: [], code_hints: [] }) };
  const result = await new VariableMappingDiscoveryService({ mappings, terminology, drugClasses: knowledge, termExpander: expander }).search({ term: "Heparin", role: "exposure", allow_live_search: true });
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.candidates[0]!.mapping.sources[0]!.value_filters![0]!.values, ["Heparin", "Heparin Flush (100 units/ml)", "Heparin Sodium (Porcine)"], "enoxaparin does not contain the name");
  const lab = await new VariableMappingDiscoveryService({ mappings, terminology, drugClasses: knowledge, termExpander: { expand: async () => ({ ...(await expander.expand()), normalized_label_en: "Glucose", category: "laboratory" as const }) } }).search({ term: "Glucose", role: "exposure", allow_live_search: true });
  assert.notEqual(lab.candidates[0]?.mapping.category, "medication", "a laboratory name is never read as a drug");
  mappings.close();
});

test("the study mapping does not upgrade a match that left out part of the request", async () => {
  const { StudyVariableMappingService } = await import("../index.js");
  assert.ok(StudyVariableMappingService);
  const mappings = await createRepository();
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url)), mappings }).seed();
  const result = await new VariableMappingDiscoveryService({ mappings }).search({ term: "Sepsis with myocardial injury", role: "population" });
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.candidates[0]!.requires_clinician_confirmation, true, "the candidate carries the flag the later upgrade step checks");
  mappings.close();
});

test("a derived request (a reduction of lactate) and a class wording with 'receptor' are not refused by the fidelity rule", async () => {
  const mappings = await createRepository();
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url)), mappings }).seed();
  const discovery = new VariableMappingDiscoveryService({ mappings });
  const lactate = await discovery.search({ term: "Lactate reduction", role: "covariate" });
  assert.ok(!/does not carry/u.test(lactate.reason ?? ""), lactate.reason);
  mappings.close();
});

test("a drug named with how it was given resolves to its class or ingredient, whether or not the model kept the word", async () => {
  const { FileDrugClassRepository, matchDrugClass, ingredientFor } = await import("../index.js");
  const classes = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  for (const term of ["beta-blocker use", "Beta-blocker therapy", "beta blockers", "β受体阻滞剂使用"]) assert.equal(matchDrugClass(classes, term)?.class_id, "beta_blockers", term);
  assert.equal(matchDrugClass(classes, "statin use")?.class_id, "statins");
  assert.equal(matchDrugClass(classes, "medication"), undefined);
  assert.equal(ingredientFor(classes, "losartan use"), "losartan");
});

test("the 1.3.0 classes resolve by class name or acronym, and topical forms of a steroid are not counted", async () => {
  const { FileDrugClassRepository, matchDrugClass, drugClassMapping } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  for (const [term, id] of [["PPI", "proton_pump_inhibitors"], ["direct oral anticoagulants", "direct_oral_anticoagulants"], ["DOAC use", "direct_oral_anticoagulants"], ["laxatives", "laxatives"], ["SSRI", "ssris"], ["other antiarrhythmic drugs", "antiarrhythmics"], ["corticosteroids", "systemic_corticosteroids"]] as const) assert.equal(matchDrugClass(knowledge, term)?.class_id, id, term);
  const steroids = knowledge.classes.find(({ class_id }) => class_id === "systemic_corticosteroids")!;
  const matches = ["Hydrocortisone Sod Succinate", "Hydrocortisone Cream 1%", "Dexamethasone", "Dexamethasone 0.1% Ophth Soln", "Neomycin-Polymyxin-Hydrocortisone Otic", "Prednisone"].map((label) => ({ dictionary: "prescriptions_drug" as const, identifier: label, label, kind: "dictionary_item" as never }));
  const mapped = drugClassMapping(knowledge, steroids, "steroids", matches as never, "2026-01-01T00:00:00.000Z")!;
  assert.deepEqual(mapped.sources[0]!.value_filters![0]!.values, ["Dexamethasone", "Hydrocortisone Sod Succinate", "Prednisone"]);
});

// Synthetic labels written in the style of the prescription dictionary (abbreviated forms, combinations, odd case and spacing).
const labelMatches = (labels: string[]) => labels.map((label) => ({ dictionary: "prescriptions_drug" as const, identifier: label, label }));

test("a locally applied form is left out of every class, abbreviated or in a combination, without a word list per ingredient", async () => {
  const { FileDrugClassRepository, drugClassMapping, ingredientClass, localDosageForms } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  const values = (classId: string, labels: string[]) => drugClassMapping(knowledge, knowledge.classes.find(({ class_id }) => class_id === classId)!, classId, labelMatches(labels) as never, "2026-10-27T00:00:00.000Z")?.sources[0]!.value_filters![0]!.values;
  // Diltiazem and nifedipine had no exclusion words, so their anal-fissure ointments counted as calcium-channel blockers.
  assert.deepEqual(values("calcium_channel_blockers", ["Diltiazem", "dilTIAZem 25mg/5mL VIAL", "Lidocaine 4%/diltiazem oint", "Diltiazem-Lidocaine 2%-1% Ointment", "NIFEdipine CR", "Nifedipine 2% Rectal", "nifedipine cream", "amlodipine-benazepril"]),
    ["amlodipine-benazepril", "Diltiazem", "dilTIAZem 25mg/5mL VIAL", "NIFEdipine CR"]);
  // The steroid words listed "ointment", which "Oint" is not.
  assert.deepEqual(values("systemic_corticosteroids", ["Hydrocortisone Oint 1%", "Hydrocortisone Na Succinate", "Prednisolone Acetate 1% Ophth. Susp."]), ["Hydrocortisone Na Succinate"]);
  assert.deepEqual(values("sama", ["Ipratropium Bromide Neb", "ipratropium 0.03% nasal spray"]), ["Ipratropium Bromide Neb"]);
  assert.deepEqual(ingredientClass(knowledge, "nifedipine")!.counted_local_forms, undefined);
  assert.deepEqual(drugClassMapping(knowledge, ingredientClass(knowledge, "Nifedipine")!, "Nifedipine", labelMatches(["Nifedipine 0.2% Oint", "Nifedipine ER"]) as never, "2026-10-27T00:00:00.000Z")!.sources[0]!.value_filters![0]!.values, ["Nifedipine ER"], "a named drug follows its class");
  // Whole words: a gel cap is swallowed, and a supplement is not a suppository.
  assert.deepEqual(localDosageForms(knowledge, "Omeprazole 20mg gelcap"), []);
  assert.deepEqual(localDosageForms(knowledge, "Potassium supplement"), []);
  assert.deepEqual(localDosageForms(knowledge, "Hydrocortisone (Rectal) 2.5% Cream"), ["topical", "rectal"]);
});

test("a class keeps the local forms that are its own route, and a drug outside the catalogue keeps every form", async () => {
  const { FileDrugClassRepository, drugClassMapping, uncataloguedIngredientClass } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  const values = (classId: string, labels: string[]) => drugClassMapping(knowledge, knowledge.classes.find(({ class_id }) => class_id === classId)!, classId, labelMatches(labels) as never, "2026-10-27T00:00:00.000Z")?.sources[0]!.value_filters![0]!.values;
  assert.deepEqual(values("opioids", ["Hydromorphone (Rectal)", "Butorphanol Tartrate Nasal Spray", "Fentanyl Patch", "Morphine Topical Gel", "Morphine 0.2% Oral Rinse"]),
    ["Butorphanol Tartrate Nasal Spray", "Fentanyl Patch", "Hydromorphone (Rectal)"], "nasal and rectal opioids are systemic; a gel or a mouth rinse is not");
  assert.deepEqual(values("laxatives", ["Bisacodyl Supp", "Lactulose Enema", "Senna"]), ["Bisacodyl Supp", "Lactulose Enema", "Senna"]);
  assert.deepEqual(values("ophthalmic_beta_blockers", ["Timolol Maleate 0.5% gel", "Dorzolamide-Timolol Ophth.", "Betaxolol eye drops"]), ["Betaxolol eye drops", "Dorzolamide-Timolol Ophth.", "Timolol Maleate 0.5% gel"]);
  const mupirocin = uncataloguedIngredientClass(knowledge, "mupirocin", "mupirocin");
  assert.deepEqual(drugClassMapping(knowledge, mupirocin, "mupirocin", labelMatches(["Mupirocin 2% Ointment", "Mupirocin Nasal Oint 2%"]) as never, "2026-10-27T00:00:00.000Z")!.sources[0]!.value_filters![0]!.values, ["Mupirocin 2% Ointment", "Mupirocin Nasal Oint 2%"]);
});

test("a stored drug-class mapping built from an older catalogue is found again from the current one, a clinician-reviewed one is kept", async () => {
  const { FileDrugClassRepository, drugClassMapping } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  const ccb = knowledge.classes.find(({ class_id }) => class_id === "calcium_channel_blockers")!;
  const labels = ["Diltiazem", "Nifedipine 0.2% Oint"];
  // What the 1.0.0 catalogue stored: validated, so neither a later search nor a discovery-rules change ever replaced it.
  const old = drugClassMapping({ ...knowledge, knowledge_version: "1.0.0", local_dosage_forms: {} }, ccb, "Calcium channel blockers", labelMatches(labels) as never, "2026-09-25T00:00:00.000Z")!;
  assert.equal(old.mapping_version, "1.0.0");
  const mappings = await createRepository();
  await mappings.save(old);
  const terminology: MimicTerminologySearchGateway = { async search() { return []; }, async searchMedication(term: string) { return labelMatches(labels.filter((label) => label.toLowerCase().includes(term))); } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, drugClasses: knowledge, now: () => "2026-10-27T00:00:00.000Z" });
  const stored = await discovery.search({ term: "Calcium channel blockers", role: "exposure" });
  assert.ok(!stored.candidates.some(({ mapping }) => mapping.mapping_id === old.mapping_id), "the 1.0.0 class is not offered");
  const live = await discovery.search({ term: "Calcium channel blockers", role: "exposure", allow_live_search: true });
  assert.equal(live.candidates[0]!.mapping.mapping_version, knowledge.knowledge_version);
  assert.deepEqual(live.candidates[0]!.mapping.sources[0]!.value_filters![0]!.values, ["Diltiazem"]);
  await mappings.save({ ...old, mapping_id: "reviewed-ccb", status: "clinician_confirmed", provenance: "clinician_review" });
  assert.ok((await discovery.search({ term: "Calcium channel blockers", role: "exposure" })).candidates.some(({ mapping }) => mapping.mapping_id === "reviewed-ccb"), "a reviewed definition is the reviewer's to change");
  mappings.close();
});

test("warfarin is a drug of its own, and oral anticoagulants are warfarin and the direct oral anticoagulants", async () => {
  const { FileDrugClassRepository, drugClassMapping, ingredientClass, ingredientFor, matchDrugClass } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  for (const term of ["Warfarin", "华法林", "Coumadin", "warfarin use"]) assert.equal(ingredientFor(knowledge, term), "warfarin", term);
  assert.equal(ingredientClass(knowledge, "Warfarin")!.atc, "B01AA");
  for (const term of ["oral anticoagulants", "OAC", "口服抗凝药"]) assert.equal(matchDrugClass(knowledge, term)?.class_id, "oral_anticoagulants", term);
  assert.equal(matchDrugClass(knowledge, "DOAC")?.class_id, "direct_oral_anticoagulants");
  assert.equal(matchDrugClass(knowledge, "direct anticoagulants"), undefined, "also names injectable direct thrombin inhibitors");
  const labels = labelMatches(["Warfarin", "Apixaban", "Rivaroxaban", "Heparin"]);
  const values = (classId: string) => drugClassMapping(knowledge, knowledge.classes.find(({ class_id }) => class_id === classId)!, classId, labels as never, "2026-10-28T00:00:00.000Z")!.sources[0]!.value_filters![0]!.values;
  assert.deepEqual(values("oral_anticoagulants"), ["Apixaban", "Rivaroxaban", "Warfarin"]);
  assert.deepEqual(values("direct_oral_anticoagulants"), ["Apixaban", "Rivaroxaban"]);
  assert.deepEqual(values("vitamin_k_antagonists"), ["Warfarin"]);
});

test("a warfarin question maps to warfarin even when the model calls it an oral anticoagulant", async () => {
  // 2026-10-28: warfarin was not in the catalogue and "oral anticoagulants" was a synonym of the DOAC class, so the model's English
  // reading of "Warfarin" ("oral anticoagulant") was offered the four DOACs.
  const { FileDrugClassRepository } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  const mappings = await createRepository();
  const labels = ["Warfarin", "Apixaban", "Rivaroxaban"];
  const terminology: MimicTerminologySearchGateway = { async search() { return []; }, async searchMedication(term: string) { return labelMatches(labels.filter((label) => label.toLowerCase().includes(term.toLowerCase()))); } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, drugClasses: knowledge, termExpander: { expand: async () => ({ normalized_label_en: "oral anticoagulant", synonyms: ["vitamin K antagonist"], code_hints: [], category: "medication", ambiguities: [] }) }, now: () => "2026-10-28T00:00:00.000Z" });
  for (const term of ["Warfarin", "华法林"]) {
    const mapping = (await discovery.search({ term, role: "exposure", allow_live_search: true })).candidates[0]!.mapping;
    assert.equal(mapping.concept_id, "drug_warfarin", term);
    assert.deepEqual(mapping.sources[0]!.value_filters![0]!.values, ["Warfarin"], term);
  }
  mappings.close();
});

test("a Chinese class name is read by rule, and the model's reading names a class only when its Chinese names agree", async () => {
  // 2026-10-28 planning check: 地平类药物 was read by the 7B model as "Benzodiazepines" and planned as ready.
  const { FileDrugClassRepository, drugClassMapping, matchDrugClass } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  assert.equal(matchDrugClass(knowledge, "地平类药物")?.class_id, "dihydropyridine_calcium_channel_blockers", "药物 is the drug, as 'drug' is");
  assert.equal(matchDrugClass(knowledge, "他汀类药物")?.class_id, "statins");
  const labels = ["Amlodipine", "Lorazepam", "Diazepam"];
  const terminology: MimicTerminologySearchGateway = { async search() { return []; }, async searchMedication(term: string) { return labelMatches(labels.filter((label) => label.toLowerCase().includes(term.toLowerCase()))); } };
  const reading = (normalized_label_en: string) => ({ expand: async () => ({ normalized_label_en, synonyms: [], code_hints: [], category: "medication" as const, ambiguities: [] }) });
  const conceptsFor = async (term: string, normalized: string, live: boolean, seed?: string) => {
    const mappings = await createRepository();
    if (seed) await mappings.save(drugClassMapping(knowledge, knowledge.classes.find(({ class_id }) => class_id === seed)!, seed, labelMatches(labels) as never, "2026-10-28T00:00:00.000Z")!);
    const discovery = new VariableMappingDiscoveryService({ mappings, terminology, drugClasses: knowledge, termExpander: reading(normalized), now: () => "2026-10-28T00:00:00.000Z" });
    const concepts = (await discovery.search({ term, role: "exposure", allow_live_search: live })).candidates.map(({ mapping }) => mapping.concept_id);
    mappings.close();
    return concepts;
  };
  assert.deepEqual(await conceptsFor("地平类药物", "Benzodiazepines", true), ["drug_class_dihydropyridine_calcium_channel_blockers"]);
  assert.ok(!(await conceptsFor("二氢吡啶药物", "Benzodiazepines", true)).includes("drug_class_benzodiazepines"), "a reading that shares nothing with 苯二氮䓬类 is not taken");
  assert.deepEqual(await conceptsFor("二氢吡啶药物", "dihydropyridines", true), ["drug_class_dihydropyridine_calcium_channel_blockers"], "a reading that agrees with the term is");
  assert.ok(!(await conceptsFor("二氢吡啶药物", "Benzodiazepines", false, "benzodiazepines")).includes("drug_class_benzodiazepines"), "nor a stored class found through that reading");
});

test("a term that names a drug class never reuses the stored mapping of another class whose name contains it", async () => {
  // 2026-10-28 planning check: "direct oral anticoagulants" (compared with warfarin) reused the stored oral-anticoagulant class, which
  // includes warfarin, because that class is named "oral anticoagulants".
  const { FileDrugClassRepository, drugClassMapping } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  const labels = ["Warfarin", "Apixaban", "Rivaroxaban"];
  const mappings = await createRepository();
  const oac = knowledge.classes.find(({ class_id }) => class_id === "oral_anticoagulants")!;
  await mappings.save(drugClassMapping(knowledge, oac, "口服抗凝药", labelMatches(labels) as never, "2026-10-28T00:00:00.000Z")!);
  const terminology: MimicTerminologySearchGateway = { async search() { return []; }, async searchMedication(term: string) { return labelMatches(labels.filter((label) => label.toLowerCase().includes(term.toLowerCase()))); } };
  const discovery = new VariableMappingDiscoveryService({ mappings, terminology, drugClasses: knowledge, termExpander: { expand: async () => ({ normalized_label_en: "Direct Anticoagulants", synonyms: [], code_hints: [], category: "medication", ambiguities: [] }) }, now: () => "2026-10-28T00:00:00.000Z" });
  for (const term of ["direct oral anticoagulants", "直接口服抗凝药"]) {
    assert.ok(!(await discovery.search({ term, role: "exposure" })).candidates.some(({ mapping }) => mapping.concept_id === "drug_class_oral_anticoagulants"), `${term}: the stored oral-anticoagulant class is not offered`);
    const live = (await discovery.search({ term, role: "exposure", allow_live_search: true })).candidates[0]!.mapping;
    assert.equal(live.concept_id, "drug_class_direct_oral_anticoagulants", term);
    assert.deepEqual(live.sources[0]!.value_filters![0]!.values, ["Apixaban", "Rivaroxaban"], term);
  }
  assert.ok((await discovery.search({ term: "oral anticoagulants", role: "exposure" })).candidates.some(({ mapping }) => mapping.concept_id === "drug_class_oral_anticoagulants"), "its own name still finds it");
  // 2026-10-28, second check: 抗凝药 (any anticoagulant, heparin included) reused the stored DOAC class through "anticoagulant".
  for (const term of ["anticoagulants", "抗凝药", "Anticoagulant"]) assert.ok(!(await discovery.search({ term, role: "exposure" })).candidates.some(({ mapping }) => mapping.concept_id.startsWith("drug_class_")), `${term} names no class, so no stored class answers it`);
  const doac = (await mappings.findByTerm("direct oral anticoagulants")).find(({ concept_id }) => concept_id === "drug_class_direct_oral_anticoagulants")!;
  await mappings.save({ ...doac, mapping_id: "reviewed-doac-for-anticoagulants", synonyms: [...doac.synonyms, "抗凝药"], status: "clinician_confirmed", provenance: "clinician_review" });
  assert.ok((await discovery.search({ term: "抗凝药", role: "exposure" })).candidates.some(({ mapping }) => mapping.mapping_id === "reviewed-doac-for-anticoagulants"), "unless a clinician confirmed it under exactly that name");
  mappings.close();
});

test("a drug-class name names exactly its own members: no name is shared, and narrower names have classes of their own", async () => {
  const { FileDrugClassRepository, drugClassMapping, ingredientClass, matchDrugClass } = await import("../index.js");
  const knowledge = await new FileDrugClassRepository(new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  const key = (name: string) => name.normalize("NFKC").toLocaleLowerCase().replaceAll("β", "beta").replaceAll(/[^\p{L}\p{N}]+/gu, "").replace(/s$/u, "");
  const owners = new Map<string, string[]>();
  for (const drugClass of knowledge.classes) for (const name of new Set([drugClass.labels.en, drugClass.labels.zh, ...drugClass.synonyms].map(key))) owners.set(name, [...(owners.get(name) ?? []), drugClass.class_id]);
  assert.deepEqual([...owners].filter(([, classes]) => classes.length > 1), [], "one name, one class: the first match would silently win");
  const values = (term: string, labels: string[]) => { const drugClass = matchDrugClass(knowledge, term); return drugClass && drugClassMapping(knowledge, drugClass, term, labelMatches(labels) as never, "2026-10-28T00:00:00.000Z")!.sources[0]!.value_filters![0]!.values; };
  assert.deepEqual(values("地平类", ["Amlodipine", "Diltiazem", "Nifedipine ER", "Verapamil SR"]), ["Amlodipine", "Nifedipine ER"], "dihydropyridines only");
  assert.deepEqual(values("CCB", ["Amlodipine", "Diltiazem", "Nifedipine ER", "Verapamil SR"]), ["Amlodipine", "Diltiazem", "Nifedipine ER", "Verapamil SR"]);
  assert.deepEqual(values("stool softeners", ["Docusate Sodium", "Senna", "Bisacodyl"]), ["Docusate Sodium"]);
  assert.equal(matchDrugClass(knowledge, "glaucoma eye drops"), undefined, "also prostaglandin analogues and carbonic anhydrase inhibitors");
  // A named drug takes its narrowest class, whatever the order of the file.
  for (const [term, atc] of [["Amlodipine", "C08CA"], ["Diltiazem", "C08"], ["Apixaban", "B01AF"], ["Docusate", "A06AA02"]] as const) assert.equal(ingredientClass(knowledge, term)!.atc, atc, term);
  const reversed = { ...knowledge, classes: [...knowledge.classes].reverse() };
  assert.equal(ingredientClass(reversed, "Warfarin")!.atc, "B01AA");
});

test("a drug-class file that counts an unknown local form group is refused", async () => {
  const { FileDrugClassRepository } = await import("../index.js");
  const { writeFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const file = join(await mkdtemp(join(tmpdir(), "drug-classes-test-")), "drug-classes.json");
  await writeFile(file, JSON.stringify({ schema_version: "1.0.0", knowledge_version: "t", provenance: "t", local_dosage_forms: { eye: ["ophth"] }, classes: [{ class_id: "x", atc: "S01", labels: { en: "X", zh: "X" }, synonyms: [], ingredients: ["x"], counted_local_forms: ["eyes"] }] }));
  await assert.rejects(new FileDrugClassRepository(pathToFileURL(file)).load(), /unknown local dosage forms: eyes/u);
});
