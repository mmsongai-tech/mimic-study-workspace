import assert from "node:assert/strict";
import test from "node:test";
import { toExecutionManifest } from "../index.js";

const base = { schema_version: "1.0.0" as const, manifest_id: "manifest:x", study_integrity_id: "sha256:x", data_model: "MIMIC-IV" as const, subject_id: { relation: "mimiciv_hosp.admissions", column: "hadm_id" }, fields: [{ role: "exposure" as const, requested_label: "Exposure", relation: "mimiciv_hosp.admissions", columns: ["admission_type"], status: "confirmed" as const }, { role: "outcome" as const, requested_label: "Outcome", relation: "mimiciv_hosp.admissions", columns: ["hospital_expire_flag"], status: "confirmed" as const }], time_windows: [], confirmed_at: "2026-09-07T00:00:00.000Z" };

test("converts a confirmed manifest into execution fields", () => {
  const result = toExecutionManifest(base); assert.equal(result.subject_id, "hadm_id"); assert.equal(result.exposure, "admission_type"); assert.equal(result.outcome, "hospital_expire_flag");
});

test("blocks execution when the subject identifier is not confirmed", () => {
  const { subject_id: _subject, ...withoutSubject } = base; assert.throws(() => toExecutionManifest(withoutSubject), /subject identifier/u);
});
