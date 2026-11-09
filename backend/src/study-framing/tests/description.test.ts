import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { JsonSchemaResearchDesignValidator } from "../../research-design/index.js";
import { buildFrames, compileStudyPlans, dropDuplicateFrames, goalFromCues, unaccountedConcepts, buildConceptFinder, type FrameExtraction, type StudyFrame } from "../index.js";

// A description-only question: a population, an optional grouping and characteristics, with no outcome to relate to an exposure.
const frameSetSchema = JSON.parse(readFileSync(new URL("../../../../contracts/study-framing/study-frame.schema.json", import.meta.url), "utf8")) as object;
const validateFrameSet = new Ajv2020({ strict: true, allErrors: true }).compile(frameSetSchema);
const validator = new JsonSchemaResearchDesignValidator();
const extraction = (overrides: Partial<FrameExtraction>): FrameExtraction => ({
  goal: "describe", outcome_kind: "none", dose_question: false, population: "", exposure: "", exposure_categories: [], comparator: "",
  outcomes: [], composite_outcome: "", modifiers: [], mediators: [], predictors: [], time_window: "", ...overrides,
});
const frames = (question: string, overrides: Partial<FrameExtraction>, subQuestion = question): StudyFrame[] => buildFrames({ question, sub_question: subQuestion, first_id: 1, extraction: extraction(overrides) });

test("a description lists its characteristics in one aim with no outcome, and a listed death rate is a characteristic", () => {
  const question = "按性别描述心衰住院患者的年龄、肌酐和住院死亡率";
  // The model's own reading of this question (qwen2.5:7b, 2026-11-04): outcome_kind "value", three outcomes, sex in the exposure slot.
  const result = frames(question, { outcome_kind: "value", population: "心衰住院患者", exposure: "性别", exposure_categories: ["男性", "女性"], outcomes: ["年龄", "肌酐", "住院死亡率"] });
  assert.equal(result.length, 1, "one description, not one aim per characteristic");
  const [frame] = result;
  assert.equal(frame!.study_type, "descriptive");
  assert.equal(frame!.status, "ready");
  assert.equal(frame!.outcome, undefined);
  assert.equal(frame!.facets.outcome_kind, "none");
  assert.equal(frame!.exposure?.text, "性别");
  assert.deepEqual(frame!.characteristics?.map(({ text }) => text), ["年龄", "肌酐", "住院死亡率"]);
  assert.ok(validateFrameSet({ schema_version: "1.0.0", original_question: question, frames: result }), JSON.stringify(validateFrameSet.errors));
});

test("a description asking only for characteristics in general describes the default first-day set, named by rule", () => {
  const question = "描述ICU脓毒症患者的基线特征";
  const [frame] = frames(question, { population: "ICU脓毒症患者" });
  assert.equal(frame!.study_type, "descriptive");
  assert.equal(frame!.status, "ready");
  const characteristics = frame!.characteristics ?? [];
  assert.ok(characteristics.length >= 15);
  assert.ok(characteristics.every(({ normalized }) => normalized?.source === "catalog"), "defaults need no model translation");
  assert.ok(characteristics.some(({ text, normalized }) => text === "乳酸" && normalized?.label_en === "Lactate" && normalized.category === "laboratory"));
  assert.ok(frame!.assumptions.some((text) => text.includes("names no specific variables") && text.includes("（")), "the default set is stated in both languages");
});

test("a request for the number of patients is the cohort count, and 'their characteristics' in the question gives the default set", () => {
  const question = "How many patients with heart failure received beta blockers, and what are their characteristics?";
  // The question split kept only the first clause; the model listed "count of patients" as the outcome.
  const [frame] = frames(question, { outcome_kind: "count", population: "patients with heart failure", exposure: "beta blockers", outcomes: ["count of patients"] }, "How many patients with heart failure received beta blockers");
  assert.equal(frame!.study_type, "descriptive");
  assert.equal(frame!.outcome, undefined);
  assert.equal(frame!.exposure?.text, "beta blockers");
  assert.ok(!(frame!.characteristics ?? []).some(({ text }) => text === "count of patients"));
  assert.ok((frame!.characteristics ?? []).some(({ text }) => text === "Creatinine"), "English defaults for an English question");
  assert.ok(frame!.assumptions.some((text) => text.includes("asks for the number of patients")));
  assert.ok(!frame!.ambiguities.some(({ code }) => code === "SLOT_NOT_IN_QUESTION"), "no inferred outcome is left to confirm");
});

