import assert from "node:assert/strict";
import test from "node:test";
import type { StudySpec } from "../../research-design/index.js";
import { buildStudyProtocol } from "../index.js";

const spec = (overrides: Partial<StudySpec> = {}): StudySpec => ({
  schema_version: "1.0.0", intent_family: "treatment_effect",
  population: { description: "高血压患者" }, index_time: { event: "hospital admission", selection_rule: "first hospital admission per patient" },
  exposure_or_predictors: [{ name: "Metoprolol", role: "exposure", operational_definition: "Any recorded Metoprolol within the first 24 hours after the index time." }],
  outcome: { name: "All-cause death", role: "outcome", operational_definition: "Any death during follow-up." }, outcome_structure: "binary",
  covariates: [{ name: "Age", role: "covariate", operational_definition: "Age." }],
  time_windows: [
    { purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" },
    { purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" },
  ],
  ...overrides,
});
const check = (protocol: ReturnType<typeof buildStudyProtocol>, id: string) => protocol.design_checks.find(({ check_id }) => check_id === id)?.status;

test("lays out the target trial and flags outcomes counted before the exposure window closes", () => {
  const protocol = buildStudyProtocol({ study_spec: spec(), comparator: { kind: "absence", text: "不用美托洛尔" } });
  assert.equal(protocol.elements.find(({ key }) => key === "comparator")?.emulation, "不用美托洛尔");
  assert.match(protocol.elements.find(({ key }) => key === "follow_up")!.emulation, /end of the index encounter/u);
  assert.equal(check(protocol, "outcome_after_exposure"), "warn");
  assert.equal(check(protocol, "comparator"), "warn");
  const landmark = buildStudyProtocol({ study_spec: spec({ time_windows: [{ purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }, { purpose: "outcome", anchor: "index_time", start_offset: 1, end_offset: 28, unit: "day" }] }) });
  assert.equal(check(landmark, "outcome_after_exposure"), "pass");
});

test("names the other listed classes as an active comparator and checks baseline timing of a change outcome", () => {
  const active = buildStudyProtocol({ study_spec: spec(), active_comparator_levels: ["ARB", "利尿剂"], exposure_level: "ACEI" });
  assert.match(active.elements.find(({ key }) => key === "comparator")!.emulation, /ARB, 利尿剂 but not ACEI \(active comparator\)/u);
  assert.equal(check(active, "comparator"), "pass");
  const change = buildStudyProtocol({ study_spec: spec({ outcome_structure: "continuous", outcome: { name: "SBP change", role: "outcome", operational_definition: "Mean 24–72 h minus mean 0–24 h.", derivation: { schema_version: "1.0.0", operator: "difference", source_concept: "Systolic blood pressure", aggregation: "mean", baseline: { purpose: "baseline", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }, follow_up: { purpose: "follow_up", anchor: "index_time", start_offset: 24, end_offset: 72, unit: "hour" }, direction: "follow_up_minus_baseline" } },
    time_windows: [{ purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }, { purpose: "baseline", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }, { purpose: "follow_up", anchor: "index_time", start_offset: 24, end_offset: 72, unit: "hour" }] }) });
  assert.equal(check(change, "baseline_before_exposure"), "warn");
  assert.equal(check(change, "outcome_after_exposure"), undefined);
});

test("writes each element in Chinese as well, including the landmark and switched-off variables", () => {
  const protocol = buildStudyProtocol({ study_spec: { ...spec(), exposure_or_predictors: [{ name: "Metoprolol", role: "exposure", operational_definition: "Any recorded Metoprolol within the first 24 hours after the index time.", contrast: { kind: "binary_presence" }, aggregation: "any" }],
    covariates: [{ name: "Age", role: "covariate", operational_definition: "Age." }, { name: "Lactate", role: "covariate", operational_definition: "Lactate." }] },
    comparator: { kind: "absence" }, landmark_hours: 24, excluded_covariates: ["Lactate"], analysis_label: "IPTW", analysis_label_zh: "逆概率加权" });
  const zh = Object.fromEntries(protocol.elements.map(({ key, emulation_zh }) => [key, emulation_zh]));
  assert.equal(zh.treatment, "Metoprolol：时间零点后 24 小时内有 Metoprolol 记录");
  assert.equal(zh.comparator, "暴露窗内未使用 Metoprolol 者");
  assert.match(zh.eligibility!, /时间零点后 24 小时仍在院/u);
  assert.match(zh.follow_up!, /24 小时起计算结局（界标）/u);
  assert.equal(zh.confounders, "Age");
  assert.equal(zh.outcome, "All-cause death（是否发生）");
  assert.equal(zh.analysis, "逆概率加权");
  assert.equal(zh.time_zero, "入院");
});

test("a prediction states its prediction time; a treatment whose outcome window overlaps its exposure window is still flagged", () => {
  const windows: StudySpec["time_windows"] = [
    { purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 6, unit: "hour" },
    { purpose: "baseline", anchor: "index_time", start_offset: 0, end_offset: 6, unit: "hour" },
    { purpose: "outcome", anchor: "index_time", start_offset: 6, end_offset: 48, unit: "hour" },
  ];
  const prediction = buildStudyProtocol({ study_spec: spec({ intent_family: "prediction", exposure_or_predictors: [{ name: "Heart rate", role: "predictor", operational_definition: "Heart rate." }],
    outcome: { name: "Invasive mechanical ventilation", role: "outcome", operational_definition: "Any invasive mechanical ventilation during follow-up.", contrast: { kind: "binary_presence" } }, time_windows: windows }) });
  assert.equal(check(prediction, "outcome_after_prediction_time"), "pass");
  assert.match(prediction.design_checks.find(({ check_id }) => check_id === "outcome_after_prediction_time")!.message.en, /^Predictions are made at 6 hours after time zero, when the predictor window \(0–6 hour\(s\) after time zero\) ends\./u);
  const element = (key: string) => prediction.elements.find((item) => item.key === key)!;
  assert.match(element("eligibility").emulation, /still in hospital and without the outcome 6 hours after time zero \(prediction time\)/u);
  assert.match(element("follow_up").emulation, /outcome counted from 6 hours after time zero \(prediction time\); 6–48 hour\(s\) after time zero/u);
  assert.match(element("eligibility").emulation_zh!, /时间零点后 6 小时（预测时间点）仍在院且尚未发生结局/u);
  assert.equal(check(prediction, "outcome_after_exposure"), undefined, "a prediction has no exposure");
  // The same windows for a treatment, with the outcome counted from time zero: the overlap is a warning.
  const treatment = buildStudyProtocol({ study_spec: spec({ outcome: { name: "Invasive mechanical ventilation", role: "outcome", operational_definition: "Any.", contrast: { kind: "binary_presence" } },
    time_windows: [windows[0]!, { purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 48, unit: "hour" }] }) });
  assert.equal(check(treatment, "outcome_after_exposure"), "warn");
  assert.equal(check(treatment, "outcome_after_prediction_time"), undefined);
});

// Compendium of 2026-11-04: an ICU question's eligibility said "still in hospital" (it is the ICU stay that must last to the
// landmark), and a treatment read over 6 hours was described as read over the first 24.
test("an ICU question is eligible while still in the ICU and without the outcome at the landmark; a moved exposure window is stated", () => {
  const protocol = buildStudyProtocol({ study_spec: spec({ index_time: { event: "ICU admission", selection_rule: "first ICU stay per patient" },
    exposure_or_predictors: [{ name: "Metoprolol", role: "exposure", operational_definition: "Any recorded Metoprolol within the first 24 hours after the index time.", contrast: { kind: "binary_presence" }, aggregation: "any" }],
    outcome: { name: "In-hospital death", role: "outcome", operational_definition: "Any death.", contrast: { kind: "binary_presence" } },
    time_windows: [{ purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 6, unit: "hour" }, { purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }] }),
    comparator: { kind: "absence" }, landmark_hours: 6 });
  const element = (key: string) => protocol.elements.find((candidate) => candidate.key === key)!;
  assert.match(element("eligibility").emulation, /still in the ICU and without the outcome 6 hours after time zero/u);
  assert.match(element("eligibility").emulation_zh!, /时间零点后 6 小时仍在 ICU且尚未发生结局/u);
  assert.equal(element("treatment").emulation, "Metoprolol: Any recorded Metoprolol within the first 6 hours after the index time.");
  assert.equal(element("treatment").emulation_zh, "Metoprolol：时间零点后 6 小时内有 Metoprolol 记录");
});

// Review of 43ab060: a moved window was restated only in the treatment row; the outcome of a change, a description's grouping
// and reading times, a dose question's population and an ICU prediction's exclusions still said 24 hours or "discharged or dead".
test("every protocol row states the windows the plan runs with, and an ICU prediction excludes stays that ended", () => {
  const sixHours = [{ purpose: "exposure" as const, anchor: "index_time" as const, start_offset: 0, end_offset: 6, unit: "hour" as const }, { purpose: "baseline" as const, anchor: "index_time" as const, start_offset: 0, end_offset: 6, unit: "hour" as const }];
  const change = buildStudyProtocol({ study_spec: spec({ population: { description: "Septic shock who received Norepinephrine in the first 24 hours" }, outcome_structure: "continuous",
    outcome: { name: "MAP change", role: "outcome", operational_definition: "Mean MAP from 24 to 72 hours minus mean MAP in the first 24 hours after time zero.", derivation: { schema_version: "1.0.0", operator: "difference", source_concept: "MAP", aggregation: "mean", baseline: { purpose: "baseline", anchor: "index_time", start_offset: 0, end_offset: 6, unit: "hour" }, follow_up: { purpose: "follow_up", anchor: "index_time", start_offset: 6, end_offset: 72, unit: "hour" }, direction: "follow_up_minus_baseline" } },
    time_windows: [...sixHours, { purpose: "follow_up", anchor: "index_time", start_offset: 6, end_offset: 72, unit: "hour" }] }), comparator: { kind: "absence" } });
  const row = (protocol: ReturnType<typeof buildStudyProtocol>, key: string) => protocol.elements.find((element) => element.key === key)!;
  assert.equal(row(change, "outcome").emulation, "MAP change: Mean MAP from 6 to 72 hours minus mean MAP in the first 6 hours after time zero.");
  assert.match(row(change, "eligibility").emulation, /^Septic shock who received Norepinephrine in the first 6 hours;/u);
  const description = buildStudyProtocol({ description: true, study_spec: spec({ intent_family: "descriptive" as never, time_windows: sixHours,
    exposure_or_predictors: [{ name: "Vasopressors", role: "exposure", operational_definition: "Any recorded Vasopressors within the first 24 hours after the index time.", contrast: { kind: "binary_presence" } }] }) });
  assert.equal(row(description, "treatment").emulation, "Vasopressors: Any recorded Vasopressors within the first 6 hours after the index time.");
  assert.equal(row(description, "treatment").emulation_zh, "Vasopressors：时间零点后 6 小时内有 Vasopressors 记录（是/否）");
  assert.equal(row(description, "follow_up").emulation, "baseline characteristics 0–6 hour(s) after time zero");
  assert.equal(row(description, "follow_up").emulation_zh, "基线特征：时间零点后 0–6 小时内");
  const prediction = buildStudyProtocol({ study_spec: spec({ intent_family: "prediction", index_time: { event: "ICU admission", selection_rule: "first ICU stay per patient" }, exposure_or_predictors: [{ name: "Heart rate", role: "predictor", operational_definition: "Heart rate." }],
    outcome: { name: "AKI", role: "outcome", operational_definition: "Any.", contrast: { kind: "binary_presence" } }, time_windows: [...sixHours, { purpose: "outcome", anchor: "index_time", start_offset: 6, end_offset: 48, unit: "hour" }] }) });
  const message = prediction.design_checks.find(({ check_id }) => check_id === "outcome_after_prediction_time")!.message;
  assert.match(message.en, /ICU stays that ended before then \(transfer out of the ICU, discharge or death\)/u);
  assert.match(message.zh, /此前 ICU 入住已结束（转出 ICU、出院或死亡）/u);
});

test("the protocol adjusts for a second change mediator, as the model does, and leaves out only the analysed one", () => {
  const change = (name: string) => ({ name, role: "covariate" as const, operational_definition: `Mean ${name} from 24 to 72 hours minus mean in the first 24 hours after time zero.`,
    derivation: { schema_version: "1.0.0" as const, operator: "difference" as const, source_concept: name, aggregation: "mean" as const, baseline: { purpose: "baseline" as const, anchor: "index_time" as const, start_offset: 0, end_offset: 24, unit: "hour" as const }, follow_up: { purpose: "follow_up" as const, anchor: "index_time" as const, start_offset: 24, end_offset: 72, unit: "hour" as const }, direction: "follow_up_minus_baseline" as const } });
  const protocol = buildStudyProtocol({ study_spec: spec({ covariates: [{ name: "Age", role: "covariate", operational_definition: "Age." }, change("Blood pressure change"), change("Heart rate change")] }), comparator: { kind: "absence" }, excluded_covariates: ["Blood pressure change"] });
  const confounders = protocol.elements.find(({ key }) => key === "confounders")!;
  assert.equal(confounders.emulation, "Age, Heart rate change");
  assert.equal(confounders.emulation_zh, "Age、Heart rate change");
});
