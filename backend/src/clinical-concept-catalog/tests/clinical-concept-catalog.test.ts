import assert from "node:assert/strict";
import test from "node:test";
import { ClinicalConceptCatalogService } from "../index.js";

const cases = [
  ["入科六小时内最高乳酸", "lactate"],
  ["Maximum blood lactate", "lactate"],
  ["基线肌酐", "creatinine"],
  ["Use serum creatinine", "creatinine"],
  ["年龄和死亡风险", "age"],
  ["Adjust for patient age", "age"],
  ["性别是否与结局相关", "sex"],
  ["Adjust for gender", "sex"],
  ["ICU 入科后六小时", "icu_admission"],
  ["First ICU admission", "icu_admission"],
  ["平均动脉压与死亡", "mean_arterial_pressure"],
  ["Lowest mean arterial pressure", "mean_arterial_pressure"],
  ["呼吸频率预测机械通气", "respiratory_rate"],
  ["First respiratory rate", "respiratory_rate"],
  ["血氧饱和度作为预测因子", "oxygen_saturation"],
  ["Minimum SpO2", "oxygen_saturation"],
  ["血红蛋白与输血", "hemoglobin"],
  ["Baseline haemoglobin", "hemoglobin"],
  ["入院白细胞计数", "white_blood_cell_count"],
  ["Maximum WBC", "white_blood_cell_count"],
  ["早期使用升压药", "vasopressor_exposure"],
  ["Norepinephrine exposure", "vasopressor_exposure"],
  ["抗生素治疗时间", "antibiotic_exposure"],
  ["Early antimicrobial therapy", "antibiotic_exposure"],
  ["有创机械通气风险", "invasive_ventilation"],
  ["Time to intubation", "invasive_ventilation"],
  ["连续性肾脏替代治疗", "renal_replacement_therapy"],
  ["CRRT initiation", "renal_replacement_therapy"],
  ["脓毒症患者", "sepsis"],
  ["Patients with sepsis", "sepsis"],
  ["SOFA 评分变化", "sofa_score"],
  ["Maximum SOFA score", "sofa_score"],
  ["院内死亡结局", "in_hospital_mortality"],
  ["In-hospital mortality outcome", "in_hospital_mortality"],
  ["生存时间分析", "time_to_death"],
  ["Overall survival", "time_to_death"],
  ["ICU 时长", "length_of_stay"],
  ["Length of stay", "length_of_stay"],
] as const;

for (const [text, expected] of cases) {
  test(`resolves clinical concept: ${text}`, () => {
    const result = new ClinicalConceptCatalogService().resolve({ role: "predictor", text });
    assert.equal(result.status, "resolved");
    assert.equal(result.concept?.id, expected);
    assert.ok(result.requirements.length >= 2);
    assert.match(result.warnings[0] ?? "", /source-specific mapping/iu);
  });
}

test("blocks an unknown concept instead of inventing a mapping", () => {
  const result = new ClinicalConceptCatalogService().resolve({ role: "outcome", text: "未知复合器官指标" });
  assert.equal(result.status, "unresolved");
  assert.equal(result.concept, undefined);
  assert.ok(result.requirements.length > 0);
});

test("returns defensive copies of catalog definitions", () => {
  const service = new ClinicalConceptCatalogService();
  const first = service.get("lactate");
  assert.ok(first);
  first.synonyms.push("mutated");
  assert.equal(service.get("lactate")?.synonyms.includes("mutated"), false);
});

test("assesses a structured study without guessing source mappings", () => {
  const result = new ClinicalConceptCatalogService().assessStudy({
    schema_version: "1.0.0",
    intent_family: "association",
    exposure_or_predictors: [{ name: "Lactate", role: "exposure", operational_definition: "Maximum in six hours" }],
    outcome: { name: "In-hospital mortality", role: "outcome", operational_definition: "Death before discharge" },
    covariates: [{ name: "Age", role: "covariate", operational_definition: "Age at admission" }],
  });
  assert.equal(result.status, "ready_for_source_mapping");
  assert.deepEqual(result.resolutions.map(({ concept }) => concept?.id), ["lactate", "in_hospital_mortality", "age"]);
  assert.ok(result.resolutions.every(({ warnings }) => warnings.some((warning) => warning.includes("source-specific mapping"))));
});

test("blocks a study containing an undefined clinical variable", () => {
  const result = new ClinicalConceptCatalogService().assessStudy({
    schema_version: "1.0.0",
    intent_family: "prediction",
    exposure_or_predictors: [{ name: "Unregistered bedside gestalt index", role: "predictor", operational_definition: "Undefined" }],
  });
  assert.equal(result.status, "needs_clarification");
  assert.match(result.blocking_requirements[0] ?? "", /Define predictor/iu);
});
