import assert from "node:assert/strict";
import test from "node:test";
import { createDerivedVariableCandidates, parseDerivedVariableRequest, type VariableMappingCandidate } from "../index.js";

const sourceCandidate: VariableMappingCandidate = {
  candidate_id: "candidate:source", requested_term: "generic measurement", normalized_term: "generic measurement", role: "outcome",
  mapping: { schema_version: "1.0.0", mapping_id: "source", concept_id: "source", mapping_version: "1", labels: { en: "Generic measurement" }, synonyms: [], category: "vital_sign", value_type: "continuous", definition: { summary: "Generic measurement", temporal_rule: "Recorded time", value_rule: "Recorded value", missingness_rule: "Missing remains missing" }, sources: [{ kind: "dictionary_item", schema: "mimiciv_icu", table: "chartevents", columns: ["hadm_id", "itemid", "charttime", "valuenum"], dictionary_table: "d_items", item_ids: [42] }], status: "database_verified", provenance: "realtime_discovery", evidence: { dictionary_entries: [{ evidence_key: "d_items:item:42", dictionary: "d_items", identifier: "42", label: "Generic measurement" }] }, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z" },
  match_basis: ["database_dictionary"], confidence: "medium", requires_clinician_confirmation: true, explanation: "Review",
};

test("builds a fixed difference derivation from generic model semantics", () => {
  const request = parseDerivedVariableRequest({ concept: "generic_measurement_absolute_change", context: "降低程度，以每个时段的首次记录值计算" });
  assert.equal(request?.source_term, "generic measurement");
  assert.equal(request?.aggregation, "first");
  assert.deepEqual(request?.directions, ["baseline_minus_follow_up"]);
  const candidates = createDerivedVariableCandidates(sourceCandidate, request!);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.mapping.definition.derivation?.operator, "difference");
  assert.equal(candidates[0]?.mapping.definition.derivation?.direction, "baseline_minus_follow_up");
  assert.equal(candidates[0]?.requires_clinician_confirmation, true);
});

test("keeps direction ambiguous when the model supplies only a generic change", () => {
  const request = parseDerivedVariableRequest({ concept: "generic_measurement_change", context: "first value in each period" });
  assert.equal(createDerivedVariableCandidates(sourceCandidate, request!).length, 2);
});

test("does not derive a review option from an unverified seed", () => {
  const request = parseDerivedVariableRequest({ concept: "generic_measurement_change", context: "first reduction" })!;
  const unverified = structuredClone(sourceCandidate);
  unverified.mapping.status = "discovered";
  unverified.mapping.evidence = {};
  assert.deepEqual(createDerivedVariableCandidates(unverified, request), []);
});

test("a change derived from a validated measurement inherits its status; other sources still need confirmation", async () => {
  const { createDerivedVariableCandidates } = await import("../index.js");
  const source = (status: "validated" | "database_verified") => ({
    candidate_id: `candidate:sbp-${status}`, requested_term: "Blood pressure change", normalized_term: "blood pressure change", role: "outcome" as const,
    mapping: { schema_version: "1.0.0" as const, mapping_id: `sbp-${status}`, concept_id: "sbp", mapping_version: "1.0.0", labels: { en: "Systolic blood pressure" }, synonyms: [], category: "vital_sign" as const, value_type: "continuous" as const,
      definition: { summary: "SBP", temporal_rule: "charted", aggregation: "mean" as const, value_rule: "valuenum", missingness_rule: "missing" },
      sources: [{ kind: "dictionary_item" as const, schema: "mimiciv_icu" as const, table: "chartevents", columns: ["hadm_id", "itemid", "charttime", "valuenum"], dictionary_table: "d_items" as const, item_ids: [220050] }],
      status, provenance: "versioned_seed" as const, evidence: {}, created_at: "2026-09-24T00:00:00.000Z", updated_at: "2026-09-24T00:00:00.000Z" },
    match_basis: ["validated_mapping" as const], confidence: "high" as const, requires_clinician_confirmation: false, explanation: "seed",
  });
  const request = { schema_version: "1.0.0" as const, requested_term: "Blood pressure change", source_term: "Blood pressure", operator: "difference" as const, aggregation: "first" as const, directions: ["follow_up_minus_baseline" as const] };
  const [trusted] = createDerivedVariableCandidates(source("validated"), request);
  assert.equal(trusted?.mapping.status, "validated");
  assert.equal(trusted?.requires_clinician_confirmation, false);
  const [unreviewed] = createDerivedVariableCandidates({ ...source("database_verified"), mapping: { ...source("database_verified").mapping, evidence: { dictionary_entries: [{ evidence_key: "d_items:item:220050", dictionary: "d_items", identifier: "220050", label: "Arterial Blood Pressure systolic" }] } } }, request);
  assert.equal(unreviewed?.requires_clinician_confirmation, true);
});
