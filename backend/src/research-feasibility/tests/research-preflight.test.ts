import assert from "node:assert/strict";
import test from "node:test";
import type { ConfirmedStudySpec } from "../../research-design/index.js";
import { createInitialResearchPreflightService } from "../index.js";

const study: ConfirmedStudySpec = {
  schema_version: "1.0.0",
  session_id: "synthetic-session",
  revision: 1,
  confirmed_at: "2026-08-31T08:00:00.000Z",
  integrity_id: "sha256:synthetic",
  spec: {
    schema_version: "1.0.0",
    intent_family: "association",
    analysis_family: "association",
    title: "Lactate and hospital mortality",
    research_question: "Is early lactate associated with in-hospital mortality?",
    population: { description: "Synthetic adult ICU admissions" },
    index_time: { event: "ICU admission", selection_rule: "First eligible admission" },
    exposure_or_predictors: [{
      name: "Lactate",
      role: "exposure",
      operational_definition: "Maximum lactate in the first six hours",
    }],
    outcome: {
      name: "In-hospital mortality",
      role: "outcome",
      operational_definition: "Death before hospital discharge",
    },
    time_windows: [{
      purpose: "outcome",
      anchor: "index_time",
      start_offset: 6,
      end_offset: 30,
      unit: "day",
    }],
    estimand: {
      target_population: "Synthetic adult ICU admissions",
      exposure_contrast: "Lactate above versus at or below threshold",
      outcome_measure: "In-hospital mortality",
      summary_measure: "Odds ratio",
    },
  },
};

const completeDataSource = {
  id: "synthetic-mimic-safety",
  version: "1.0.0",
  data_mode: "synthetic" as const,
  available_concepts: [
    "icu_admission_time",
    "lactate_measurement",
    "hospital_discharge_status",
  ],
};

test("supports the registered lactate association when data requirements are present", () => {
  const result = createInitialResearchPreflightService().check({
    study,
    data_source: completeDataSource,
  });

  assert.equal(result.status, "supported");
  assert.equal(result.capability_id, "association.lactate.in_hospital_mortality.v1");
  assert.deepEqual(result.missing_requirements, []);
});

test("supports the registered lactate association with Chinese clinical labels", () => {
  const result = createInitialResearchPreflightService().check({
    study: {
      ...study,
      spec: {
        ...study.spec,
        exposure_or_predictors: [{ name: "早期乳酸", role: "exposure", operational_definition: "入科后六小时内首次乳酸" }],
        outcome: { name: "院内死亡", role: "outcome", operational_definition: "出院前死亡" },
      },
    },
    data_source: completeDataSource,
  });

  assert.equal(result.status, "supported");
  assert.equal(result.capability_id, "association.lactate.in_hospital_mortality.v1");
});

test("fails closed when a required data concept is missing", () => {
  const result = createInitialResearchPreflightService().check({
    study,
    data_source: { ...completeDataSource, available_concepts: ["lactate_measurement"] },
  });

  assert.equal(result.status, "unsupported");
  assert.equal(result.missing_requirements.length, 2);
});

test("does not silently convert an unmatched confirmed study", () => {
  const result = createInitialResearchPreflightService().check({
    study: {
      ...study,
      spec: {
        ...study.spec,
        exposure_or_predictors: [{
          name: "Creatinine",
          role: "exposure",
          operational_definition: "First creatinine after admission",
        }],
      },
    },
    data_source: completeDataSource,
  });

  assert.equal(result.status, "unsupported");
  assert.match(result.warnings.join(" "), /not silently converted/u);
});

test("does not execute a crude model for an adjusted estimand", () => {
  const result = createInitialResearchPreflightService().check({
    study: {
      ...study,
      spec: {
        ...study.spec,
        estimand: { ...study.spec.estimand!, summary_measure: "Adjusted odds ratio" },
      },
    },
    data_source: completeDataSource,
  });

  assert.equal(result.status, "unsupported");
  assert.match(result.missing_requirements.join(" "), /adjusted/u);
  assert.match(result.warnings.join(" "), /not replaced by a crude analysis/u);
});
