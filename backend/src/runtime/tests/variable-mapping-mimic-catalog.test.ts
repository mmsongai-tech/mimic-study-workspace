import assert from "node:assert/strict";
import test from "node:test";
import { MimicIvConceptMappingService } from "../../mimic-concept-mapping/index.js";
import type { VariableMappingRecord } from "../../variable-mapping/index.js";
import { MutableVariableMappingMimicCatalog } from "../variable-mapping-mimic-catalog.js";

test("makes a clinician-confirmed reusable mapping available to analysis planning immediately", () => {
  const catalog = new MutableVariableMappingMimicCatalog();
  catalog.register({ schema_version: "1.0.0", mapping_id: "diabetes.v1", concept_id: "diabetes", mapping_version: "1.0.0", labels: { en: "Diabetes mellitus", zh: "糖尿病" }, synonyms: ["diabetes"], category: "diagnosis", value_type: "binary", definition: { summary: "Diabetes diagnosis", temporal_rule: "Known by admission", value_rule: "Confirmed ICD set", missingness_rule: "No code is not assumed disease-free" }, sources: [{ kind: "diagnosis_code", schema: "mimiciv_hosp", table: "diagnoses_icd", columns: ["hadm_id", "icd_code", "icd_version"], dictionary_table: "d_icd_diagnoses", codes: [{ code: "E11", version: 10 }] }], status: "clinician_confirmed", provenance: "clinician_review", evidence: {}, created_at: "2026-09-02T00:00:00Z", updated_at: "2026-09-02T00:00:00Z" } satisfies VariableMappingRecord);
  const result = new MimicIvConceptMappingService(catalog).mapStudy({ schema_version: "1.0.0", intent_family: "association", title: "Diabetes and mortality", research_question: "Diabetes and mortality", population: { description: "ICU patients with diabetes" }, exposure_or_predictors: [], assumptions: [] });
  assert.equal(result.matches[0]?.status, "mapped");
});
