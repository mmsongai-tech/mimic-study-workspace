import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClinicalConcept } from "../index.js";

test("normalizes equivalent clinical labels without assigning meaning", () => {
  const result = normalizeClinicalConcept("  ICU-admission_time  ");
  assert.equal(result.normalized, "icu admission time");
  assert.equal(result.language, "en");
  assert.deepEqual(result.tokens, ["icu", "admission", "time"]);
  assert.deepEqual(result.surface_forms, ["ICU-admission_time", "icu admission time", "icuadmissiontime"]);
});

test("preserves Chinese and mixed-language search forms", () => {
  assert.equal(normalizeClinicalConcept("入院后 6 小时").language, "zh");
  assert.equal(normalizeClinicalConcept("ICU 入院").language, "mixed");
  assert.equal(normalizeClinicalConcept("///").normalized, "");
});