const read = (goal: FrameExtraction["goal"], overrides: Partial<FrameExtraction> = {}): FrameExtraction => extraction({ goal, outcome_kind: "event", ...overrides });

test("explicit describe wording without any relation word makes a description when the model read a comparison or an association", () => {
  assert.equal(goalFromCues("按性别描述心衰住院患者的年龄、肌酐和住院死亡率", read("compare_groups")), "describe");
  assert.equal(goalFromCues("Describe the baseline characteristics of patients with sepsis", read("relate_factor")), "describe");
  // A relation, a comparison or a prediction keeps the model's aim.
  assert.equal(goalFromCues("描述男性和女性住院死亡率的差异", read("compare_groups")), "compare_groups");
  assert.equal(goalFromCues("Describe the association between lactate and death", read("relate_factor")), "relate_factor");
  assert.equal(goalFromCues("糖尿病患者使用二甲双胍与住院死亡的关系", read("evaluate_treatment")), "evaluate_treatment");
  const [frame] = frames("按性别描述心衰住院患者的年龄和住院死亡率", { goal: "compare_groups", outcome_kind: "value", population: "心衰住院患者", exposure: "性别", outcomes: ["年龄", "住院死亡率"] });
  assert.equal(frame!.study_type, "descriptive");
  assert.equal(frame!.characteristics?.length, 2);
});

test("a description's grouping filed as a modifier is the grouping, and an effect-modification aim without one is a plain description", () => {
  const [frame] = buildFrames({ question: "按性别描述心衰患者的肌酐", sub_question: "按性别描述心衰患者的肌酐", first_id: 1, aim: "effect_modification", extraction: extraction({ population: "心衰患者", modifiers: ["性别"], outcomes: ["肌酐"] }) });
  assert.equal(frame!.study_type, "descriptive");
  assert.equal(frame!.exposure?.text, "性别");
  assert.deepEqual(frame!.modifiers, []);
  assert.ok(frame!.assumptions.some((text) => text.includes("grouping of the description")));
});

