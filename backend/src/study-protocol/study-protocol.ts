import { restateWindows, type StudySpec, type TimeWindow } from "../research-design/index.js";

/**
 * Target-trial protocol of one analysis plan: the trial that would answer the question, element by element, and how
 * MIMIC-IV emulates each element. Design checks name the places where the emulation departs from that trial.
 * Pure and deterministic: built from the compiled StudySpec, so the page a user confirms is what will run.
 */

export const STUDY_PROTOCOL_VERSION = "1.2.0";

export interface LocalizedText { en: string; zh: string }
export interface ProtocolElement { key: "eligibility" | "treatment" | "comparator" | "time_zero" | "outcome" | "follow_up" | "confounders" | "analysis"; label: LocalizedText; emulation: string; emulation_zh?: string }
export interface DesignCheck { check_id: string; status: "pass" | "warn"; message: LocalizedText }
export interface StudyProtocol { protocol_version: string; elements: ProtocolElement[]; design_checks: DesignCheck[] }

export interface ProtocolInput {
  study_spec: StudySpec;
  /** Stated comparator, or "absence" / "active" / "unspecified". */
  comparator?: { kind: "absence" | "active" | "unspecified"; text?: string };
  /** Other listed levels when one level is compared with the others. */
  active_comparator_levels?: string[];
  exposure_level?: string;
  analysis_label?: string;
  analysis_label_zh?: string;
  /** Follow-up starts this many hours after time zero; units that end before it are not eligible. */
  landmark_hours?: number;
  /** Adjustment variables not in the model: switched off for this plan, or the exposure itself, a part of it or a mediator. */
  excluded_covariates?: string[];
  /** A description emulates no trial: it is protocolled as who is described, by which grouping, and which characteristics. */
  description?: boolean;
}

const HOURS: Record<string, number> = { minute: 1 / 60, hour: 1, day: 24, week: 168, month: 730.5, year: 8766 };
const describeWindow = (window: TimeWindow | undefined): string => {
  if (!window) return "–";
  if (!("end_offset" in window)) return "from time zero to the end of the index encounter";
  return `${window.start_offset}–${window.end_offset} ${window.unit}(s) after time zero`;
};
const UNIT_ZH: Record<string, string> = { minute: "分钟", hour: "小时", day: "天", week: "周", month: "个月", year: "年" };
const describeWindowZh = (window: TimeWindow): string => "end_offset" in window ? `时间零点后 ${window.start_offset}–${window.end_offset} ${UNIT_ZH[window.unit] ?? window.unit}内` : "时间零点至本次住院结束期间";
const startHours = (window: TimeWindow): number => "start_offset" in window ? window.start_offset * (HOURS[window.unit] ?? 1) : 0;
const endHours = (window: TimeWindow): number | undefined => "end_offset" in window ? window.end_offset * (HOURS[window.unit] ?? 1) : undefined;

