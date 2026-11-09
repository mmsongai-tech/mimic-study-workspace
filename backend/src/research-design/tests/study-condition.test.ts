import assert from "node:assert/strict";
import test from "node:test";
import type { StudyCondition } from "../index.js";
import { listStudyConditions, validateStudyCondition } from "../index.js";

const condition: StudyCondition = {
  condition_id: "population.all",
  source_text: "接受机械通气的成人 ICU 患者",
  kind: "all",
  operands: [
    { condition_id: "population.adult", source_text: "成人", kind: "numeric_comparison", concept: "age", operator: "gte", value: 18, unit: "year" },
    { condition_id: "population.icu", source_text: "ICU 患者", kind: "concept", concept: "ICU stay", assertion: "present" },
    { condition_id: "population.ventilation", source_text: "接受机械通气", kind: "event_exists", concept: "invasive mechanical ventilation", occurrence: "present", window: { purpose: "baseline", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" } },
  ],
};

test("preserves every leaf of a compound population condition", () => {
  assert.deepEqual(listStudyConditions(condition).map(({ condition_id }) => condition_id), ["population.all", "population.adult", "population.icu", "population.ventilation"]);
  assert.deepEqual(validateStudyCondition(condition), []);
});

test("reports duplicate identifiers and invalid event windows", () => {
  const duplicateEvent: StudyCondition = { condition_id: "population.adult", source_text: "接受机械通气", kind: "event_exists", concept: "invasive mechanical ventilation", occurrence: "present", window: { purpose: "baseline", anchor: "index_time", start_offset: 24, end_offset: 0, unit: "hour" } };
  const invalid: StudyCondition = { ...condition, operands: [condition.operands[0]!, duplicateEvent] };
  assert.deepEqual(validateStudyCondition(invalid).map(({ code }) => code), ["CONDITION_ID_DUPLICATE", "CONDITION_WINDOW_INVALID"]);
});
