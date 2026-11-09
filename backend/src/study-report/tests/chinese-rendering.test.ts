import assert from "node:assert/strict";
import test from "node:test";
import type { QuestionRunResult } from "../../question-pipeline/index.js";
import { assumptionText, buildLabeler, checkText, estimateLabel } from "../chinese-rendering.js";
import { buildReportDocument } from "../index.js";

// Synthetic fixture: hand-written frame and plan, no run data.
const slot = (text: string, label_en: string, category = "medication") => ({ text, verbatim: true, normalized: { label_en, category } });
const frame = {
  frame_id: "f1", sub_question: "美托洛尔对降压的效果", study_type: "treatment_effect", assumptions: [], ambiguities: [], facets: {},
  exposure: slot("美托洛尔", "Metoprolol"), outcome: slot("血压", "blood pressure", "measurement"),
  modifiers: [slot("性别", "Gender", "demographic")], mediators: [], predictors: [],
};
const window = (purpose: string, start: number, end: number) => ({ purpose, anchor: "index_time", start_offset: start, end_offset: end, unit: "hour" });
const covariate = (name: string) => ({ name, role: "covariate", operational_definition: `${name} at the index time.` });
const spec = {
  schema_version: "1.0.0", intent_family: "treatment_effect", population: { description: "高血压患者" },
  index_time: { event: "hospital admission", selection_rule: "first hospital admission per patient" },
  exposure_or_predictors: [{ name: "Metoprolol", role: "exposure", operational_definition: "Any recorded Metoprolol within the first 24 hours after the index time.", contrast: { kind: "binary_presence" }, aggregation: "any" }],
  outcome: { name: "blood pressure change", role: "outcome", operational_definition: "Mean blood pressure from 24 to 72 hours minus mean blood pressure in the first 24 hours after time zero.",
    derivation: { schema_version: "1.0.0", operator: "difference", source_concept: "blood pressure", aggregation: "mean", baseline: window("baseline", 0, 24), follow_up: window("follow_up", 24, 72), direction: "follow_up_minus_baseline" } },
  time_windows: [window("exposure", 0, 24), window("baseline", 0, 24), window("follow_up", 24, 72)],
  covariates: ["Age", "Sex", "Charlson comorbidity index", "Emergency admission", "Vasopressors", "Invasive mechanical ventilation", "Creatinine", "Lactate", "Gender"].map(covariate),
  assumptions: [
    "The analysis unit is each patient's first hospital admission that meets the population definition; time zero is hospital admission.",
    "Outcomes are followed until the end of the index encounter because no horizon was stated.",
    "“降压疗效” is analysed as the change in 血压 from the first 24 hours to the end of follow-up.",
    "A sentence the templates do not know.",
  ],
};
const fixture = (): QuestionRunResult => ({
  schema_version: "1.0.0", run_id: "question-run:synthetic", question: "美托洛尔对降压的效果", created_at: "2026-01-01T00:00:00.000Z",
  versions: { study_spec_compiler: "1.0.0", method_registry: "1.0.0", model: "test" }, data_source: { id: "simulated", version: "test" },
  frame_set: { schema_version: "1.0.0", original_question: "美托洛尔对降压的效果", frames: [frame] },
  plans: [{
    plan_id: "f1", frame_id: "f1", status: "completed", stage_reached: "analysis", blockers: [], study_spec: spec,
    mapping: [{ role: "exposure", requested_term: "Metoprolol", status: "resolved", selected: { mapping_id: "m1", label: "Metoprolol labels", status: "model_reviewed", table: "mimiciv_hosp.prescriptions", identifiers: 1, values: ["Metoprolol"] }, candidates: [] }],
    chosen_method: "treatment.iptw",
    quality: { rules_version: "1", status: "pass", checks: [
      { check_id: "variables_vary", status: "pass", title: { en: "Variable variation", zh: "变量变异" }, observed: "6 variables", expected: "every variable takes at least two values", message: { en: "ok", zh: "好" } },
      { check_id: "severity_adjustment", status: "pass", title: { en: "Illness severity adjustment", zh: "病情严重度校正" }, observed: "Vasopressors, Creatinine", expected: "at least one severity measure (for example SOFA, vasopressors, ventilation, lactate)", message: { en: "ok", zh: "好" } },
    ] },
    result: { method_id: "treatment.iptw", method_library_version: "1.0.0", status: "completed", n_input: 10, n_analysed: 10, output_dir: "/out",
      estimates: [{ term: "exposure", label: "Metoprolol (IPTW)", measure: "odds_ratio", estimate: 0.7, ci_low: 0.5, ci_high: 0.9, p_value: 0.01 }],
      diagnostics: {}, warnings: ["3 of 10 rows with missing model variables were excluded (complete-case analysis)."],
      tables: { table1: [{ variable: "Charlson comorbidity index", overall: "1", exposed: "1", unexposed: "1", smd: 0 }] }, figures: [] },
  }],
  unanswered_frames: [], summary: { frames: 1, plans: 1, completed: 1, blocked: 0, failed: 0, needs_clarification: 0 }, model_audit: [],
} as unknown as QuestionRunResult);