/** The protocol of a description: no treatment, comparator, outcome or adjustment, so no trial-emulation checks. */
const descriptionProtocol = (input: ProtocolInput): StudyProtocol => {
  const spec = input.study_spec;
  const grouping = spec.exposure_or_predictors?.find(({ role }) => role === "exposure");
  const outcomeWindow = spec.time_windows?.find(({ purpose }) => purpose === "outcome");
  const overStay = (spec.characteristics ?? []).filter(({ role }) => role === "outcome").map(({ name }) => name);
  const icu = /icu/iu.test(spec.index_time?.selection_rule ?? "");
  const listed = (spec.characteristics ?? []).map(({ name }) => name);
  // Baseline characteristics and a yes/no grouping are read over the baseline (exposure) window the plan runs with.
  const baselineWindow = spec.time_windows?.find(({ purpose }) => purpose === "baseline") ?? spec.time_windows?.find(({ purpose }) => purpose === "exposure");
  const readHours = baselineWindow ? endHours(baselineWindow) ?? 24 : 24;
  const population = spec.population?.description ? restateWindows(spec.population.description, spec.time_windows) : undefined;
  const elements: ProtocolElement[] = [
    { key: "eligibility", label: { en: "Who is described", zh: "描述的人群" }, emulation: `${population ?? "all adult patients in MIMIC-IV"}; ${spec.index_time?.selection_rule ?? "first admission per patient"}`, emulation_zh: `${population ?? "MIMIC-IV 全部成年患者"}；${icu ? "每位患者首次 ICU 入住" : "每位患者首次住院"}` },
    { key: "treatment", label: { en: "Grouping", zh: "分组" }, emulation: grouping ? `${grouping.name}: ${restateWindows(grouping.operational_definition, spec.time_windows)}` : "none (the whole cohort)", emulation_zh: grouping ? `${grouping.name}：${grouping.contrast?.kind === "binary_presence" ? `时间零点后 ${readHours} 小时内有 ${grouping.name} 记录（是/否）` : `按 ${grouping.name} 分组`}` : "无（整个队列）" },
    { key: "time_zero", label: { en: "Time zero", zh: "时间零点" }, emulation: spec.index_time?.event ?? "–", emulation_zh: /icu/iu.test(spec.index_time?.event ?? "") ? "入 ICU" : spec.index_time ? "入院" : "–" },
    { key: "outcome", label: { en: "Characteristics described", zh: "描述的特征" }, emulation: listed.join(", ") || "–", emulation_zh: listed.join("、") || "–" },
    { key: "follow_up", label: { en: "When each is read", zh: "读取时间" }, emulation: `baseline characteristics ${baselineWindow ? describeWindow(baselineWindow) : "0–24 hour(s) after time zero"}${overStay.length ? `; ${overStay.join(", ")} ${describeWindow(outcomeWindow)}` : ""}`, emulation_zh: `基线特征：${baselineWindow ? describeWindowZh(baselineWindow) : "时间零点后 0–24 小时内"}${overStay.length && outcomeWindow ? `；${overStay.join("、")}：${describeWindowZh(outcomeWindow)}` : ""}` },
    { key: "confounders", label: { en: "Also in Table 1 (not adjusted for)", zh: "基线表另列（不做校正）" }, emulation: (spec.covariates ?? []).map(({ name }) => name).join(", ") || "none", emulation_zh: (spec.covariates ?? []).map(({ name }) => name).join("、") || "无" },
    { key: "analysis", label: { en: "Analysis", zh: "分析方法" }, emulation: input.analysis_label ?? "description", emulation_zh: input.analysis_label_zh ?? input.analysis_label ?? "描述" },
  ];
  return { protocol_version: STUDY_PROTOCOL_VERSION, elements, design_checks: [] };
};

