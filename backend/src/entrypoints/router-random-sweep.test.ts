import assert from "node:assert/strict";
import test from "node:test";
import { inferSubjectSelection, selectAcceptanceOption, selectExecutionColumn } from "./router-random-sweep.js";

test("selects an analysis value instead of an identifier or timestamp", () => {
  assert.equal(selectExecutionColumn(["subject_id", "hadm_id", "charttime", "valuenum", "valueuom"]), "valuenum");
  assert.equal(selectExecutionColumn(["stay_id", "starttime", "endtime"]), "starttime");
});

test("infers the narrowest available cohort identifier", () => {
  const mapping = {
    schema_version: "1.0.0" as const,
    data_model: "MIMIC-IV" as const,
    matches: [{ requested: { role: "outcome" as const, text: "mortality" }, status: "mapped" as const, field_candidates: [{ module: "hosp" as const, table: "admissions", columns: ["subject_id", "hadm_id", "hospital_expire_flag"] }], warnings: [] }],
    blocking_requirements: [],
  };
  assert.deepEqual(inferSubjectSelection(mapping), { relation: "hosp.admissions", columns: ["hadm_id"] });
});

test("selects an observable shared encounter anchor during automated acceptance", () => {
  const selected = selectAcceptanceOption({ id: "time_zero_definition", prompt: "请选择共同起点", options: [
    { value: "first_diagnosis", label: "首次诊断记录", explanation: "首次出现编码" },
    { value: "admission", label: "首次符合条件的住院入院", explanation: "两组均可观察" },
    { value: "drug_start", label: "首次用药", explanation: "仅治疗组有此事件" },
  ] });
  assert.equal(selected, "admission");
});
