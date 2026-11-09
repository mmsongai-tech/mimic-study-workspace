import assert from "node:assert/strict";
import test from "node:test";
import { createManifestDraft, decomposeStudy, freezeConfirmedManifest } from "../index.js";

const study = { schema_version: "1.0.0" as const, intent_family: "association" as const, population: { description: "Adults" }, index_time: { event: "ICU admission", selection_rule: "first" }, exposure_or_predictors: [{ name: "Exposure", role: "exposure" as const, operational_definition: "defined exposure" }], outcome: { name: "Death", role: "outcome" as const, operational_definition: "death before discharge" }, outcome_structure: "binary" as const };
const mapping = { schema_version: "1.0.0" as const, data_model: "MIMIC-IV" as const, blocking_requirements: [], matches: [{ requested: { role: "exposure" as const, text: "Exposure" }, status: "mapped" as const, concept_id: "concept.exposure", field_candidates: [], warnings: [] }, { requested: { role: "outcome" as const, text: "Death" }, status: "mapped" as const, concept_id: "concept.death", field_candidates: [], warnings: [] }] };

test("decomposes a complete study without inventing variables", () => {
  const result = decomposeStudy(study); assert.equal(result.intent, "association"); assert.equal(result.exposure_or_predictors[0]!.name, "Exposure"); assert.deepEqual(result.issues, []);
});

test("freezes confirmed selections with stable integrity identifiers", () => {
  const first = freezeConfirmedManifest(study, mapping, { Exposure: { relation: "mimiciv_hosp.admissions", columns: ["hadm_id"] }, Death: { relation: "mimiciv_hosp.admissions", columns: ["hospital_expire_flag"] } }, "2026-09-07T00:00:00.000Z");
  const second = freezeConfirmedManifest(study, mapping, { Exposure: { relation: "mimiciv_hosp.admissions", columns: ["hadm_id"] }, Death: { relation: "mimiciv_hosp.admissions", columns: ["hospital_expire_flag"] } }, "2026-09-07T00:00:00.000Z");
  assert.equal(first.manifest_id, second.manifest_id); assert.equal(first.fields.length, 2); assert.match(first.manifest_id, /^manifest:/u);
});

test("requires an explicit selection for every mapped concept", () => {
  assert.throws(() => freezeConfirmedManifest(study, mapping, { Exposure: { relation: "r", columns: ["c"] } }), /confirmed field selection/u);
});

test("creates a candidate manifest without silently confirming clinical meaning", () => {
  const draft = createManifestDraft(study, { ...mapping, matches: [{ ...mapping.matches[0]!, field_candidates: [{ module: "hosp", table: "admissions", columns: ["admission_type"] }] }, { ...mapping.matches[1]!, status: "requires_dictionary_resolution", field_candidates: [{ module: "hosp", table: "admissions", columns: ["hospital_expire_flag"], dictionary_table: "d_icd_diagnoses" }] }] });
  assert.equal(draft.requires_user_confirmation, true); assert.equal(draft.fields[0]!.status, "candidate"); assert.equal(draft.fields[1]!.status, "blocked"); assert.match(draft.blocking_reasons.join(" "), /researcher review/u);
});

test("preserves an unmapped concept as an explicit blocker", () => {
  const draft = createManifestDraft(study, { ...mapping, matches: [{ ...mapping.matches[0]!, status: "unmapped", field_candidates: [] }] });
  assert.equal(draft.fields[0]!.status, "unmapped"); assert.match(draft.fields[0]!.reasons.join(" "), /candidate was found/u);
});

test("does not freeze a manifest while any requested variable is unmapped", () => {
  const incomplete = { ...mapping, matches: [...mapping.matches, { requested: { role: "covariate" as const, text: "Unknown severity marker" }, status: "unmapped" as const, field_candidates: [], warnings: [] }], blocking_requirements: ["No confirmed mapping for Unknown severity marker."] };
  assert.throws(() => freezeConfirmedManifest(study, incomplete, { Exposure: { relation: "mimiciv_hosp.admissions", columns: ["hadm_id"] }, Death: { relation: "mimiciv_hosp.admissions", columns: ["hospital_expire_flag"] } }), /Variable mapping is incomplete/u);
});