// Review of 2026-11-04: describe wording, or "characteristics" named only as what is adjusted for, turned treatment, prediction,
// modification and mediation questions into descriptions. Each case below was a description on 12ddd2e.
test("characteristics adjusted for, a treatment or prediction aim, a modifier or mediator, a dose or a course over time keep the model's aim", () => {
  const heparin = (question: string, overrides: Partial<FrameExtraction> = {}, aim: "main" | "effect_modification" | "mediation" = "main") => buildFrames({ question, sub_question: question, first_id: 1, aim,
    extraction: extraction({ goal: "evaluate_treatment", outcome_kind: "event", population: /\p{Script=Han}/u.test(question) ? "脓毒症患者" : "sepsis", exposure: /\p{Script=Han}/u.test(question) ? "早期使用肝素" : "early heparin", outcomes: [/\p{Script=Han}/u.test(question) ? "28天死亡率" : "28-day mortality"], time_window: "28 days", ...overrides }) });
  for (const question of ["Does early heparin reduce 28-day mortality in patients with sepsis, adjusting for baseline characteristics?", "调整基线特征后，早期使用肝素能否降低脓毒症患者的28天死亡率？", "倾向评分匹配基线特征后，早期使用肝素是否降低脓毒症患者的28天死亡率？"]) {
    const [frame] = heparin(question);
    assert.equal(frame!.study_type, "treatment_effect", question);
    assert.ok(frame!.outcome, question);
    assert.equal(frame!.characteristics, undefined, question);
  }
  // A modification or mediation aim keeps its treatment reading, so the illness-severity adjustment set stays.
  const normalize = (frame: StudyFrame): StudyFrame => {
    frame.population!.normalized = { label_en: "Sepsis", category: "diagnosis" }; frame.exposure!.normalized = { label_en: "Heparin", category: "medication" }; frame.outcome!.normalized = { label_en: "Death", category: "outcome" };
    for (const slot of [...frame.modifiers, ...frame.mediators]) slot.normalized = slot.text === "sex" ? { label_en: "Sex", category: "demographic" } : { label_en: "Platelet count", category: "laboratory" };
    return frame;
  };
  const [modified] = heparin("Is the reduction in 28-day mortality with early heparin in sepsis modified by sex after adjusting for baseline characteristics?", { modifiers: ["sex"] }, "effect_modification");
  assert.equal(modified!.study_type, "effect_modification");
  assert.equal(modified!.facets.goal, "evaluate_treatment");
  const modification = compileStudyPlans(normalize(modified!), "Is the reduction in 28-day mortality with early heparin in sepsis modified by sex after adjusting for baseline characteristics?")[0]!.study_spec;
  assert.equal(modification.intent_family, "treatment_effect");
  assert.ok(modification.covariates?.some(({ name }) => name === "Lactate"), "the severity set is kept");
  const [mediated] = heparin("How much of the 28-day mortality reduction with early heparin in sepsis is mediated by platelet count, adjusting for baseline characteristics?", { mediators: ["platelet count"] }, "mediation");
  assert.equal(mediated!.facets.goal, "evaluate_treatment");
  assert.equal(compileStudyPlans(normalize(mediated!), "How much of the 28-day mortality reduction with early heparin in sepsis is mediated by platelet count, adjusting for baseline characteristics?")[0]!.study_spec.intent_family, "treatment_effect");
  // Prediction keeps its predictors and outcome.
  const prognosis = "Describe the prognostic value of lactate and SOFA score for 28-day mortality in sepsis";
  const [predicted] = buildFrames({ question: prognosis, sub_question: prognosis, first_id: 1, extraction: extraction({ goal: "predict", outcome_kind: "event", population: "sepsis", outcomes: ["28-day mortality"], predictors: ["lactate", "SOFA score"], time_window: "28 days" }) });
  assert.equal(predicted!.study_type, "prediction");
  assert.deepEqual(predicted!.predictors.map(({ text }) => text), ["lactate", "SOFA score"]);
  assert.equal(goalFromCues("描述乳酸对脓毒症患者28天死亡的预后价值", read("predict")), "predict");
  assert.equal(goalFromCues("基线特征能否识别28天内死亡的脓毒症患者？", read("predict")), "predict");
  // A comparison or an association read by the model stays one when the question sizes an effect, follows a course or asks for a dose…
  assert.equal(goalFromCues("Describe whether early heparin reduces 28-day mortality in sepsis", read("relate_factor")), "relate_factor");
  assert.equal(goalFromCues("描述ICU患者乳酸水平随时间的变化趋势", read("relate_factor")), "relate_factor");
  assert.equal(goalFromCues("Describe the change in creatinine over 72 hours after vancomycin in ICU patients", read("relate_factor", { outcome_kind: "change_over_time" })), "relate_factor");
  assert.equal(goalFromCues("描述去甲肾上腺素剂量与死亡率的剂量反应", read("relate_factor", { dose_question: true })), "relate_factor");
  assert.equal(goalFromCues("Describe survival of sepsis patients by vasopressor use", read("compare_groups", { outcome_kind: "time_to_event" })), "compare_groups");
  // …or when its only describe word is the characteristics it adjusts for.
  assert.equal(goalFromCues("Vasopressor use and 28-day mortality in sepsis, adjusted for baseline characteristics", read("relate_factor")), "relate_factor");
  assert.equal(goalFromCues("按性别描述心衰住院患者的肌酐", read("compare_groups", { modifiers: ["性别"] })), "compare_groups", "a modifier keeps the model's reading");
});