export const buildStudyProtocol = (input: ProtocolInput): StudyProtocol => {
  if (input.description) return descriptionProtocol(input);
  const spec = input.study_spec;
  const window = (purpose: TimeWindow["purpose"]) => spec.time_windows?.find((candidate) => candidate.purpose === purpose);
  const exposure = spec.exposure_or_predictors?.find(({ role }) => role === "exposure");
  const exposureWindow = window("exposure"); const outcomeWindow = window("outcome"); const baselineWindow = window("baseline"); const followUpWindow = window("follow_up");
  const comparator = input.active_comparator_levels?.length
    ? `patients receiving ${input.active_comparator_levels.join(", ")} but not ${input.exposure_level ?? exposure?.name ?? "the exposure"} (active comparator)`
    : input.comparator?.text ?? (input.comparator?.kind === "absence" ? `patients without ${exposure?.name ?? "the exposure"} in the exposure window` : "–");
  const derived = spec.outcome?.derivation;
  // A prediction of a timed event is made when its predictor window ends; the extractor excludes units discharged, dead or
  // with the outcome before then (local-execution-graph-runner), so the outcome is counted only after it.
  const predictionHours = !exposure && spec.intent_family === "prediction" && spec.outcome?.contrast?.kind === "binary_presence" && !derived && baselineWindow ? endHours(baselineWindow) : undefined;
  // An ICU-indexed unit is the ICU stay, so it must still be in the ICU when follow-up starts; a timed event outcome recorded
  // before then (in the same admission) excludes it, as at the prediction time.
  const icuIndex = /icu/iu.test(spec.index_time?.event ?? "");
  const exposureHours = exposureWindow && startHours(exposureWindow) === 0 ? endHours(exposureWindow) : undefined;
  const population = spec.population?.description ? restateWindows(spec.population.description, spec.time_windows) : undefined;
  const eventOutcome = spec.outcome?.contrast?.kind === "binary_presence" && !derived;
  const still = icuIndex ? { en: "still in the ICU", zh: "仍在 ICU" } : { en: "still in hospital", zh: "仍在院" };
  const elements: ProtocolElement[] = [
    { key: "eligibility", label: { en: "Who is eligible", zh: "纳入人群" }, emulation: `${population ?? "all adult patients in MIMIC-IV"}; ${spec.index_time?.selection_rule ?? "first admission per patient"}${input.landmark_hours ? `; ${still.en}${eventOutcome ? " and without the outcome" : ""} ${input.landmark_hours} hours after time zero` : ""}${predictionHours ? `; ${still.en} and without the outcome ${predictionHours} hours after time zero (prediction time)` : ""}` },
    { key: "treatment", label: { en: "Treatment compared", zh: "比较的治疗" }, emulation: exposure ? `${exposure.name}: ${restateWindows(exposure.operational_definition, spec.time_windows)}` : "not applicable" },
    { key: "comparator", label: { en: "Comparison group", zh: "对照组" }, emulation: exposure ? comparator : "not applicable" },
    { key: "time_zero", label: { en: "Time zero", zh: "时间零点" }, emulation: spec.index_time?.event ?? "–" },
    { key: "outcome", label: { en: "Outcome", zh: "结局" }, emulation: spec.outcome ? `${spec.outcome.name}: ${restateWindows(spec.outcome.operational_definition, spec.time_windows)}` : "–" },
    { key: "follow_up", label: { en: "Follow-up", zh: "随访" }, emulation: derived ? `baseline ${describeWindow(baselineWindow)}; follow-up ${describeWindow(followUpWindow)}` : `${input.landmark_hours ? `outcomes counted from ${input.landmark_hours} hours after time zero (landmark); ` : ""}${predictionHours ? `outcome counted from ${predictionHours} hours after time zero (prediction time); ` : ""}${describeWindow(outcomeWindow)}` },
    { key: "confounders", label: { en: "Adjusted for (what randomisation would balance)", zh: "校正变量（随机化本应平衡的因素）" }, emulation: (spec.covariates ?? []).filter(({ name }) => !(input.excluded_covariates ?? []).some((off) => off.toLowerCase() === name.toLowerCase())).map(({ name }) => name).join(", ") || "none" },
    { key: "analysis", label: { en: "Analysis", zh: "分析方法" }, emulation: input.analysis_label ?? spec.analysis_family ?? "–" },
  ];

  // Chinese wording of the same elements (variable names stay as the library defines them).
  const AGG_ZH: Record<string, string> = { maximum: "最高", minimum: "最低", mean: "平均", first: "首次", last: "末次", sum: "累计", median: "中位" };
  const exposureZh = exposure ? (exposure.contrast?.kind === "binary_presence" ? `时间零点后 ${exposureHours ?? 24} 小时内有 ${exposure.name} 记录` : `时间零点后 ${exposureHours ?? 24} 小时内的${AGG_ZH[exposure.aggregation ?? ""] ?? ""} ${exposure.name}`) : "不适用";
  const comparatorZh = !exposure ? "不适用" : input.active_comparator_levels?.length ? `使用${input.active_comparator_levels.join("、")}但未使用${input.exposure_level ?? exposure.name}者（阳性对照）`
    : input.comparator?.text ?? (input.comparator?.kind === "absence" ? `暴露窗内未使用 ${exposure.name} 者` : "–");
  const threshold = spec.outcome?.contrast?.kind === "threshold" ? spec.outcome.contrast : undefined;
  const outcomeZh = !spec.outcome ? "–" : derived ? `${spec.outcome.name}（随访期均值减基线均值）` : threshold ? `${spec.outcome.name} ${({ gt: ">", gte: "≥", lt: "<", lte: "≤" })[threshold.operator]} ${threshold.value}${threshold.unit === "day" ? " 天" : threshold.unit ? ` ${threshold.unit}` : ""}（是否达到）`
    : spec.outcome_structure === "time_to_event" ? `${spec.outcome.name}（发生时间）` : spec.outcome_structure === "binary" ? `${spec.outcome.name}（是否发生）` : `${spec.outcome.name}（数值）`;
  const kept = (spec.covariates ?? []).filter(({ name }) => !(input.excluded_covariates ?? []).some((off) => off.toLowerCase() === name.toLowerCase())).map(({ name }) => name);
  const zh: Record<ProtocolElement["key"], string> = {
    eligibility: `${population ?? "MIMIC-IV 全部成年患者"}；${/icu/iu.test(spec.index_time?.selection_rule ?? "") ? "每位患者首次 ICU 入住" : "每位患者首次住院"}${input.landmark_hours ? `；时间零点后 ${input.landmark_hours} 小时${still.zh}${eventOutcome ? "且尚未发生结局" : ""}` : ""}${predictionHours ? `；时间零点后 ${predictionHours} 小时（预测时间点）${still.zh}且尚未发生结局` : ""}`,
    treatment: exposure ? `${exposure.name}：${exposureZh}` : exposureZh,
    comparator: comparatorZh,
    time_zero: /icu/iu.test(spec.index_time?.event ?? "") ? "入 ICU" : spec.index_time ? "入院" : "–",
    outcome: outcomeZh,
    follow_up: derived ? `基线：${baselineWindow ? describeWindowZh(baselineWindow) : "–"}；随访：${followUpWindow ? describeWindowZh(followUpWindow) : "–"}` : `${input.landmark_hours ? `时间零点后 ${input.landmark_hours} 小时起计算结局（界标）；` : ""}${predictionHours ? `时间零点后 ${predictionHours} 小时（预测时间点）起计算结局；` : ""}${outcomeWindow ? describeWindowZh(outcomeWindow) : "–"}`,
    confounders: kept.join("、") || "无",
    analysis: input.analysis_label_zh ?? input.analysis_label ?? spec.analysis_family ?? "–",
  };
  for (const element of elements) element.emulation_zh = zh[element.key];

  const checks: DesignCheck[] = [];
  const event = spec.outcome_structure === "binary" || spec.outcome_structure === "time_to_event";
  if (exposure && exposureWindow && outcomeWindow && event) {
    const exposureEnd = endHours(exposureWindow) ?? 0;
    const early = Math.max(startHours(outcomeWindow), input.landmark_hours ?? 0) < exposureEnd;
    checks.push(early
      ? { check_id: "outcome_after_exposure", status: "warn", message: {
          en: `Outcomes are counted from time zero while exposure is assessed over ${describeWindow(exposureWindow)}. Patients who have the outcome early have less time to be exposed, which makes the treatment look better (immortal-time bias). Starting follow-up at the end of the exposure window (a landmark) would avoid it.`,
          zh: `结局从时间零点开始计数，而暴露在${describeWindowZh(exposureWindow)}评估。早期发生结局的患者暴露机会更少，会使治疗看起来更有效（不死时间偏倚）。从暴露窗结束时开始随访（界标设计）可避免该问题。` } }
      : { check_id: "outcome_after_exposure", status: "pass", message: { en: "Outcomes are counted only after the exposure window closes.", zh: "结局仅在暴露窗结束后计数。" } });
  }
  if (predictionHours && baselineWindow) {
    checks.push({ check_id: "outcome_after_prediction_time", status: "pass", message: {
      en: `Predictions are made at ${predictionHours} hours after time zero, when the predictor window (${describeWindow(baselineWindow)}) ends. ${icuIndex ? "ICU stays that ended before then (transfer out of the ICU, discharge or death)" : "Patients discharged or dead before then"}, and those with the outcome already recorded then (earlier in the same admission included), are excluded and the outcome is counted only after it, so an outcome that happens while the predictors are measured, or was already present, is never predicted.`,
      zh: `预测时间点为预测因子窗口（${describeWindowZh(baselineWindow)}）结束时，即时间零点后 ${predictionHours} 小时。此前${icuIndex ? " ICU 入住已结束（转出 ICU、出院或死亡）" : "已出院或死亡"}、或此前（包括同次住院更早时）已记录结局的患者不纳入，结局仅在此后计数，因此不会“预测”在测量预测因子期间已发生或已存在的结局。` } });
  }
  if (exposure && derived && exposureWindow && baselineWindow) {
    const overlap = startHours(baselineWindow) < (endHours(exposureWindow) ?? 0);
    checks.push(overlap
      ? { check_id: "baseline_before_exposure", status: "warn", message: { en: `The baseline measurement window (${describeWindow(baselineWindow)}) overlaps the exposure window, so part of the treatment effect may already be in the baseline and the change is underestimated.`, zh: "基线测量窗与暴露窗重叠，部分治疗效应可能已计入基线，变化量会被低估。" } }
      : { check_id: "baseline_before_exposure", status: "pass", message: { en: "The baseline is measured before exposure starts.", zh: "基线在暴露开始前测量。" } });
  }
  if (exposure) {
    const kind = input.active_comparator_levels?.length ? "active" : input.comparator?.kind;
    checks.push(kind === "active"
      ? { check_id: "comparator", status: "pass", message: { en: "The comparison group receives another treatment (active comparator), which reduces confounding by indication.", zh: "对照组接受其他治疗（阳性对照），可减少适应证混杂。" } }
      : kind === "absence"
        ? { check_id: "comparator", status: "warn", message: { en: "The comparison group is patients without the treatment; untreated patients often differ in why they were not treated (confounding by indication). An active comparator is preferable when one exists.", zh: "对照组为未接受该治疗的患者；未治疗者往往因病情等原因而不同（适应证混杂）。如有可比治疗，阳性对照更佳。" } }
        : { check_id: "comparator", status: "warn", message: { en: "No comparison group was stated.", zh: "未说明对照组。" } });
    checks.push({ check_id: "new_users", status: "warn", message: { en: "Exposure is read from in-hospital records; medications taken before admission are recorded only partly (emergency-department medication reconciliation), so patients continuing a home medication and patients starting it are mixed.", zh: "暴露取自住院期间记录；入院前用药仅部分记录（急诊用药核对），因此持续使用者与新起始使用者混在一起。" } });
  }
  return { protocol_version: STUDY_PROTOCOL_VERSION, elements, design_checks: checks };
};