const table = (language: "zh" | "en", caption?: string) => {
  const blocks = buildReportDocument(fixture(), language).blocks;
  return (blocks.find((block) => block.kind === "table" && block.columns[0] === (language === "zh" ? "要素" : "Element")) as { rows: string[][] }).rows;
};

test("renders the study-design cells fully in Chinese from structured fields and the user's words", () => {
  const rows = Object.fromEntries(table("zh").map(([element, definition]) => [element, definition]));
  assert.equal(rows["暴露"], "美托洛尔：时间零点后 0–24 小时内有任何美托洛尔记录");
  assert.equal(rows["结局"], "血压变化：时间零点后 24–72 小时的平均血压减去 0–24 小时的平均血压");
  assert.equal(rows["时间零点"], "入院（每位患者的首次住院）");
  assert.equal(rows["校正变量"], "年龄、性别、Charlson 合并症指数、急诊入院、血管活性药物、有创机械通气、肌酐、乳酸、性别");
});

test("keeps the English design cells exactly as the study spec words them", () => {
  const rows = Object.fromEntries(table("en").map(([element, definition]) => [element, definition]));
  assert.equal(rows["Exposure"], "Metoprolol: Any recorded Metoprolol within the first 24 hours after the index time.");
  assert.equal(rows["Outcome"], "blood pressure change: Mean blood pressure from 24 to 72 hours minus mean blood pressure in the first 24 hours after time zero.");
  assert.equal(rows["Time zero"], "hospital admission (first hospital admission per patient)");
  assert.equal(rows["Adjustment"], "Age, Sex, Charlson comorbidity index, Emergency admission, Vasopressors, Invasive mechanical ventilation, Creatinine, Lactate, Gender");
  const json = JSON.stringify(buildReportDocument(fixture(), "en").blocks);
  assert.match(json, /"Metoprolol \(IPTW\): Odds ratio 0\.700/u);
  assert.match(json, /3 of 10 rows with missing model variables were excluded \(complete-case analysis\)\./u);
  assert.match(json, /A sentence the templates do not know\./u);
});

test("translates known assumptions, keeps quoted Chinese, and leaves unknown sentences in English", () => {
  const zh = buildLabeler([frame as never]);
  assert.equal(assumptionText(spec.assumptions[0]!, zh), "分析单位为每位患者符合人群定义的首次住院；时间零点为入院。");
  assert.equal(assumptionText("The analysis unit is each patient's first hospital admission that meets the population definition; if it lacks the exposure or the outcome, the patient is excluded rather than analysed at a later admission; time zero is hospital admission.", zh),
    "分析单位为每位患者符合人群定义的首次住院；若该次缺少暴露或结局，则排除该患者，不以其后续住院替代；时间零点为入院。");
  assert.equal(assumptionText("The analysis unit is each patient's first eligible ICU stay: one that meets the population definition and, when follow-up starts after time zero (a landmark or a prediction time), is still in the ICU and without the outcome then; if it lacks the exposure or the outcome, the patient is excluded rather than analysed at a later ICU stay; time zero is ICU admission.", zh),
    "分析单位为每位患者首次符合条件的 ICU 入住：符合人群定义，且随访起点晚于时间零点（界标或预测时间点）时，在随访起点仍在 ICU、尚未发生结局；若该次缺少暴露或结局，则排除该患者，不以其后续 ICU 入住替代；时间零点为 ICU 入住。", "compiler 1.6.1: the first eligible unit, not the first one");
  assert.equal(assumptionText(spec.assumptions[1]!, zh), "未说明随访期限，因此结局随访至本次住院结束。");
  assert.equal(assumptionText(spec.assumptions[2]!, zh), "“降压疗效”按血压从最初 24 小时到随访结束的变化进行分析。");
  assert.equal(assumptionText("A sentence the templates do not know.", zh), "A sentence the templates do not know.");
  const list = JSON.stringify(buildReportDocument(fixture(), "zh").blocks);
  assert.match(list, /A sentence the templates do not know\./u);
  assert.doesNotMatch(list, /The analysis unit is/u);
});

test("shows the Chinese label with the English term in the mapping table and translates checks and estimates", () => {
  const json = JSON.stringify(buildReportDocument(fixture(), "zh").blocks);
  assert.match(json, /美托洛尔（Metoprolol）/u);
  assert.match(json, /6 个变量/u);
  assert.match(json, /每个变量至少有两个不同取值/u);
  assert.match(json, /血管活性药物、肌酐/u);
  assert.match(json, /10 行中有 3 行因模型变量缺失被排除/u);
  assert.match(json, /"Charlson 合并症指数","1"/u);
  const labeler = buildLabeler([frame as never]);
  assert.equal(estimateLabel("Metoprolol in Gender = F", labeler), "美托洛尔（性别 = F）");
  assert.equal(checkText("Creatinine: SD 2.1, IQR 0.7 to 1.3", labeler), "肌酐：SD 2.1，四分位距 0.7 至 1.3");
  assert.equal(checkText("something unexpected", labeler), "something unexpected");
});

test("localizeNames swaps known English variable names for Chinese labels and leaves unknown names and longer words alone", async () => {
  const { localizeNames } = await import("../chinese-rendering.js");
  const zh = (name: string): string | undefined => ({ Age: "年龄", "Pain Score change": "疼痛评分变化" } as Record<string, string>)[name];
  assert.equal(localizeNames("校正变量：Age、Sex；结局 Pain Score change；Agenda", ["Age", "Sex", "Pain Score change"], zh), "校正变量：年龄、Sex；结局 疼痛评分变化；Agenda");
});

test("a component replaced by a different measurable concept does not lend it its Chinese name", async () => {
  const { buildLabeler } = await import("../chinese-rendering.js");
  const frames = [{ frame_id: "f1", outcome: { text: "主要心血管事件", verbatim: true, normalized: { label_en: "Major Cardiovascular Events", category: "outcome" }, components: ["因心血管死亡"],
    components_resolved: [{ text: "因心血管死亡", concept_en: "All-cause death" }] }, modifiers: [], mediators: [], predictors: [] }] as unknown as Parameters<typeof buildLabeler>[0];
  assert.notEqual(buildLabeler(frames)("All-cause death"), "因心血管死亡");
});

test("a baseline covariate is labelled from its measure's Chinese name", async () => {
  const { buildLabeler } = await import("../chinese-rendering.js");
  const frames = [{ frame_id: "f1", outcome: { text: "疼痛评分", verbatim: true, normalized: { label_en: "Pain Score", category: "outcome" } }, modifiers: [], mediators: [], predictors: [] }] as unknown as Parameters<typeof buildLabeler>[0];
  assert.equal(buildLabeler(frames)("Baseline Pain Score"), "基线疼痛评分");
});

test("the Chinese report states a prediction's prediction time and where its outcome is counted", () => {
  const zh = buildLabeler([frame as never]);
  assert.equal(assumptionText("Predictions are made at 6 hours after time zero, when the predictor window ends (a landmark): units discharged or dead before then, or with the outcome recorded between time zero and then, are excluded, and the outcome is counted from 6 hours to 48 hour(s) after time zero.", zh),
    "预测时间点为时间零点后 6 小时，即预测因子窗口结束时（界标）：此前已出院或死亡、或在时间零点至该时间点之间已记录结局的患者不纳入；结局自时间零点后 6 小时起计算，至时间零点后 48 小时。");
  assert.equal(assumptionText("Predictions are made at 24 hours after time zero, when the predictor window ends (a landmark): units discharged or dead before then, or with the outcome recorded between time zero and then, are excluded, and the outcome is counted from 24 hours after time zero to the end of the index encounter.", zh),
    "预测时间点为时间零点后 24 小时，即预测因子窗口结束时（界标）：此前已出院或死亡、或在时间零点至该时间点之间已记录结局的患者不纳入；结局自时间零点后 24 小时起计算，至本次住院结束。");
  assert.equal(assumptionText("Predictions are made at 24 hours after time zero, when the predictor window ends (a landmark): units discharged or dead before then, or with the outcome already recorded then (after time zero, or earlier in the same admission), are excluded, and the outcome is counted from 24 hours to 168 hour(s) after time zero.", zh),
    "预测时间点为时间零点后 24 小时，即预测因子窗口结束时（界标）：此前已出院或死亡、或此前已记录结局（时间零点后，或同次住院更早时）的患者不纳入；结局自时间零点后 24 小时起计算，至时间零点后 168 小时。", "the wording of compiler 1.6.1");
  assert.equal(assumptionText("Predictions are made at 24 hours after time zero, when the predictor window ends (a landmark): units whose ICU stay ended (transfer out of the ICU, discharge or death) before then, or with the outcome already recorded then (after time zero, or earlier in the same admission), are excluded, and the outcome is counted from 24 hours to 168 hour(s) after time zero.", zh),
    "预测时间点为时间零点后 24 小时，即预测因子窗口结束时（界标）：此前 ICU 入住已结束（转出 ICU、出院或死亡）、或此前已记录结局（时间零点后，或同次住院更早时）的患者不纳入；结局自时间零点后 24 小时起计算，至时间零点后 168 小时。", "an ICU prediction");
  assert.equal(assumptionText("The stated horizon of 24 hour(s) ends inside the predictor window, so it is counted from the prediction time.", zh), "所述 24 小时时限在预测因子窗口内结束，因此从预测时间点起计算。");
});

test("a description's estimate labels, group columns and default sentence read in Chinese", () => {
  const zh = (name: string) => ({ "in-hospital mortality": "住院死亡率", "administrative sex": "性别", "beta blockers": "β受体阻滞剂" } as Record<string, string>)[name.toLowerCase()];
  assert.equal(estimateLabel("In-hospital mortality (overall)", zh), "住院死亡率（总体）");
  assert.equal(estimateLabel("In-hospital mortality in Beta blockers = yes", zh), "住院死亡率（β受体阻滞剂 = 是）");
  assert.equal(estimateLabel("Administrative sex: F (overall)", zh), "性别：F（总体）");
  assert.equal(estimateLabel("Administrative sex = M", zh), "性别 = M");
  // Labels of other designs are unchanged.
  assert.equal(estimateLabel("Beta blockers (IPTW)", zh), "β受体阻滞剂（IPTW）");
  assert.equal(estimateLabel("Beta blockers in Administrative sex = F", zh), "β受体阻滞剂（性别 = F）");
  assert.match(assumptionText("A description reports the number of patients, Table 1 and each characteristic's proportion or mean with its 95% confidence interval, in the whole cohort and in each group; nothing is adjusted, so a difference between groups is not an effect. Each characteristic is described among the patients in whom it is recorded (compiler 1.6.0).", zh), /^描述性研究报告患者人数.*编译器 1\.6\.0/u);
  assert.equal(checkText("Lactate: 40% recorded", (name) => (name === "Lactate" ? "乳酸" : undefined)), "乳酸：40% 有记录");
});
