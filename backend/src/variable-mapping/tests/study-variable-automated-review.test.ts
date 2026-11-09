import assert from "node:assert/strict";
import test from "node:test";
import type { ClinicalDatabaseCatalog } from "../../clinical-database/index.js";
import { StudyVariableMappingService, VariableMappingVerificationService, mappingCandidateEvidenceDigest, type MappingCandidateEvidenceReview, type VariableMappingRecord } from "../index.js";

test("freezes a catalog-verified, model-reviewed dictionary subset for execution", async () => {
  const mapping: VariableMappingRecord = {
    schema_version: "1.0.0", mapping_id: "mapping:dynamic", concept_id: "dynamic", mapping_version: "1.0.0", labels: { en: "Dynamic candidate" }, synonyms: ["target"], category: "diagnosis", value_type: "binary",
    definition: { summary: "Dynamic candidate", temporal_rule: "During encounter", value_rule: "Any selected code", missingness_rule: "No selected code is no recorded event" },
    sources: [{ kind: "diagnosis_code", schema: "mimiciv_hosp", table: "diagnoses_icd", columns: ["subject_id", "hadm_id", "icd_code", "icd_version"], dictionary_table: "d_icd_diagnoses", codes: [{ code: "A1", version: 10 }, { code: "B2", version: 10 }] }],
    status: "discovered", provenance: "realtime_discovery", evidence: { dictionary_entries: [
      { evidence_key: "d_icd_diagnoses:10:A1", dictionary: "d_icd_diagnoses", identifier: "A1", code_version: 10, label: "Target concept" },
      { evidence_key: "d_icd_diagnoses:10:B2", dictionary: "d_icd_diagnoses", identifier: "B2", code_version: 10, label: "Different concept" },
    ] }, created_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z",
  };
  const catalog = { schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "test", relation_count: 2, column_count: 7, inspected_at: "2026-09-10T00:00:00.000Z", relations: [
    { schema: "mimiciv_hosp", name: "diagnoses_icd", relation_type: "table", columns: ["subject_id", "hadm_id", "icd_code", "icd_version"].map((name) => ({ name, data_type: "text", nullable: false })) },
    { schema: "mimiciv_hosp", name: "d_icd_diagnoses", relation_type: "table", columns: ["icd_code", "icd_version", "long_title"].map((name) => ({ name, data_type: "text", nullable: false })) },
  ] } as ClinicalDatabaseCatalog;
  const stored: VariableMappingRecord[] = [];
  const repository = { save: async (record: VariableMappingRecord) => { stored.push(structuredClone(record)); return true; }, findById: async () => undefined, findByTerm: async () => [], listByStatus: async () => [] };
  const service = new StudyVariableMappingService({
    discovery: { search: async () => ({ schema_version: "1.0.0", requested_term: "target", status: "needs_confirmation", candidates: [{ candidate_id: "candidate:dynamic", requested_term: "target", normalized_term: "target", role: "exposure", mapping: structuredClone(mapping), match_basis: ["database_dictionary"], confidence: "low", requires_clinician_confirmation: true, explanation: "Dynamic dictionary candidate" }] }) } as never,
    mappings: repository, lifecycle: {} as never,
    verification: new VariableMappingVerificationService(catalog, () => "2026-09-10T00:01:00.000Z"),
    candidateReviewer: { review: async (input) => ({ schema_version: "1.0.0", requested_term: input.requested_term, decision: "approved", selected_candidate_id: "candidate:dynamic", selected_evidence_keys: ["d_icd_diagnoses:10:A1"], ranked_candidate_ids: ["candidate:dynamic"], reason_codes: ["DIRECT_LABEL_MATCH"], explanation: "Only one supplied label supports the target.", review_id: "mapping-review:test", reviewer_kind: "openai_compatible_model", provider: "openai_compatible", model: "test-model", prompt: { id: "mapping-evidence-review", version: "1.0.0" }, reviewed_at: "2026-09-10T00:02:00.000Z", authorization_basis: "runtime_configured_automated_review", clinical_confirmation: false, evidence_sha256: mappingCandidateEvidenceDigest(input) } satisfies MappingCandidateEvidenceReview) },
  });

  const review = await service.assess({ schema_version: "1.0.0", intent_family: "association", exposure_or_predictors: [{ name: "target", role: "exposure", operational_definition: "Recorded during encounter" }] }, true);

  assert.equal(review.status, "ready");
  assert.equal(review.variables[0]?.candidate_review?.decision, "approved");
  assert.equal(review.variables[0]?.candidates[0]?.mapping.status, "model_reviewed");
  assert.equal(review.variables[0]?.candidates[0]?.requires_clinician_confirmation, false);
  assert.deepEqual(review.variables[0]?.candidates[0]?.mapping.sources[0]?.codes, [{ code: "A1", version: 10 }]);
  assert.equal(stored.some(({ status }) => status === "model_reviewed"), true);
});