test("a description with several groupings is one description per grouping, never an effect-modification analysis", () => {
  const question = "按性别和年龄组描述心衰住院患者的住院死亡率";
  for (const aim of ["main", "effect_modification"] as const) {
    for (const overrides of [{ modifiers: ["性别", "年龄组"] }, { exposure: "性别", modifiers: ["年龄组"] }]) {
      const result = buildFrames({ question, sub_question: question, first_id: 3, aim, extraction: extraction({ outcome_kind: "event", population: "心衰住院患者", outcomes: ["住院死亡率"], ...overrides }) });
      assert.equal(result.length, 2, `${aim} ${JSON.stringify(overrides)}`);
      assert.deepEqual(result.map(({ frame_id }) => frame_id), ["f3", "f4"]);
      assert.deepEqual(result.map(({ exposure }) => exposure?.text), ["性别", "年龄组"]);
      for (const frame of result) {
        assert.equal(frame.study_type, "descriptive");
        assert.equal(frame.status, "ready");
        assert.deepEqual(frame.modifiers, []);
        assert.equal(frame.outcome, undefined);
        assert.deepEqual(frame.characteristics?.map(({ text }) => text), ["住院死亡率"]);
        assert.ok(frame.assumptions.some((text) => text.includes("each is described in its own Table 1") && text.includes("不做交叉分组")));
        frame.population!.normalized = { label_en: "Heart failure", category: "diagnosis" }; frame.exposure!.normalized = { label_en: frame.exposure!.text === "性别" ? "Sex" : "Age group", category: "demographic" };
        frame.characteristics![0]!.normalized = { label_en: "In-hospital mortality", category: "outcome" };
        const [plan] = compileStudyPlans(frame, question);
        assert.equal(plan!.study_spec.estimand, undefined, "no effect estimate, so no interaction P");
        assert.equal(plan!.study_spec.analysis_family, undefined);
      }
    }
  }
  // Describe wording that names a difference stays what it was before descriptions existed: an effect-modification aim that needs an exposure.
  const [difference] = buildFrames({ question: "描述男性和女性住院死亡率的差异", sub_question: "描述男性和女性住院死亡率的差异", first_id: 1, extraction: extraction({ outcome_kind: "event", modifiers: ["性别"], outcomes: ["住院死亡率"] }) });
  assert.equal(difference!.study_type, "effect_modification");
  assert.equal(difference!.status, "needs_clarification");
});

test("a composite named in a description is described by its parts, or as the one phrase, never dropped", () => {
  const [mace] = frames("描述心衰住院患者的MACE发生率", { population: "心衰住院患者", composite_outcome: "MACE" });
  assert.equal(mace!.study_type, "descriptive");
  assert.deepEqual(mace!.characteristics?.map(({ text }) => text), ["心血管死亡", "心肌梗死", "中风"]);
  assert.ok(mace!.assumptions.some((text) => text.includes("described by its parts") && text.includes("不合并")));
  const [own] = frames("描述心衰患者的不良结局（包括：死亡、再入院）", { population: "心衰患者", composite_outcome: "不良结局" });
  assert.deepEqual(own!.characteristics?.map(({ text }) => text), ["死亡", "再入院"]);
  const [unknown] = frames("描述心衰患者的不良事件", { population: "心衰患者", composite_outcome: "不良事件" });
  assert.deepEqual(unknown!.characteristics?.map(({ text }) => text), ["不良事件"]);
});

test("two descriptions of the same patients and grouping become one with every characteristic", () => {
  const first = frames("心衰患者有多少", { population: "心衰患者", outcomes: ["年龄"] })[0]!;
  const second = { ...frames("心衰患者有多少", { population: "心衰患者", outcomes: ["肌酐"] })[0]!, frame_id: "f2" };
  const merged = dropDuplicateFrames([first, second]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.characteristics?.map(({ text }) => text), ["年龄", "肌酐"]);
});

