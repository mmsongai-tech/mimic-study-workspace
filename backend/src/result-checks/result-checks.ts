import { readFile } from "node:fs/promises";

/**
 * Automatic quality checks on one analysis result. Each check states what was measured, the threshold it was held
 * to and what a failure means, so a report shows why a number can or cannot be trusted instead of only the number.
 * Checks never change an estimate; a failed check marks the result as not reliable.
 */

export type CheckStatus = "pass" | "warn" | "fail";
export interface LocalizedText { en: string; zh: string }
export interface ResultCheck {
  check_id: string;
  status: CheckStatus;
  title: LocalizedText;
  /** What was observed, already formatted (counts below 10 are shown as "<10"). */
  observed: string;
  /** The rule the observation was held to. */
  expected: string;
  message: LocalizedText;
}
export interface ResultQuality { rules_version: string; status: CheckStatus; checks: ResultCheck[] }

export interface ResultCheckRules {
  schema_version: "1.0.0";
  rules_version: string;
  thresholds: {
    min_group_size: number; min_events: number; min_events_per_parameter: number;
    exposure_share_low: number; exposure_share_high: number;
    smd_warn: number; smd_fail: number; effective_sample_share_warn: number;
    ratio_effect_warn_low: number; ratio_effect_warn_high: number;
    complete_case_loss_warn: number; heavy_tail_ratio_warn: number; proportional_hazards_p_warn: number;
  };
  severity_covariate_pattern: string;
  reference_rates: Array<{ mapping_ids: string[]; label: LocalizedText; hospital_admission: { min: number; max: number }; icu_admission: { min: number; max: number } }>;
}

export class FileResultCheckRulesRepository {
  constructor(private readonly file: URL) {}
  async load(): Promise<ResultCheckRules> {
    const parsed = JSON.parse(await readFile(this.file, "utf8")) as ResultCheckRules;
    if (parsed.schema_version !== "1.0.0" || !parsed.thresholds || !Array.isArray(parsed.reference_rates)) throw new Error("The result-check rules have an unsupported format.");
    return parsed;
  }
}

/** Aggregate description of one analysis column; no patient-level values. */
export interface ColumnProfile {
  column: string;
  role: string;
  label: string;
  mapping_id?: string;
  kind: "binary" | "numeric" | "categorical";
  n: number;
  missing: number;
  distinct: number;
  n_true?: number;
  /** Summary statistics only; minimum and maximum are single patients' values and are not kept. */
  mean?: number; sd?: number; q1?: number; median?: number; q3?: number;
}

const isTrue = (value: unknown): boolean => value === true || value === 1 || value === "1" || value === "true";
const isBinaryValue = (value: unknown): boolean => typeof value === "boolean" || ["0", "1", "true", "false"].includes(String(value));
const quantile = (sorted: number[], p: number): number => {
  const position = (sorted.length - 1) * p; const low = Math.floor(position); const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
};

/** Profiles each analysis column (and follow-up time/event when present) from the analysis rows. */
export const profileAnalysisColumns = (rows: Array<Record<string, unknown>>, columns: Array<{ column: string; role: string; requested_label: string; mapping_id?: string }>): ColumnProfile[] => {
  const all: Array<{ column: string; role: string; requested_label: string; mapping_id?: string }> = [...columns, ...(["time", "event"] as const).filter((name) => !columns.some(({ column }) => column === name) && rows.some((row) => row[name] !== undefined)).map((name) => ({ column: name, role: "outcome", requested_label: name === "time" ? "Follow-up time" : "Event" }))];
  return all.map(({ column, role, requested_label, mapping_id }) => {
    const values = rows.map((row) => row[column]).filter((value) => value !== undefined && value !== null && value !== "");
    const distinct = new Set(values.map(String));
    const base = { column, role, label: requested_label, ...(mapping_id ? { mapping_id } : {}), n: values.length, missing: rows.length - values.length, distinct: distinct.size };
    if (values.length && values.every(isBinaryValue)) return { ...base, kind: "binary" as const, n_true: values.filter(isTrue).length };
    const numbers = values.map(Number);
    if (values.length && numbers.every(Number.isFinite)) {
      const sorted = [...numbers].sort((a, b) => a - b);
      const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
      const sd = numbers.length > 1 ? Math.sqrt(numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (numbers.length - 1)) : 0;
      return { ...base, kind: "numeric" as const, mean, sd, q1: quantile(sorted, 0.25), median: quantile(sorted, 0.5), q3: quantile(sorted, 0.75) };
    }
    return { ...base, kind: "categorical" as const };
  });
};