test("shares one successful evidence review across concurrent objectives with identical evidence", async () => {
  const mapping: VariableMappingRecord = {
    schema_version: "1.0.0", mapping_id: "mapping:shared", concept_id: "shared", mapping_version: "1.0.0", labels: { en: "Shared candidate" }, synonyms: ["target"], category: "diagnosis", value_type: "binary",
    definition: { summary: "Shared candidate", temporal_rule: "During encounter", value_rule: "Any selected code", missingness_rule: "No selected code is no recorded event" },
    sources: [{ kind: "diagnosis_code", schema: "mimiciv_hosp", table: "diagnoses_icd", columns: ["subject_id", "hadm_id", "icd_code", "icd_version"], dictionary_table: "d_icd_diagnoses", codes: [{ code: "A1", version: 10 }] }],
    status: "database_verified", provenance: "realtime_discovery", evidence: { dictionary_entries: [{ evidence_key: "d_icd_diagnoses:10:A1", dictionary: "d_icd_diagnoses", identifier: "A1", code_version: 10, label: "Target concept" }] }, created_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z",
  };
  let reviewCalls = 0;
  const repository = { save: async () => true, findById: async () => undefined, findByTerm: async () => [], listByStatus: async () => [] };
  const service = new StudyVariableMappingService({
    discovery: { search: async () => ({ schema_version: "1.0.0", requested_term: "target", status: "needs_confirmation", candidates: [{ candidate_id: "candidate:shared", requested_term: "target", normalized_term: "target", role: "exposure", mapping: structuredClone(mapping), match_basis: ["database_dictionary"], confidence: "low", requires_clinician_confirmation: true, explanation: "Shared evidence" }] }) } as never,
    mappings: repository, lifecycle: {} as never,
    candidateReviewer: { review: async (input) => { reviewCalls += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return { schema_version: "1.0.0", requested_term: input.requested_term, decision: "approved", selected_candidate_id: "candidate:shared", selected_evidence_keys: ["d_icd_diagnoses:10:A1"], ranked_candidate_ids: ["candidate:shared"], reason_codes: ["DIRECT_LABEL_MATCH"], explanation: "Direct match.", review_id: "mapping-review:shared", reviewer_kind: "openai_compatible_model", provider: "openai_compatible", model: "test-model", prompt: { id: "mapping-evidence-review", version: "1.1.1" }, reviewed_at: "2026-09-10T00:00:00.000Z", authorization_basis: "runtime_configured_automated_review", clinical_confirmation: false, evidence_sha256: mappingCandidateEvidenceDigest(input) }; } },
  });
  const spec = (question: string) => ({ schema_version: "1.0.0" as const, intent_family: "association" as const, research_question: question, exposure_or_predictors: [{ name: "target", role: "exposure" as const, operational_definition: "Recorded" }] });

  const reviews = await Promise.all([service.assess(spec("first"), true), service.assess(spec("second"), true)]);

  assert.equal(reviewCalls, 1);
  assert.equal(reviews.every(({ status }) => status === "ready"), true);
});
