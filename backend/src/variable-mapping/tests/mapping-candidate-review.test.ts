import assert from "node:assert/strict";
import test from "node:test";
import { applyMappingCandidateReview, isCandidateExecutable, mappingCandidateEvidenceDigest, mappingCandidateEvidenceSummary, variableDictionaryEvidenceKey, type MappingCandidateEvidenceReview, type VariableMappingAssessment, type VariableMappingCandidate } from "../index.js";

const candidate = (count = 3): VariableMappingCandidate => ({
  candidate_id: "candidate:generic",
  requested_term: "requested concept",
  normalized_term: "requested concept",
  role: "exposure",
  mapping: { schema_version: "1.0.0", mapping_id: "mapping:generic", concept_id: "generic", mapping_version: "1", labels: { en: "Generic" }, synonyms: [], category: "diagnosis", value_type: "binary", definition: { summary: "Generic", temporal_rule: "At index", value_rule: "Recorded", missingness_rule: "Exclude" }, sources: [{ kind: "diagnosis_code", schema: "mimiciv_hosp", table: "diagnoses_icd", columns: ["hadm_id", "icd_code", "icd_version"], dictionary_table: "d_icd_diagnoses", codes: Array.from({ length: count }, (_, index) => ({ code: `C${index}`, version: 10 as const })) }], status: "database_verified", provenance: "realtime_discovery", evidence: { dictionary_entries: Array.from({ length: count }, (_, index) => { const entry = { dictionary: "d_icd_diagnoses" as const, identifier: `C${index}`, label: `Dictionary label ${index}`, code_version: 10 as const }; return { evidence_key: variableDictionaryEvidenceKey(entry), ...entry }; }) }, created_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z" },
  match_basis: ["database_dictionary"], confidence: "low", requires_clinician_confirmation: true, explanation: "Evidence-backed candidate",
});
const assessment = (value: VariableMappingCandidate): VariableMappingAssessment => ({ schema_version: "1.0.0", requested_term: value.requested_term, status: "needs_confirmation", candidates: [value] });
const reviewed = (input: VariableMappingAssessment, value: Partial<MappingCandidateEvidenceReview> = {}): MappingCandidateEvidenceReview => {
  const reviewInput = { requested_term: input.requested_term, role: input.candidates[0]!.role, candidates: mappingCandidateEvidenceSummary(input) };
  return { schema_version: "1.0.0", requested_term: input.requested_term, decision: "approved", selected_candidate_id: input.candidates[0]!.candidate_id, selected_evidence_keys: [input.candidates[0]!.mapping.evidence.dictionary_entries![0]!.evidence_key], ranked_candidate_ids: [input.candidates[0]!.candidate_id], reason_codes: ["DIRECT_LABEL_MATCH"], explanation: "Supported by supplied label.", review_id: "mapping-review:test", reviewer_kind: "openai_compatible_model", provider: "openai_compatible", model: "test-model", prompt: { id: "mapping-evidence-review", version: "1.0.0" }, reviewed_at: "2026-09-10T00:01:00.000Z", authorization_basis: "runtime_configured_automated_review", clinical_confirmation: false, evidence_sha256: mappingCandidateEvidenceDigest(reviewInput), ...value };
};

test("automated review freezes only selected verified evidence without claiming clinician confirmation", () => {
  const value = candidate(); const input = assessment(value);
  assert.equal(isCandidateExecutable(value, true), false);
  const result = applyMappingCandidateReview(input, reviewed(input));
  assert.equal(result.status, "approved");
  assert.equal(result.selected_candidate?.mapping.status, "model_reviewed");
  assert.equal(result.selected_candidate?.mapping.provenance, "automated_model_review");
  assert.equal(result.selected_candidate?.mapping.evidence.automated_review?.clinical_confirmation, false);
  assert.deepEqual(result.selected_candidate?.mapping.sources[0]?.codes, [{ code: "C0", version: 10 }]);
  assert.equal(isCandidateExecutable(result.selected_candidate!), true);
});

test("review can approve, reject, or block without inventing candidates", () => {
  const value = candidate(); const input = assessment(value);
  assert.equal(applyMappingCandidateReview(input, reviewed(input, { decision: "rejected", selected_candidate_id: null, selected_evidence_keys: [], reason_codes: ["SEMANTIC_MISMATCH"] })).status, "rejected");
  assert.equal(applyMappingCandidateReview(input, reviewed(input, { selected_candidate_id: "invented", ranked_candidate_ids: ["invented"] })).status, "blocked");
  assert.equal(applyMappingCandidateReview(input, reviewed(input, { selected_evidence_keys: ["d_icd_diagnoses:10:invented"] })).status, "blocked");
});

test("blocks a broad dictionary set unless the model materially refines it", () => {
  const value = candidate(226); const input = assessment(value);
  const allKeys = value.mapping.evidence.dictionary_entries!.map(({ evidence_key }) => evidence_key);
  const result = applyMappingCandidateReview(input, reviewed(input, { selected_evidence_keys: allKeys }));
  assert.equal(result.status, "blocked");
  assert.ok(result.review.reason_codes.includes("DICTIONARY_SELECTION_TOO_BROAD"));
});

test("automated review can freeze one inspected catalog field without treating lexical match as confirmation", () => {
  const value = candidate();
  value.role = "outcome";
  value.mapping = { ...value.mapping, mapping_id: "mapping:icu-los", category: "encounter", value_type: "duration", sources: [{ kind: "direct_field", schema: "mimiciv_icu", table: "icustays", columns: ["los"] }], evidence: { catalog_integrity_id: "catalog:test" } };
  const input = assessment(value); const reviewInput = { requested_term: input.requested_term, role: value.role, candidates: mappingCandidateEvidenceSummary(input) };
  const result = applyMappingCandidateReview(input, { ...reviewed(assessment(candidate())), requested_term: input.requested_term, selected_candidate_id: value.candidate_id, selected_evidence_keys: ["field:mimiciv_icu.icustays.los"], ranked_candidate_ids: [value.candidate_id], evidence_sha256: mappingCandidateEvidenceDigest(reviewInput) });
  assert.equal(result.status, "approved");
  assert.deepEqual(result.selected_candidate?.mapping.sources[0]?.columns, ["los"]);
  assert.equal(result.selected_candidate?.mapping.status, "model_reviewed");
});

test("automated review never drops a drug label that contains the requested drug name", () => {
  const labels = ["Metoprolol Tartrate", "Metoprolol Succinate XL", "metoprolol", "Toprol XL", "Atenolol"];
  const entries = labels.map((label) => { const entry = { dictionary: "prescriptions_drug" as const, identifier: label, label }; return { evidence_key: variableDictionaryEvidenceKey(entry), ...entry }; });
  const value: VariableMappingCandidate = { ...candidate(), requested_term: "Metoprolol", normalized_term: "metoprolol", mapping: { ...candidate().mapping, category: "medication", sources: [{ kind: "medication_label", schema: "mimiciv_hosp", table: "prescriptions", columns: ["hadm_id", "drug"], dictionary_table: "prescriptions_drug", value_filters: [{ column: "drug", values: labels }] }], evidence: { dictionary_entries: entries } } };
  const input: VariableMappingAssessment = { ...assessment(value), requested_term: "Metoprolol" };
  // The model kept only one metoprolol label and the brand name, and dropped the unrelated drug.
  const result = applyMappingCandidateReview(input, reviewed(input, { selected_evidence_keys: [entries[0]!.evidence_key, entries[3]!.evidence_key] }));
  assert.equal(result.status, "approved");
  assert.deepEqual(result.selected_candidate?.mapping.sources[0]?.value_filters?.[0]?.values.sort(), ["Metoprolol Succinate XL", "Metoprolol Tartrate", "Toprol XL", "metoprolol"]);
});