export interface PlanCheckInput {
  intent: "treatment_effect" | "association" | "prediction" | "undetermined";
  outcome_structure?: string;
  /** "ICU admission" or "hospital admission". */
  index_event?: string;
  /** True when the outcome is followed to the end of the index encounter (no stated horizon). */
  outcome_to_encounter_end: boolean;
  covariate_names: string[];
  mapping: Array<{ role: string; characteristic?: boolean; requested_term: string; status: string; selected?: { mapping_id: string; table: string; values: string[] } }>;
  /**
   * A description: no outcome is modelled and no group is compared, so a small group or a constant value is reported, never a
   * failed estimate; each characteristic's recording is checked instead (profile role "characteristic").
   */
  description?: boolean;
  profile: ColumnProfile[];
  /** First eligible units (one per patient) and how many of them lacked the exposure or outcome, so were not analysed. */
  selection?: { first_eligible_units: number; missing_exposure_or_outcome: number };
  result?: { n_input: number; n_analysed: number; estimates: Array<{ measure: string; estimate: number | null; ci_low: number | null; ci_high: number | null; label: string }>; diagnostics: Record<string, unknown> };
}

const count = (value: number): string => value > 0 && value < 10 ? "<10" : value.toLocaleString("en-US");
const percent = (value: number): string => `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
const fixed = (value: number, digits = 2): string => Number(value).toFixed(digits);
const RATIO_MEASURES = new Set(["odds_ratio", "hazard_ratio", "risk_ratio", "rate_ratio"]);

export const checkPlanResult = (input: PlanCheckInput, rules: ResultCheckRules): ResultQuality => {
  const t = rules.thresholds;
  const checks: ResultCheck[] = [];
  const add = (check: ResultCheck) => checks.push(check);
  const byRole = (role: string) => input.profile.filter((column) => column.role === role);
  const exposure = byRole("exposure")[0];
  const outcome = input.profile.find(({ column }) => column === "event") ?? byRole("outcome").find(({ column }) => column !== "time");

  // Every modelled variable must vary; a constant column means a broken definition or window.
  const constant = input.profile.filter((column) => column.n > 0 && column.distinct <= 1);
  add(constant.length
    ? { check_id: "variables_vary", status: !input.description && constant.some(({ role }) => role === "exposure" || role === "outcome") ? "fail" : "warn", title: { en: "Variable variation", zh: "变量变异" }, observed: constant.map(({ label }) => label).join(", "), expected: "every variable takes at least two values",
      message: { en: `${constant.map(({ label }) => label).join(", ")} has the same value for every patient, which usually means a wrong definition or time window.`, zh: `${constant.map(({ label }) => label).join("、")}在所有患者中取值相同，通常提示定义或时间窗有误。` } }
    : { check_id: "variables_vary", status: "pass", title: { en: "Variable variation", zh: "变量变异" }, observed: `${input.profile.length} variables`, expected: "every variable takes at least two values", message: { en: "Every analysis variable takes more than one value.", zh: "所有分析变量均有不止一个取值。" } });

  // A description's groups are described, not compared: a small group only has a wide interval, and a rare grouping (few patients
  // received the drug) is itself the answer, so neither fails the result.
  if (input.description && exposure?.kind === "binary" && exposure.n > 0) {
    const exposed = exposure.n_true ?? 0; const unexposed = exposure.n - exposed; const small = Math.min(exposed, unexposed) < t.min_group_size;
    add({ check_id: "group_sizes", status: small ? "warn" : "pass", title: { en: "Group sizes", zh: "组别规模" }, observed: `${count(exposed)} exposed / ${count(unexposed)} unexposed (${percent(exposed / exposure.n)} exposed)`, expected: `each group ≥ ${t.min_group_size} for a usable description`,
      message: small ? { en: "One group is small, so its proportions and means have wide intervals.", zh: "有一组人数较少，其比例和均值的置信区间较宽。" } : { en: "Both groups are large enough to describe.", zh: "两组人数均足以描述。" } });
  }
  // Group sizes and positivity for a binary exposure.
  if (!input.description && exposure?.kind === "binary" && exposure.n > 0) {
    const exposed = exposure.n_true ?? 0; const unexposed = exposure.n - exposed; const share = exposed / exposure.n;
    const small = Math.min(exposed, unexposed) < t.min_group_size; const skewed = share < t.exposure_share_low || share > t.exposure_share_high;
    add({ check_id: "group_sizes", status: small ? "fail" : skewed ? "warn" : "pass", title: { en: "Group sizes", zh: "组别规模" }, observed: `${count(exposed)} exposed / ${count(unexposed)} unexposed (${percent(share)} exposed)`, expected: `each group ≥ ${t.min_group_size}; exposed share ${percent(t.exposure_share_low)}–${percent(t.exposure_share_high)}`,
      message: small ? { en: "One comparison group is too small for a stable estimate.", zh: "有一个比较组人数过少，估计不稳定。" }
        : skewed ? { en: "The exposure is very rare or very common, so the groups overlap poorly and estimates depend on few patients.", zh: "暴露极少见或极常见，组间重叠差，估计依赖少数患者。" }
        : { en: "Both comparison groups are large enough.", zh: "两个比较组规模足够。" } });
  }

  // Events for binary and time-to-event outcomes.
  if (outcome?.kind === "binary" && outcome.n > 0) {
    const events = outcome.n_true ?? 0; const rate = events / outcome.n;
    const epv = Number(input.result?.diagnostics.events_per_parameter);
    const few = Math.min(events, outcome.n - events) < t.min_events; const lowEpv = Number.isFinite(epv) && epv < t.min_events_per_parameter;
    add({ check_id: "outcome_events", status: few ? "fail" : lowEpv ? "warn" : "pass", title: { en: "Outcome events", zh: "结局事件数" }, observed: `${count(events)} of ${count(outcome.n)} (${percent(rate)})${Number.isFinite(epv) ? `; ${fixed(epv, 1)} events per parameter` : ""}`, expected: `≥ ${t.min_events} events; ≥ ${t.min_events_per_parameter} events per parameter`,
      message: few ? { en: "Too few outcome events for a reliable model.", zh: "结局事件过少，模型不可靠。" } : lowEpv ? { en: "Few events for the number of model terms; estimates may be unstable.", zh: "相对模型参数数量事件偏少，估计可能不稳定。" } : { en: "Enough outcome events for the model.", zh: "结局事件数量足够。" } });
    // Plausibility of the event rate for outcomes with a known range.
    const outcomeMapping = input.mapping.find(({ role, characteristic }) => role === "outcome" && !characteristic)?.selected?.mapping_id;
    const reference = input.outcome_to_encounter_end && outcomeMapping ? rules.reference_rates.find(({ mapping_ids }) => mapping_ids.includes(outcomeMapping)) : undefined;
    if (reference) {
      const range = /icu/iu.test(input.index_event ?? "") ? reference.icu_admission : reference.hospital_admission;
      const inside = rate >= range.min && rate <= range.max;
      add({ check_id: "outcome_rate_plausible", status: inside ? "pass" : "warn", title: { en: "Outcome rate", zh: "结局发生率" }, observed: percent(rate), expected: `${percent(range.min)}–${percent(range.max)} for ${reference.label.en} in MIMIC-IV`,
        message: inside ? { en: `The rate of ${reference.label.en} is within the usual MIMIC-IV range.`, zh: `${reference.label.zh}发生率在 MIMIC-IV 常见范围内。` }
          : { en: `The rate of ${reference.label.en} is outside the usual MIMIC-IV range; check the outcome window and definition (a high-risk population can explain it).`, zh: `${reference.label.zh}发生率超出 MIMIC-IV 常见范围；请核对结局时间窗与定义（高危人群也可能导致）。` } });
    }
  }

  // Extreme values in continuous variables (charting artifacts inflate the SD far beyond the spread of the middle half).
  const tailed = input.profile.filter((column) => column.kind === "numeric" && column.column !== "time" && column.sd !== undefined && column.q1 !== undefined && column.q3 !== undefined && column.q3 > column.q1 && column.sd! / ((column.q3! - column.q1!) / 1.349) > t.heavy_tail_ratio_warn);
  if (input.profile.some(({ kind, column }) => kind === "numeric" && column !== "time")) {
    add({ check_id: "extreme_values", status: tailed.length ? "warn" : "pass", title: { en: "Extreme values", zh: "极端值" }, observed: tailed.length ? tailed.map((column) => `${column.label}: SD ${fixed(column.sd!, 1)}, IQR ${fixed(column.q1!, 1)} to ${fixed(column.q3!, 1)}`).join("; ") : "none", expected: `SD ≤ ${t.heavy_tail_ratio_warn}× the SD implied by the IQR`,
      message: tailed.length ? { en: "Some values lie far outside the typical range (possible recording artifacts); estimates on these variables may be distorted.", zh: "部分数值远离常见范围（可能为记录误差），相关估计可能失真。" } : { en: "No continuous variable has extreme outlying values.", zh: "连续变量无明显极端值。" } });
  }

  // Complete-case loss inside the model.
  // A missing exposure or outcome excludes the patient's first eligible unit; when many are excluded, the analysed patients
  // are those whose exposure and outcome happen to be recorded (for example blood pressure charted only in the ICU).
  if (input.selection && input.selection.first_eligible_units > 0) {
    const { first_eligible_units: units, missing_exposure_or_outcome: missing } = input.selection; const share = missing / units;
    // A prediction has no exposure: its first eligible unit is not analysed when no predictor was measured in the window.
    const predicting = input.intent === "prediction";
    add({ check_id: "outcome_recorded", status: share > t.complete_case_loss_warn ? "warn" : "pass", title: predicting ? { en: "Predictors and outcome recorded", zh: "预测因子与结局有记录" } : { en: "Exposure and outcome recorded", zh: "暴露与结局有记录" }, observed: `${count(missing)} of ${count(units)} first eligible units lack them (${percent(share)})`, expected: `at most ${percent(t.complete_case_loss_warn)}`,
      message: share > t.complete_case_loss_warn
        ? predicting ? { en: "Many patients' first eligible admission has no predictor measured in the window or no recorded outcome; the model describes patients in whom they were recorded, who may differ from the population.", zh: "较多患者首次符合条件的住院在时间窗内没有测到任何预测因子或没有结局记录；模型只代表有记录的患者，可能与目标人群不同。" }
          : { en: "Many patients' first eligible admission has no recorded exposure or outcome; the result describes patients in whom they were recorded, who may differ from the population.", zh: "较多患者首次符合条件的住院没有暴露或结局记录；结果只代表有记录的患者，可能与目标人群不同。" }
        : predicting ? { en: "Predictors and outcome are recorded for most first eligible units.", zh: "大多数首次符合条件的单位有预测因子与结局记录。" } : { en: "Exposure and outcome are recorded for most first eligible units.", zh: "大多数首次符合条件的单位有暴露与结局记录。" } });
  }
  if (input.result && input.result.n_input > 0) {
    const loss = 1 - input.result.n_analysed / input.result.n_input;
    add({ check_id: "missing_data", status: loss > t.complete_case_loss_warn ? "warn" : "pass", title: { en: "Missing data", zh: "缺失数据" }, observed: `${count(input.result.n_input - input.result.n_analysed)} of ${count(input.result.n_input)} excluded (${percent(loss)})`, expected: `≤ ${percent(t.complete_case_loss_warn)} excluded for missing values`,
      message: loss > t.complete_case_loss_warn ? { en: "Many patients lack a model variable; the analysed patients may differ from the population.", zh: "较多患者缺少模型变量，纳入分析者可能与目标人群不同。" } : { en: "Few patients were excluded for missing values.", zh: "因缺失被排除的患者较少。" } });
  }

  // Balance and weight stability after adjustment.
  const smd = Number(input.result?.diagnostics.max_smd_after);
  if (Number.isFinite(smd)) {
    add({ check_id: "covariate_balance", status: smd > t.smd_fail ? "fail" : smd > t.smd_warn ? "warn" : "pass", title: { en: "Covariate balance", zh: "协变量平衡" }, observed: `max SMD ${fixed(smd, 3)}`, expected: `max SMD ≤ ${t.smd_warn}`,
      message: smd > t.smd_warn ? { en: "The groups still differ on adjustment variables after weighting or matching, so the comparison is not like-for-like.", zh: "加权或匹配后组间仍有差异，比较并非同质。" } : { en: "The groups are balanced on every adjustment variable.", zh: "各校正变量在组间均衡。" } });
  }
  const ess = Number(input.result?.diagnostics.effective_sample_size);
  if (Number.isFinite(ess) && input.result?.n_analysed) {
    const share = ess / input.result.n_analysed;
    add({ check_id: "weight_stability", status: share < t.effective_sample_share_warn ? "warn" : "pass", title: { en: "Weight stability", zh: "权重稳定性" }, observed: `effective sample ${count(Math.round(ess))} of ${count(input.result.n_analysed)} (${percent(share)})`, expected: `≥ ${percent(t.effective_sample_share_warn)} of patients`,
      message: share < t.effective_sample_share_warn ? { en: "A few patients carry large weights, so the estimate rests on them.", zh: "少数患者权重过大，估计依赖于他们。" } : { en: "Weights are stable.", zh: "权重稳定。" } });
  }
  const ph = Number(input.result?.diagnostics.ph_test_global_p);
  if (Number.isFinite(ph)) {
    add({ check_id: "proportional_hazards", status: ph < t.proportional_hazards_p_warn ? "warn" : "pass", title: { en: "Proportional hazards", zh: "比例风险假设" }, observed: `global P ${fixed(ph, 3)}`, expected: `P ≥ ${t.proportional_hazards_p_warn}`,
      message: ph < t.proportional_hazards_p_warn ? { en: "The effect may change over follow-up; one hazard ratio summarizes it poorly.", zh: "效应可能随随访时间变化，单一风险比概括不足。" } : { en: "No evidence against proportional hazards.", zh: "未见违反比例风险假设的证据。" } });
  }

  if (input.intent === "treatment_effect") {
    // Treatment effects this large are rare in trials; in routine data they usually signal confounding.
    const main = input.result?.estimates.find(({ measure, estimate }) => RATIO_MEASURES.has(measure) && estimate !== null && estimate >= 0);
    if (main) {
      const large = main.estimate! < t.ratio_effect_warn_low || main.estimate! > t.ratio_effect_warn_high;
      // A ratio of about zero or infinity with an empty interval is a model that failed on few patients, not an estimate.
      const degenerate = main.estimate! < 0.01 || main.estimate! > 100 || !(main.ci_high! > main.ci_low!);
      add({ check_id: "effect_size_plausible", status: degenerate ? "fail" : large ? "warn" : "pass", title: { en: "Effect size", zh: "效应量" }, observed: `${main.label}: ${fixed(main.estimate!)}`, expected: `ratio between ${t.ratio_effect_warn_low} and ${t.ratio_effect_warn_high}`,
        message: large ? { en: "The effect is larger than most treatments achieve in trials; residual confounding (for example by illness severity) is the likely explanation until shown otherwise.", zh: "效应大于多数治疗在临床试验中的效果；在排除前，残余混杂（如病情严重度）是最可能的解释。" } : { en: "The effect size is within the range usually seen for treatments.", zh: "效应量在治疗效果的常见范围内。" } });
    }
    const severity = new RegExp(rules.severity_covariate_pattern, "iu");
    // A severity variable that takes one value for every patient (none recorded) adjusts for nothing.
    const adjusted = input.covariate_names.filter((name) => severity.test(name) && !constant.some(({ label }) => label.toLowerCase() === name.toLowerCase()));
    add({ check_id: "severity_adjustment", status: adjusted.length ? "pass" : "warn", title: { en: "Illness severity adjustment", zh: "病情严重度校正" }, observed: adjusted.length ? adjusted.join(", ") : "none", expected: "at least one severity measure (for example SOFA, vasopressors, ventilation, lactate)",
      message: adjusted.length ? { en: "The comparison is adjusted for illness severity.", zh: "比较已校正病情严重度。" } : { en: "The comparison is not adjusted for illness severity; sicker patients often receive different treatment, so the estimate can reflect severity rather than the treatment.", zh: "比较未校正病情严重度；病情较重者常接受不同治疗，估计可能反映病情而非治疗本身。" } });
  }

  // An association estimate whose interval spans two orders of magnitude (or is about zero or infinity) rests on too few patients to say anything.
  if (input.intent !== "treatment_effect" && input.intent !== "prediction") {
    const main = input.result?.estimates.find(({ measure, estimate }) => RATIO_MEASURES.has(measure) && estimate !== null && estimate >= 0);
    if (main && main.ci_low !== null && main.ci_high !== null) {
      const imprecise = main.ci_low > 0 && main.ci_high / main.ci_low > 100 || main.estimate! < 0.01 || main.estimate! > 100 || !(main.ci_high > main.ci_low);
      if (imprecise) add({ check_id: "effect_size_plausible", status: "fail", title: { en: "Precision of the estimate", zh: "估计的精确度" }, observed: `${main.label}: ${fixed(main.estimate!)} (${fixed(main.ci_low)}–${fixed(main.ci_high)})`, expected: "an interval narrower than a factor of 100",
        message: { en: "The interval is so wide that the estimate says nothing: too few patients carry the information.", zh: "区间宽到估计没有意义：携带信息的患者太少。" } });
    }
  }

  // A prediction describes only the patients who have every predictor, which can be a small and sicker part of the cohort.
  if (input.intent === "prediction" && input.result && input.result.n_input > 0) {
    const share = input.result.n_analysed / input.result.n_input;
    add({ check_id: "prediction_coverage", status: share < 0.5 ? "warn" : "pass", title: { en: "Who the model describes", zh: "模型适用的患者" }, observed: `${count(input.result.n_analysed)} of ${count(input.result.n_input)} patients have every predictor (${percent(share)})`, expected: "at least 50% of the cohort have every predictor",
      message: share < 0.5 ? { en: "Only patients with every predictor were used. They are a minority of the cohort and are usually sicker, so the performance does not apply to the other patients.", zh: "只用了每个预测因子都有记录的患者。他们只是队列的少数，通常病情更重，所得性能不适用于其他患者。" } : { en: "Most of the cohort has every predictor.", zh: "队列中大多数患者有全部预测因子。" } });
  }

  // Each characteristic of a description is described among the patients in whom it is recorded; many missing values mean it
  // describes those patients, not the whole cohort.
  if (input.description) {
    const described = input.profile.filter(({ role }) => role === "characteristic");
    const sparse = described.filter(({ n, missing }) => n + missing > 0 && missing / (n + missing) > t.complete_case_loss_warn);
    if (described.length) add({ check_id: "characteristics_recorded", status: sparse.length ? "warn" : "pass", title: { en: "Characteristics recorded", zh: "特征记录情况" },
      observed: sparse.length ? sparse.map(({ label, n, missing }) => `${label}: ${percent(n / (n + missing))} recorded`).join("; ") : `${described.length} characteristics`, expected: `each recorded for at least ${percent(1 - t.complete_case_loss_warn)} of patients`,
      message: sparse.length ? { en: "Some characteristics are recorded for few patients; each is described among the patients in whom it was recorded, who may differ from the cohort.", zh: "部分特征只在少数患者中有记录；这些特征仅在有记录的患者中描述，他们可能与整个队列不同。" }
        : { en: "Every characteristic is recorded for most patients.", zh: "每个特征在大多数患者中均有记录。" } });
  }

  // A diagnosis code carries no date, so an outcome defined by one may already have been present before the exposure.
  const outcomeSource = input.mapping.find(({ role, characteristic }) => role === "outcome" && !characteristic)?.selected?.table;
  if (outcomeSource === "mimiciv_hosp.diagnoses_icd" && input.outcome_structure !== "continuous") add({ check_id: "outcome_timing", status: "warn", title: { en: "Outcome timing", zh: "结局发生时间" }, observed: "diagnosis code of the same admission", expected: "a dated event after the exposure window",
    message: input.intent === "prediction"
      ? { en: "The outcome is a diagnosis code recorded on the admission, which carries no date, so it may already have been present when the predictors were measured, and a predictor may be part of how the diagnosis was made (creatinine and kidney injury). The performance can be overstated; it does not show the outcome was predicted in advance.", zh: "结局是住院记录中的诊断编码，没有发生日期，可能在测量预测因子时就已存在；预测因子也可能本身就是诊断依据（如肌酐与肾损伤）。性能可能被高估，不能说明结局是提前预测出来的。" }
      : { en: "The outcome is a diagnosis code recorded on the admission, which carries no date, so it may have been present before the exposure. Read the result as an association with that diagnosis, not as the effect of the exposure on a new event.", zh: "结局是住院记录中的诊断编码，没有发生日期，可能在暴露之前就已存在。请把结果理解为与该诊断的关联，而不是暴露对新发事件的效应。" } });

  // Mapping transparency: variables still awaiting confirmation.
  const unconfirmed = input.mapping.filter(({ status }) => status === "needs_confirmation");
  if (unconfirmed.length) add({ check_id: "mapping_confirmed", status: "warn", title: { en: "Variable definitions", zh: "变量定义" }, observed: unconfirmed.map(({ requested_term }) => requested_term).join(", "), expected: "every variable resolved to a confirmed MIMIC-IV definition",
    message: { en: "Some variable definitions were chosen automatically and still need a clinician's confirmation.", zh: "部分变量定义为自动选择，仍需临床确认。" } });

  const status: CheckStatus = checks.some(({ status }) => status === "fail") ? "fail" : checks.some(({ status }) => status === "warn") ? "warn" : "pass";
  return { rules_version: rules.rules_version, status, checks };
};
