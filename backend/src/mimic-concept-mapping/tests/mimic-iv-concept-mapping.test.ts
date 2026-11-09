import assert from "node:assert/strict";
import test from "node:test";
import { MimicIvConceptMappingService } from "../index.js";
import type { StudySpec } from "../../research-design/study-spec.js";

const study = (exposure: string, outcome: string): StudySpec => ({
  schema_version: "1.0.0",
  intent_family: "association",
  population: { description: "Adult ICU admissions" },
  index_time: { event: "ICU admission", selection_rule: "First ICU stay" },
  exposure_or_predictors: [{ name: exposure, role: "exposure", operational_definition: exposure }],
  outcome: { name: outcome, role: "outcome", operational_definition: outcome },
});

test("maps stable MIMIC-IV admission concepts without inventing item identifiers", () => {
  const result = new MimicIvConceptMappingService().mapStudy(study("Early antibiotics", "28-day mortality"));
  assert.equal(result.data_model, "MIMIC-IV");
  assert.ok(result.matches.some(({ concept_id, status }) => concept_id === "antibiotic_exposure" && status === "mapped"));
  assert.ok(result.matches.some(({ concept_id, status }) => concept_id === "mortality" && status === "mapped"));
});

test("requires dictionary verification for item-based fluid balance", () => {
  const result = new MimicIvConceptMappingService().mapStudy(study("24-hour positive fluid balance", "28-day mortality"));
  assert.ok(result.matches.some(({ concept_id, status }) => concept_id === "fluid_balance" && status === "requires_dictionary_resolution"));
  assert.ok(result.blocking_requirements.includes("Dictionary resolution required for fluid_balance"));
});

test("fails closed for an unregistered clinical concept", () => {
  const result = new MimicIvConceptMappingService().mapStudy(study("Unknown biomarker Z", "28-day mortality"));
  assert.ok(result.matches.some(({ requested, status }) => requested.role === "exposure" && status === "unmapped"));
  assert.ok(result.blocking_requirements.some((requirement) => requirement.startsWith("Unmapped exposure:")));
});

