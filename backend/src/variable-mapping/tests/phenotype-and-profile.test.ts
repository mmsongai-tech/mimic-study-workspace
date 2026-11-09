import test from "node:test";
import assert from "node:assert/strict";
import { buildPhenotypeDefinition, profileValues } from "../index.js";

const mapping = (status: "discovered" | "clinician_confirmed") => ({
  schema_version: "1.0.0" as const, mapping_id: `mapping.${status}`, concept_id: "concept", mapping_version: "1.0.0",
  labels: { en: "example" }, synonyms: [], category: "diagnosis" as const, value_type: "binary" as const,
  definition: { summary: "example", temporal_rule: "before index", value_rule: "code present", missingness_rule: "explicit" },
  sources: [{ kind: "diagnosis_code" as const, schema: "mimiciv_hosp" as const, table: "diagnoses_icd", columns: ["hadm_id", "icd_code"] }],
  status, provenance: "realtime_discovery" as const, evidence: {}, created_at: "2026-01-01", updated_at: "2026-01-01",
});

test("builds a generic phenotype and explains review blockers", () => {
  const result = buildPhenotypeDefinition({ role: "exposure", label: "Any candidate condition", mappings: [mapping("discovered")] });
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.blockers[0]?.code, "MAPPING_REVIEW_REQUIRED");
  assert.match(result.blockers[0]?.message ?? "", /候选映射/u);
  assert.deepEqual(result.blockers[0]?.candidate_mapping_ids, ["mapping.discovered"]);
  assert.equal(result.mapping_references[0]?.sources[0]?.table, "diagnoses_icd");
  assert.equal(result.source_references[0]?.table, "diagnoses_icd");
});

test("distinguishes an unmapped term from a reviewable candidate", () => {
  const result = buildPhenotypeDefinition({ role: "outcome", label: "Unknown outcome", mappings: [] });
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers[0]?.code, "MAPPING_NOT_FOUND");
  assert.deepEqual(result.blockers[0]?.candidate_mapping_ids, []);
});

test("does not depend on a disease-specific label", () => {
  const result = buildPhenotypeDefinition({ role: "predictor", label: "任意研究变量", mappings: [mapping("clinician_confirmed")] });
  assert.equal(result.status, "ready");
  assert.equal(result.label, "任意研究变量");
  assert.equal(result.blockers.length, 0);
});

test("profiles aggregate values without returning source rows", () => {
  const result = profileValues([1, 2, 2, null, 4]);
  assert.deepEqual(result, { schema_version: "1.0.0", row_count: 5, missing_count: 1, non_missing_count: 4, distinct_count: 3, top_values: [{ value: "2", count: 2 }, { value: "1", count: 1 }, { value: "4", count: 1 }], numeric: { minimum: 1, maximum: 4, mean: 2.25 } });
  assert.equal("rows" in result, false);
});