test("characteristics count as carried concepts, so none is reported as left out of the analysis", () => {
  const find = buildConceptFinder([{ id: "creatinine", label: "Creatinine", names: ["肌酐"] }, { id: "heart_failure", label: "Heart failure", names: ["心衰"] }]);
  const [frame] = frames("描述心衰患者的肌酐", { population: "心衰患者", outcomes: ["肌酐"] });
  assert.deepEqual(unaccountedConcepts(frame!, find), []);
});

test("compiles a description into one plan whose characteristics are described, never an outcome or adjustment", () => {
  const question = "按性别描述心衰住院患者的年龄、肌酐和住院死亡率";
  const [frame] = frames(question, { outcome_kind: "value", population: "心衰住院患者", exposure: "性别", exposure_categories: ["男性", "女性"], outcomes: ["年龄", "肌酐", "住院死亡率"] });
  frame!.population!.normalized = { label_en: "Heart failure", category: "diagnosis" };
  frame!.exposure!.normalized = { label_en: "Sex", category: "demographic" };
  const labels: Record<string, { label_en: string; category: "demographic" | "laboratory" | "outcome" }> = { 年龄: { label_en: "Age", category: "demographic" }, 肌酐: { label_en: "Creatinine", category: "laboratory" }, 住院死亡率: { label_en: "In-hospital mortality", category: "outcome" } };
  for (const slot of frame!.characteristics ?? []) slot.normalized = labels[slot.text]!;
  const plans = compileStudyPlans(frame!, question);
  assert.equal(plans.length, 1);
  const spec = plans[0]!.study_spec;
  assert.equal(spec.outcome, undefined);
  assert.equal(spec.estimand, undefined);
  assert.equal(spec.analysis_family, undefined);
  assert.deepEqual(spec.exposure_or_predictors?.map(({ name, role }) => [name, role]), [["Sex", "exposure"]]);
  assert.deepEqual(spec.characteristics?.map(({ name, role, definition }) => [name, role, definition?.condition_id]), [
    ["Age", "covariate", "characteristic.1"], ["Creatinine", "covariate", "characteristic.2"], ["In-hospital mortality", "outcome", "characteristic.3"]]);
  // Age is the named characteristic and sex the grouping, so Table 1 lists only the Charlson index besides them.
  assert.deepEqual(spec.covariates?.map(({ name }) => name), ["Charlson comorbidity index"]);
  // Death is read to the end of the admission; creatinine in the first 24 hours.
  assert.ok(spec.time_windows?.some((window) => window.purpose === "outcome" && "end_event" in window));
  assert.ok(spec.time_windows?.some((window) => window.purpose === "baseline" && "end_offset" in window && window.end_offset === 24));
  assert.ok(spec.assumptions?.some((text) => text.startsWith("A description reports the number of patients")));
  assert.ok(!spec.assumptions?.some((text) => text.includes("if it lacks the exposure or the outcome")), "a description drops no unit for a missing value");
  assert.ok(!spec.assumptions?.some((text) => text.includes("default adjustment variables")));
  assert.deepEqual(validator.checkStudySpec(spec), []);
});

test("a description without an outcome-type characteristic has no outcome window, and a grouping with levels is one plan", () => {
  const question = "描述使用β受体阻滞剂或ACEI的心衰患者的肌酐";
  const [frame] = frames(question, { population: "心衰患者", exposure: "β受体阻滞剂或ACEI", exposure_categories: ["β受体阻滞剂", "ACEI"], outcomes: ["肌酐"] });
  const plans = compileStudyPlans(frame!, question);
  assert.equal(plans.length, 1, "a grouping is never fanned out into one plan per level");
  assert.ok(!plans[0]!.study_spec.time_windows?.some(({ purpose }) => purpose === "outcome"));
  assert.ok(!plans[0]!.study_spec.assumptions?.some((text) => text.startsWith("Outcomes are followed")));
});
