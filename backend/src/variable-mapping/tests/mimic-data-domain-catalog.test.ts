import assert from "node:assert/strict";
import test from "node:test";
import { mimicDataDomainCatalog, terminologyDictionariesForCategory } from "../index.js";

test("routes normalized clinical categories to bounded MIMIC terminology domains", () => {
  assert.deepEqual(terminologyDictionariesForCategory("medication"), ["prescriptions_drug"]);
  assert.deepEqual(terminologyDictionariesForCategory("diagnosis"), ["d_icd_diagnoses"]);
  assert.deepEqual(terminologyDictionariesForCategory("vital_sign"), ["d_items"]);
  assert.deepEqual(terminologyDictionariesForCategory("laboratory"), ["d_labitems"]);
  assert.deepEqual(new Set(terminologyDictionariesForCategory("unknown")), new Set(["d_icd_diagnoses", "d_icd_procedures", "prescriptions_drug", "d_labitems", "d_items"]));
});

test("publishes only joinable, patient-free metadata for every domain", () => {
  assert.equal(mimicDataDomainCatalog.length, 8);
  for (const domain of mimicDataDomainCatalog) {
    assert.ok(domain.source_tables.length > 0);
    assert.ok(domain.join_keys.length > 0);
    assert.doesNotMatch(JSON.stringify(domain), /patient_row|subject_value|hadm_value|stay_value/u);
  }
});
