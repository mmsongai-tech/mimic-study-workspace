import { restateWindows } from "../research-design/index.js";
import { restateAssumptions } from "../study-framing/index.js";
import { patientFlow } from "./patient-flow.js";
import { notReliablyEstimable, planHeadline } from "../question-pipeline/index.js";
import type { CovariateNotModelled, PlanOutcome, QuestionRunResult } from "../question-pipeline/index.js";
import { assumptionText, buildDemographicNames, buildLabeler, characteristicDefinition, checkText, covariateList, estimateLabel, exposureDefinition, figureCaption, localizeNames, mappingStatusLabel, outcomeDefinition, roleLabel, tableCaption, timeZeroText, variableLabel, warningText, type ZhLabeler } from "./chinese-rendering.js";

export type ReportLanguage = "zh" | "en";
export type ReportBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; caption?: string; columns: string[]; rows: string[][] }
  | { kind: "figure"; path: string; caption: string };
export interface ReportDocument { language: ReportLanguage; title: string; blocks: ReportBlock[] }

const T = {
  title: { zh: "MIMIC-IV 研究报告", en: "MIMIC-IV Study Report" },
  question: { zh: "研究问题", en: "Research question" },
  summary: { zh: "结论摘要", en: "Summary" },
  design: { zh: "研究设计", en: "Study design" },
  mapping: { zh: "变量与 MIMIC-IV 数据映射", en: "Variables and MIMIC-IV data mapping" },
  cohort: { zh: "研究队列", en: "Cohort" },
  methods: { zh: "统计方法（三种可选方案）", en: "Statistical methods (three options)" },
  results: { zh: "结果", en: "Results" },
  table1: { zh: "表 1 基线特征", en: "Table 1. Baseline characteristics" },
  diagnostics: { zh: "诊断与稳健性", en: "Diagnostics and robustness" },
  warnings: { zh: "注意事项", en: "Cautions" },
  blocked: { zh: "未能完成的分析及原因", en: "Analyses that could not be completed" },
  unanswered: { zh: "未能分析的部分", en: "Parts that could not be analysed" },
  assumptions: { zh: "默认设定与假设", en: "Defaults and assumptions" },
  reproducibility: { zh: "可重复性信息", en: "Reproducibility" },
  limitations: { zh: "局限性", en: "Limitations" },
  checks: { zh: "结果自动核查", en: "Result checks" },
  // pilot-1: report notices. Fixed wording set by the owner, printed under the title of every report in every format.
  notice: {
    zh: "研究原型：结果未经临床审核或外部验证，仅为观察性关联，不能作为临床决策依据；结果来自 MIMIC-IV，只能与持有 PhysioNet 授权的人员分享。",
    en: "Research prototype: results have not been reviewed by clinicians or validated externally; they are observational associations, not a basis for clinical decisions. Results come from MIMIC-IV and may be shared only with people who hold PhysioNet credentialed access.",
  },
} as const;

const zhLang = (language: ReportLanguage): boolean => language === "zh";
const CHECK_STATUS: Record<string, { zh: string; en: string }> = { pass: { zh: "通过", en: "pass" }, warn: { zh: "警告", en: "warning" }, fail: { zh: "未通过", en: "fail" } };
/** What a result cannot be read as, generated from the plan's own checks and data sources so no number appears without its limits. */
const readingLimits = (plan: PlanOutcome, language: ReportLanguage): string[] => {
  const zh = language === "zh"; const limits: string[] = [];
  const failed = plan.quality?.checks.filter(({ status }) => status === "fail") ?? [];
  const statusOf = (id: string) => plan.quality?.checks.find(({ check_id }) => check_id === id)?.status;
  if (failed.length) limits.push(zh ? "该估计未通过核查，不应作为结果引用。" : "This estimate failed a check and should not be quoted as a result.");
  // A description sizes no effect: it is limited by who is in the data and how each characteristic is recorded.
  if (plan.chosen_method?.startsWith("descriptive.")) {
    limits.push(zh ? "这是对一家医院（MIMIC-IV）患者的描述，未做任何校正；组间差异不是效应，也不能推广到其他人群。" : "This describes patients of one hospital (MIMIC-IV) without any adjustment; a difference between groups is not an effect and may not hold in other populations.");
    if (statusOf("characteristics_recorded") === "warn") limits.push(zh ? "部分特征只在有记录的患者中描述，他们可能与整个队列不同。" : "Some characteristics are described only among the patients in whom they were recorded, who may differ from the cohort.");
    const icuOnly = (plan.mapping ?? []).some(({ selected }) => selected && /mimiciv_icu\.(chartevents|outputevents)$/u.test(selected.table));
    if (icuOnly) limits.push(zh ? "部分特征只在 ICU 记录，只描述有 ICU 记录的患者。" : "Some characteristics are charted only in the ICU, so they describe patients with ICU records only.");
    return limits;
  }
  limits.push(plan.study_spec.intent_family === "prediction"
    ? (zh ? "这是内部验证的预测性能，没有外部或时间验证，也没有与现有评分比较；不能说明模型在其他医院或人群中同样有效。" : "This is internally validated prediction performance, with no external or temporal validation and no comparison with an existing score; it does not show the model works in other hospitals or populations.")
    : (zh ? "这是观察性数据中的关联，不是因果证明；未测量的混杂仍可能影响结果。" : "This is an association in observational data, not proof of causation; unmeasured confounding can still affect it."));
  if (statusOf("outcome_timing") === "warn") limits.push(zh ? "结局是没有日期的诊断编码，不能解读为对新发事件的效应或提前预测。" : "The outcome is an undated diagnosis code, so it cannot be read as an effect on a new event or as advance prediction.");
  const icu = (plan.mapping ?? []).some(({ selected }) => selected && /mimiciv_icu\.(chartevents|outputevents)$/u.test(selected.table));
  if (icu) limits.push(zh ? "相关变量只在 ICU 记录，结果只描述有 ICU 记录的患者，不代表全部住院患者。" : "A variable here is charted only in the ICU, so the result describes patients with ICU records, not all hospitalised patients.");
  if (statusOf("prediction_coverage") === "warn") limits.push(zh ? "模型只用了具有全部预测因子的少数患者，性能不适用于其他患者。" : "The model used only the minority of patients with every predictor, so its performance does not apply to the others.");
  if (statusOf("missing_data") === "warn" && statusOf("prediction_coverage") === undefined) limits.push(zh ? "较多患者因缺失被排除，结果可能与目标人群不同。" : "Many patients were excluded for missing values, so the result may differ from the target population.");
  if (statusOf("severity_adjustment") === "warn") limits.push(zh ? "没有校正病情严重度，病情重者更常用或更少用该药会影响结果。" : "Illness severity was not adjusted for; sicker patients being more or less likely to receive the drug affects the result.");
  const evalue = plan.result?.tables.sensitivity?.[0];
  if (evalue && typeof evalue.e_value === "number") limits.push(zh ? `E 值 ${evalue.e_value}：需要一个与暴露和结局的风险比关联各约 ${evalue.e_value} 倍的未测量混杂，才能完全解释该估计。` : `E-value ${evalue.e_value}: an unmeasured confounder associated with both exposure and outcome by a risk ratio of about ${evalue.e_value} would be needed to explain this estimate away.`);
  return limits;
};

/** One-line verdict of the automatic checks, shown next to every headline so no number appears without it. */
const checkVerdict = (plan: PlanOutcome, language: ReportLanguage): string => {
  const quality = plan.quality; const zh = language === "zh";
  if (!quality) return zh ? "（未进行自动核查）" : " (not checked)";
  const failed = quality.checks.filter(({ status }) => status === "fail"); const warned = quality.checks.filter(({ status }) => status === "warn");
  if (failed.length) return zh ? `（不可靠：${failed.map(({ title }) => title.zh).join("、")}未通过）` : ` (NOT RELIABLE: failed ${failed.map(({ title }) => title.en.toLowerCase()).join(", ")})`;
  if (warned.length) return zh ? `（${warned.length} 项警告：${warned.map(({ title }) => title.zh).join("、")}）` : ` (${warned.length} warning${warned.length > 1 ? "s" : ""}: ${warned.map(({ title }) => title.en.toLowerCase()).join(", ")})`;
  // Passing says the automatic rules found nothing; it is not a validation of the variables or the design.
  return zh ? `（自动核查 ${quality.checks.length} 项均通过，不代表变量选择一定正确）` : ` (all ${quality.checks.length} automatic checks passed; this does not confirm the variables were chosen correctly)`;
};

const MEASURE: Record<string, { zh: string; en: string }> = {
  odds_ratio: { zh: "比值比 OR", en: "Odds ratio" }, risk_ratio: { zh: "相对危险度 RR", en: "Risk ratio" }, rate_ratio: { zh: "率比", en: "Rate ratio" },
  hazard_ratio: { zh: "风险比 HR", en: "Hazard ratio" }, risk_difference: { zh: "风险差 RD", en: "Risk difference" }, mean_difference: { zh: "均值差", en: "Mean difference" },
  location_shift: { zh: "位置差（Hodges-Lehmann）", en: "Location shift (Hodges-Lehmann)" }, proportion: { zh: "比例", en: "Proportion" }, mean: { zh: "均值", en: "Mean" },
  auc: { zh: "AUC", en: "AUC" }, indirect_effect: { zh: "间接效应", en: "Indirect effect" }, direct_effect: { zh: "直接效应", en: "Direct effect" }, total_effect: { zh: "总效应", en: "Total effect" },
  proportion_mediated: { zh: "中介比例", en: "Proportion mediated" }, indirect_effect_product: { zh: "间接效应（系数乘积）", en: "Indirect effect (product)" },
  indirect_effect_difference: { zh: "间接效应（差值法）", en: "Indirect effect (difference)" }, test_statistic: { zh: "检验统计量", en: "Test statistic" }, logrank_chisq: { zh: "Log-rank 卡方", en: "Log-rank chi-square" },
};
const STUDY_TYPE: Record<string, { zh: string; en: string }> = {
  descriptive: { zh: "描述性研究", en: "Descriptive study" }, group_comparison: { zh: "组间比较", en: "Group comparison" }, association: { zh: "关联性研究", en: "Association study" },
  treatment_effect: { zh: "治疗效果研究", en: "Treatment effect study" }, time_to_event: { zh: "生存分析", en: "Time-to-event study" }, longitudinal_change: { zh: "纵向变化研究", en: "Longitudinal change study" },
  dose_response: { zh: "剂量-反应研究", en: "Dose-response study" }, effect_modification: { zh: "效应修饰研究", en: "Effect modification study" }, mediation: { zh: "中介分析", en: "Mediation study" }, prediction: { zh: "预测模型研究", en: "Prediction study" },
};
const STATUS: Record<PlanOutcome["status"], { zh: string; en: string }> = { completed: { zh: "已完成", en: "completed" }, blocked: { zh: "已阻止", en: "blocked" }, failed: { zh: "失败", en: "failed" } };

const percent = (value: number | null | undefined): string => value === null || value === undefined || !Number.isFinite(value) ? "–" : `${(value * 100).toFixed(1)}%`;
const number = (value: number | null | undefined, digits = 3): string => value === null || value === undefined || !Number.isFinite(value) ? "–" : Math.abs(value) >= 1000 ? value.toFixed(0) : value.toPrecision(digits);
const pValue = (value: number | null | undefined): string => value === null || value === undefined || !Number.isFinite(value) ? "–" : value < 0.001 ? "<0.001" : value.toFixed(3);
const cell = (value: unknown): string => value === null || value === undefined ? "–" : typeof value === "number" ? number(value) : String(value);

const planTitle = (plan: PlanOutcome, result: QuestionRunResult, language: ReportLanguage): string => {
  const frame = result.frame_set.frames.find(({ frame_id }) => frame_id === plan.frame_id);
  const type = frame ? STUDY_TYPE[frame.study_type]![language] : "";
  return `${plan.plan_id} · ${type} · ${frame?.sub_question ?? plan.study_spec.research_question ?? ""}${plan.exposure_level ? ` [${plan.exposure_level}]` : ""}`;
};

const headline = (plan: PlanOutcome, language: ReportLanguage, labeler?: ZhLabeler): string => {
  if (notReliablyEstimable(plan)) {
    const sparse = plan.result?.estimates.find(({ term }) => term === "exposure_firth");
    const extra = sparse ? (language === "zh" ? ` 稀疏数据校正（Firth）估计：OR ${number(sparse.estimate)}（95% CI ${number(sparse.ci_low)}–${number(sparse.ci_high)}），区间很宽，只能作粗略参考。` : ` Sparse-data (Firth) estimate: OR ${number(sparse.estimate)} (95% CI ${number(sparse.ci_low)}–${number(sparse.ci_high)}); the interval is wide and only a rough guide.`) : "";
    return (language === "zh" ? "无法可靠估计（某一组患者或结局事件过少，或模型失效），通常方法的数值不作为结果报告。" : "Not reliably estimable (a group or the outcome events are too few, or the model failed); the usual estimate is not reported as a result.") + extra;
  }
  const zh = language === "zh";
  const label = (row: { label: string }) => labeler && zh ? estimateLabel(row.label, labeler) : row.label;
  const sized = (row: { measure: string; estimate: number | null; ci_low: number | null; ci_high: number | null }) =>
    `${MEASURE[row.measure]?.[language] ?? row.measure} ${number(row.estimate)}${row.ci_low !== null && row.ci_high !== null ? ` (95% CI ${number(row.ci_low)}–${number(row.ci_high)})` : ""}`;
  const headed = planHeadline(plan);
  if (headed.kind === "description") {
    const shown = (row: { measure: string; estimate: number | null; ci_low: number | null; ci_high: number | null }) => row.measure === "proportion"
      ? `${percent(row.estimate)}${row.ci_low !== null && row.ci_high !== null ? ` (95% CI ${percent(row.ci_low)}–${percent(row.ci_high)})` : ""}`
      : `${number(row.estimate)}${row.ci_low !== null && row.ci_high !== null ? ` (95% CI ${number(row.ci_low)}–${number(row.ci_high)})` : ""}`;
    const patients = plan.cohort?.rows ?? plan.result?.n_input ?? 0;
    const rows = headed.estimates.slice(0, 6).map((row) => `${label({ label: row.label.replace(/ \(overall\)$/u, "") })} ${shown(row)}`);
    const more = headed.estimates.length > 6 ? (zh ? `；另 ${headed.estimates.length - 6} 项见下表` : `; ${headed.estimates.length - 6} more below`) : "";
    return zh ? `共 ${patients.toLocaleString("en-US")} 例患者${rows.length ? `：${rows.join("；")}${more}` : ""}。` : `${patients.toLocaleString("en-US")} patients${rows.length ? `: ${rows.join("; ")}${more}` : ""}.`;
  }
  if (headed.kind === "prediction") {
    if (!headed.auc) return zh ? "无主要估计值。" : "No primary estimate.";
    return `${zh ? "测试集" : "Test-set"} ${sized(headed.auc)}${headed.baseline ? zh ? `；仅背景变量模型 AUC ${number(headed.baseline.estimate)}` : `; background-only model AUC ${number(headed.baseline.estimate)}` : ""}.`;
  }
  const main = headed.estimate;
  // An effect-modification analysis is answered by its interaction test; the estimate shown with it is one subgroup's.
  const interaction = headed.kind === "modification" ? (zh ? `效应差异检验 P ${pValue(headed.p_interaction)}；` : `P for difference in effect ${pValue(headed.p_interaction)}; `) : "";
  if (!main) return interaction ? interaction.replace(/[；;] ?$/u, ".") : zh ? "无主要估计值。" : "No primary estimate.";
  return `${interaction}${label(main)}: ${sized(main)}${main.p_value !== null ? `, P ${pValue(main.p_value)}` : ""}.`;
};

/** The stated comparator; for one listed exposure level without one, the other listed levels (active comparator). */
const comparatorText = (plan: PlanOutcome, frame: QuestionRunResult["frame_set"]["frames"][number] | undefined, zh: boolean): string => {
  if (frame?.comparator?.text) return frame.comparator.text;
  if (frame?.comparator?.kind === "absence") return zh ? "未暴露者" : "unexposed patients";
  const others = plan.exposure_level ? (frame?.exposure?.categories ?? []).filter((level) => level !== plan.exposure_level) : [];
  return others.length ? (zh ? `使用${others.join("、")}但未使用${plan.exposure_level}者` : `patients receiving ${others.join(", ")} but not ${plan.exposure_level}`) : "–";
};

/** An English definition with the windows the plan ran with (the Chinese report reads the windows themselves). */
const definitionEn = (variable: { name: string; operational_definition: string }, spec: PlanOutcome["study_spec"]): string => `${variable.name}: ${restateWindows(variable.operational_definition, spec.time_windows)}`;

const LEFT_OUT: Record<CovariateNotModelled["reason"], { zh: string; en: string }> = {
  switched_off: { zh: "未选用", en: "switched off" }, exposure: { zh: "即暴露本身", en: "the exposure itself" }, predictor: { zh: "已作为预测因子", en: "already a predictor" }, exposure_part: { zh: "暴露的组成部分", en: "part of the exposure" },
  mediator: { zh: "作为中介变量分析", en: "analysed as the mediator" }, not_mapped: { zh: "未在 MIMIC-IV 中找到", en: "not found in MIMIC-IV" }, other: { zh: "未纳入", en: "left out" },
};
/**
 * The adjustment variables the model received, then those of the study spec it did not, each with the reason. A prediction's
 * variables other than its predictors form the background-only comparison model, so the left-out ones are named for that model.
 */
const adjustmentText = (covariates: PlanOutcome["study_spec"]["covariates"], notModelled: CovariateNotModelled[] | undefined, zh: boolean, labeler: ReturnType<typeof buildLabeler>, prediction = false): string => {
  if (!covariates?.length) return "–";
  const reasonOf = (name: string) => notModelled?.find((left) => left.name.toLowerCase() === name.toLowerCase())?.reason;
  const used = covariates.filter(({ name }) => !reasonOf(name)); const unused = covariates.filter(({ name }) => reasonOf(name));
  const list = zh ? (used.length ? covariateList(used, labeler) : "无") : used.map(({ name }) => name).join(", ") || "none";
  if (!unused.length) return list;
  const header = prediction ? { zh: "未纳入对照模型", en: "not in the comparison model" } : { zh: "未纳入模型", en: "not in the model" };
  return zh ? `${list}（${header.zh}：${unused.map((variable) => `${covariateList([variable], labeler)}，${LEFT_OUT[reasonOf(variable.name)!].zh}`).join("；")}）`
    : `${list} (${header.en}: ${unused.map(({ name }) => `${name}, ${LEFT_OUT[reasonOf(name)!].en}`).join("; ")})`;
};

const planBlocks = (plan: PlanOutcome, result: QuestionRunResult, language: ReportLanguage): ReportBlock[] => {
  const zh = language === "zh";
  const blocks: ReportBlock[] = [{ kind: "heading", level: 2, text: planTitle(plan, result, language) }];
  const spec = plan.study_spec;
  const labeler = buildLabeler(result.frame_set.frames);
  const demographic = buildDemographicNames(result.frame_set.frames);
  const frame = result.frame_set.frames.find(({ frame_id }) => frame_id === plan.frame_id);
  blocks.push({ kind: "heading", level: 3, text: T.design[language] });
  // A description has a grouping instead of an exposure and comparator, characteristics instead of an outcome, and Table 1 variables instead of adjustment.
  if (frame?.study_type === "descriptive") blocks.push({ kind: "table", columns: zh ? ["要素", "定义"] : ["Element", "Definition"], rows: [
    [zh ? "人群" : "Population", spec.population?.description ? restateWindows(spec.population.description, spec.time_windows) : (zh ? "MIMIC-IV 全部成年患者" : "all adult patients in MIMIC-IV")],
    [zh ? "分组" : "Grouping", zh ? spec.exposure_or_predictors?.map((variable) => exposureDefinition(variable, spec, labeler, demographic)).join("；") || "无（整个队列）" : spec.exposure_or_predictors?.map((variable) => definitionEn(variable, spec)).join("; ") || "none (the whole cohort)"],
    [zh ? "描述的特征" : "Characteristics described", zh ? (spec.characteristics ?? []).map((variable) => characteristicDefinition(variable, spec, labeler, demographic)).join("；") || "–" : (spec.characteristics ?? []).map((variable) => definitionEn(variable, spec)).join("; ") || "–"],
    [zh ? "时间零点" : "Time zero", spec.index_time ? (zh ? timeZeroText(spec.index_time) : `${spec.index_time.event} (${spec.index_time.selection_rule})`) : "–"],
    [zh ? "基线表另列" : "Also in Table 1", zh ? covariateList(spec.covariates, labeler) : spec.covariates?.map(({ name }) => name).join(", ") || "–"],
  ] });
  else blocks.push({ kind: "table", columns: zh ? ["要素", "定义"] : ["Element", "Definition"], rows: [
    [zh ? "人群" : "Population", spec.population?.description ? restateWindows(spec.population.description, spec.time_windows) : "–"],
    [zh ? "暴露" : "Exposure", zh ? spec.exposure_or_predictors?.map((variable) => exposureDefinition(variable, spec, labeler, demographic)).join("；") || "–" : spec.exposure_or_predictors?.map((variable) => definitionEn(variable, spec)).join("; ") || "–"],
    [zh ? "对照" : "Comparator", comparatorText(plan, frame, zh)],
    [zh ? "结局" : "Outcome", spec.outcome ? (zh ? outcomeDefinition(spec.outcome, spec, labeler) : definitionEn(spec.outcome, spec)) : "–"],
    [zh ? "时间零点" : "Time zero", spec.index_time ? (zh ? timeZeroText(spec.index_time) : `${spec.index_time.event} (${spec.index_time.selection_rule})`) : "–"],
    // A prediction model has predictors only; its other variables form the background-only comparison model.
    [spec.intent_family === "prediction" ? (zh ? "背景变量（对照模型）" : "Background variables (comparison model)") : (zh ? "校正变量" : "Adjustment"), adjustmentText(spec.covariates, plan.covariates_not_modelled, zh, labeler, spec.intent_family === "prediction")],
  ] });
  if (plan.protocol) {
    blocks.push({ kind: "table", caption: zh ? `目标试验方案（${plan.protocol.protocol_version}）：理想试验要素及其 MIMIC-IV 模拟` : `Target-trial protocol (${plan.protocol.protocol_version}): each element of the ideal trial and how MIMIC-IV emulates it`,
      columns: zh ? ["试验要素", "MIMIC-IV 模拟方式"] : ["Trial element", "How MIMIC-IV emulates it"], rows: plan.protocol.elements.map(({ label, emulation, emulation_zh }) => [label[language], zh && emulation_zh ? localizeNames(emulation_zh, [...(spec.exposure_or_predictors ?? []), ...(spec.outcome ? [spec.outcome] : []), ...(spec.covariates ?? []), ...(spec.characteristics ?? [])].map(({ name }) => name), labeler) : emulation]) });
    if (plan.protocol.design_checks.length) blocks.push({ kind: "paragraph", text: zh ? "设计核查：" : "Design checks:" }, { kind: "list", items: plan.protocol.design_checks.map(({ status, message }) => `${CHECK_STATUS[status]![language]}: ${message[language]}`) });
  }
  if (plan.method_note) blocks.push({ kind: "paragraph", text: plan.method_note[language] });
  for (const note of plan.design_notes ?? []) blocks.push({ kind: "paragraph", text: note[language] });
  for (const exclusion of plan.score_exclusions ?? []) blocks.push({ kind: "paragraph", text: zh
    ? `${exclusion.variable}中去除了与暴露“${exclusion.because_of}”重叠的组别（${exclusion.removed_groups.join("、")}），避免用暴露本身校正暴露。`
    : `${exclusion.variable} excludes the groups that overlap the exposure “${exclusion.because_of}” (${exclusion.removed_groups.join(", ")}), so the exposure is not adjusted for itself.` });
  // The sentences say the windows the plan ran with, also for a plan compiled before they were restated (study-framing).
  const assumptions = restateAssumptions(spec).assumptions ?? [];
  if (assumptions.length) { blocks.push({ kind: "paragraph", text: `${T.assumptions[language]}:` }, { kind: "list", items: zh ? assumptions.map((sentence) => assumptionText(sentence, labeler)) : assumptions }); }

  if (plan.mapping?.length) {
    blocks.push({ kind: "heading", level: 3, text: T.mapping[language] });
    // The summary keeps at most 60 values; `identifiers` counts every code, item id and label the mapping executes.
    const shown = (selected: NonNullable<NonNullable<PlanOutcome["mapping"]>[number]["selected"]> | undefined): string => {
      const values = selected?.values; if (!values?.length) return "–";
      const total = Math.max(values.length, selected!.identifiers);
      return `${values.slice(0, 12).join(", ")}${total > 12 ? (zh ? ` 等 ${total} 项` : ` … (${total} total)`) : ""}`;
    };
    blocks.push({ kind: "table", columns: zh ? ["角色", "研究变量", "状态", "MIMIC-IV 来源", "使用的编码/字段"] : ["Role", "Study variable", "Status", "MIMIC-IV source", "Codes / fields used"],
      // A description's exposure slot is its grouping, and its characteristics are described, whatever role their mapping used.
      rows: plan.mapping.map((variable) => { const role = variable.characteristic ? "characteristic" : frame?.study_type === "descriptive" && variable.role === "exposure" ? "grouping" : variable.role; return [zh ? roleLabel(role) : role, zh ? variableLabel(variable.requested_term, labeler) : variable.requested_term, zh ? mappingStatusLabel(variable.status) : variable.status, variable.selected ? `${variable.selected.label} (${variable.selected.table})` : variable.candidates.map(({ label, table }) => `${label} (${table})?`).join("; ") || "–", shown(variable.selected)]; }) });
  }
  if (plan.cohort) {
    blocks.push({ kind: "heading", level: 3, text: T.cohort[language] });
    // The analysis unit is the patient's first eligible ICU stay or hospital admission, and the flow names it.
    const unit = spec.index_time?.event === "ICU admission" ? { zh: " ICU 入住", en: "ICU stay", plural: "ICU stays" } : spec.index_time ? { zh: "住院", en: "admission", plural: "admissions" } : undefined;
    const unitZh = unit?.zh ?? "住院"; const unitEn = unit?.en ?? "admission";
    const REASON: Record<string, { zh: string; en: string }> = {
      no_time_zero: { zh: "没有时间零点（例如没有 ICU 入住）", en: "no time zero (for example no ICU stay)" },
      ended_before_landmark: { zh: "在随访起点之前已出院或死亡", en: "discharged or died before the follow-up start" },
      outcome_before_landmark: { zh: "在随访起点之前已发生结局", en: "had the outcome before the follow-up start" },
      outcome_before_prediction_time: { zh: "在预测时间点之前已发生结局", en: "had the outcome before the prediction time" },
      not_in_population: { zh: "不属于目标人群", en: "not in the study population" },
      not_first_eligible_unit_of_patient: { zh: `同一患者的非首次符合条件${unitZh}`, en: `not the patient's first eligible ${unitEn}` },
      incomplete_required_variables: { zh: `首次符合条件的${unitZh}缺少暴露或结局（不以后续${unitZh}替代）`, en: `the first eligible ${unitEn} lacks the exposure or outcome (not replaced by a later one)` },
      incomplete_model_variables: { zh: "缺少校正变量", en: "missing adjustment variables" },
    };
    // A prediction has predictors, not an exposure and adjustment variables.
    if (plan.chosen_method?.startsWith("prediction.")) {
      REASON.incomplete_required_variables = { zh: `首次符合条件的${unitZh}在时间窗内没有任何预测因子或没有结局（不以后续${unitZh}替代）`, en: `the first eligible ${unitEn} has no predictor measured in the window or no outcome (not replaced by a later one)` };
      REASON.incomplete_model_variables = { zh: "缺少某个预测因子或背景变量", en: "missing a predictor or background variable" };
      REASON.ended_before_landmark = { zh: "在预测时间点之前已出院或死亡", en: "discharged or died before the prediction time" };
    }
    // An ICU stay ends when the patient leaves the ICU (to the ward, home or by death), and an outcome recorded on the ward
    // before it, in the same admission, was already there.
    if (spec.index_time?.event === "ICU admission") {
      const start = plan.chosen_method?.startsWith("prediction.") ? { zh: "预测时间点", en: "prediction time" } : { zh: "随访起点", en: "follow-up start" };
      REASON.ended_before_landmark = { zh: `ICU 入住在${start.zh}之前已结束（转出 ICU、出院或死亡）`, en: `the ICU stay ended before the ${start.en} (transfer out of the ICU, discharge or death)` };
      for (const key of ["outcome_before_landmark", "outcome_before_prediction_time"]) REASON[key] = { zh: `${REASON[key]!.zh}（包括同次住院入 ICU 之前）`, en: `${REASON[key]!.en} (including earlier in the same admission, before the ICU stay)` };
    }
    // Patient flow: each exclusion step in order, then the cohort, then the model's complete-case step and the patients it used.
    const count = (value: number): string => value.toLocaleString("en-US");
    const steps = patientFlow(plan.cohort).map(({ key, removed, remaining }) => zh ? `排除（${REASON[key]?.zh ?? key}）：${count(removed)} → 剩余 ${count(remaining)}` : `Excluded (${REASON[key]?.en ?? key}): ${count(removed)} → remaining ${count(remaining)}`);
    const modelRemoved = plan.cohort.exclusion_reasons?.incomplete_model_variables;
    const modelStep = modelRemoved ? [zh ? `排除（${REASON.incomplete_model_variables!.zh}）：${count(modelRemoved)}` : `Excluded (${REASON.incomplete_model_variables!.en}): ${count(modelRemoved)}`] : [];
    const analysed = plan.result?.status === "completed" && plan.result.n_analysed !== plan.cohort.rows ? [`${zh ? "模型实际纳入（完整数据）" : "Used by the model (complete data)"}: ${count(plan.result.n_analysed)}`] : [];
    blocks.push({ kind: "paragraph", text: zh ? "患者流程：" : "Patient flow:" }, { kind: "list", items: [
      `${zh ? `评估的分析单位（${unit ? unit.zh.trim() : "住院或 ICU 入住"}）` : `Analysis units assessed (${unit ? unit.plural : "admissions or ICU stays"})`}: ${count(plan.cohort.analysis_units)}`,
      ...steps,
      `${zh ? "进入队列" : "Cohort"}: ${count(plan.cohort.rows)}`,
      ...modelStep,
      ...analysed,
    ] });
  }
  if (plan.method_options?.length) {
    blocks.push({ kind: "heading", level: 3, text: T.methods[language] });
    blocks.push({ kind: "table", columns: zh ? ["方案", "方法", "适用情形", "是否可用"] : ["Option", "Method", "When preferred", "Available"],
      rows: plan.method_options.map((option, index) => [`${index === 0 ? (zh ? "推荐" : "Recommended") : `${zh ? "备选" : "Alternative"} ${index}`}${option.method_id === plan.chosen_method ? (zh ? "（已采用）" : " (used)") : ""}`, option.label[language], option.when_preferred[language], option.readiness.available ? (zh ? "是" : "yes") : option.readiness.reasons.map((reason) => reason[language]).join(" ")]) });
  }
  const run = plan.result;
  if (run && run.status === "completed") {
    blocks.push({ kind: "heading", level: 3, text: T.results[language] });
    blocks.push({ kind: "paragraph", text: `${headline(plan, language, labeler)}${checkVerdict(plan, language)}` });
    blocks.push({ kind: "paragraph", text: zh ? "解读边界：" : "How far to read it:" }, { kind: "list", items: readingLimits(plan, language) });
    if (plan.quality) blocks.push({ kind: "table", caption: `${T.checks[language]} (${zh ? "规则版本" : "rules"} ${plan.quality.rules_version})`, columns: zh ? ["结果", "核查项", "观察值", "标准", "含义"] : ["Result", "Check", "Observed", "Rule", "What it means"],
      rows: plan.quality.checks.map((check) => [CHECK_STATUS[check.status]![language], check.title[language], zh ? checkText(check.observed, labeler) : check.observed, zh ? checkText(check.expected, labeler) : check.expected, check.message[language]]) });
    blocks.push({ kind: "table", columns: zh ? ["估计", "指标", "估计值", "95% CI", "P 值"] : ["Estimate", "Measure", "Value", "95% CI", "P"],
      rows: run.estimates.map((row) => notReliablyEstimable(plan) && row.term !== "exposure_firth" ? [zh ? estimateLabel(row.label, labeler) : row.label, MEASURE[row.measure]?.[language] ?? row.measure, "–", "–", "–"] : [zh ? estimateLabel(row.label, labeler) : row.label, MEASURE[row.measure]?.[language] ?? row.measure, number(row.estimate), row.ci_low !== null && row.ci_high !== null ? `${number(row.ci_low)}–${number(row.ci_high)}` : "–", pValue(row.p_value)]) });
    const table1 = run.tables.table1;
    if (table1?.length) {
      const keys = Object.keys(table1[0]!);
      const header: Record<string, { zh: string; en: string }> = { variable: { zh: "变量", en: "Variable" }, overall: { zh: "总体", en: "Overall" }, exposed: { zh: "暴露组", en: "Exposed" }, unexposed: { zh: "非暴露组", en: "Unexposed" }, smd: { zh: "SMD", en: "SMD" }, missing: { zh: "缺失", en: "Missing" } };
      // A description's grouping columns are "<grouping> = <level>"; a yes/no grouping is shown as with and without it.
      if (frame?.study_type === "descriptive") {
        // A grouping named in English (an English question) reads "beta blockers：是 / 否" in Chinese, as its estimate rows do, not "有beta blockers".
        const grouping = estimateLabel(spec.exposure_or_predictors?.[0]?.name ?? "", labeler); const chinese = /\p{Script=Han}/u.test(grouping);
        header.exposed = { zh: chinese ? `有${grouping}` : `${grouping}：是`, en: `With ${spec.exposure_or_predictors?.[0]?.name ?? "the grouping"}` };
        header.unexposed = { zh: chinese ? `无${grouping}` : `${grouping}：否`, en: `Without ${spec.exposure_or_predictors?.[0]?.name ?? "the grouping"}` };
      }
      const columnName = (key: string): string => header[key]?.[language] ?? (zh ? estimateLabel(key, labeler) : key);
      blocks.push({ kind: "table", caption: `${T.table1[language]}${zh ? "（连续变量：均值(标准差); 中位数[四分位距]；分类变量：n(%)）" : " (continuous: mean (SD); median [IQR]; categorical: n (%))"}${frame?.study_type === "descriptive" ? (zh ? "；每个变量在有记录的患者中描述，缺失列为无记录人数" : "; each variable among the patients with a recorded value, the missing column counting the others") : ""}`, columns: keys.map(columnName), rows: table1.map((row) => keys.map((key) => key === "variable" && zh ? estimateLabel(cell(row[key]), labeler) : cell(row[key]))) });
    }
    const diagnostics = Object.entries(run.diagnostics).filter(([, value]) => typeof value === "number" || typeof value === "string");
    if (diagnostics.length) blocks.push({ kind: "heading", level: 3, text: T.diagnostics[language] }, { kind: "table", columns: zh ? ["诊断项", "值"] : ["Diagnostic", "Value"], rows: diagnostics.map(([key, value]) => [key, cell(value)]) });
    const evalues = run.tables.sensitivity;
    if (evalues?.length) blocks.push({ kind: "table", caption: zh ? "稳健性：E 值（未测量混杂要在风险比尺度上与暴露和结局各有多强的关联，才能把估计完全解释掉；E 值越大越稳健，区间 E 值为 1 表示区间已包含无效应）" : "Robustness: E-value (how strongly an unmeasured confounder would have to be associated with both exposure and outcome, on the risk-ratio scale, to explain the estimate away; a larger value is more robust, and an interval E-value of 1 means the interval already includes no effect)",
      columns: zh ? ["估计", "E 值（点估计）", "E 值（区间边界）"] : ["Estimate", "E-value (estimate)", "E-value (interval limit)"], rows: evalues.map((row) => [zh ? estimateLabel(cell(row.estimate), labeler) : cell(row.estimate), cell(row.e_value), cell(row.e_value_ci)]) });
    for (const table of ["balance", "number_at_risk", "median_survival", "selected_predictors"] as const) {
      const rows = run.tables[table];
      if (rows?.length) blocks.push({ kind: "table", caption: zh ? tableCaption(table) : table.replaceAll("_", " "), columns: Object.keys(rows[0]!), rows: rows.map((row) => Object.values(row).map(cell)) });
    }
    for (const figure of run.figures) blocks.push({ kind: "figure", path: `${run.output_dir}/${figure.file}`, caption: zh ? figureCaption(figure.title, labeler) : figure.title });
    if (run.warnings.length) blocks.push({ kind: "heading", level: 3, text: T.warnings[language] }, { kind: "list", items: zh ? run.warnings.map((warning) => warningText(warning, labeler)) : run.warnings });
  }
  if (plan.blockers.length) {
    blocks.push({ kind: "paragraph", text: `${zh ? "状态" : "Status"}: ${STATUS[plan.status][language]} (${plan.stage_reached})` }, { kind: "list", items: plan.blockers.map(({ message }) => message[language]) });
  }
  return blocks;
};

/** Builds one report document in one language from a question run; renderers only lay it out. */
export const buildReportDocument = (result: QuestionRunResult, language: ReportLanguage, limitations: string[] = []): ReportDocument => {
  const zh = language === "zh";
  const blocks: ReportBlock[] = [
    { kind: "heading", level: 1, text: T.title[language] },
    { kind: "paragraph", text: T.notice[language] },
    { kind: "paragraph", text: `${T.question[language]}: ${result.question}` },
    { kind: "heading", level: 2, text: T.summary[language] },
    { kind: "paragraph", text: zh
      ? `问题被分解为 ${result.summary.frames} 个研究目标、${result.summary.plans} 个分析计划：${result.summary.completed} 个已完成，${result.summary.blocked} 个被阻止，${result.summary.failed} 个失败，${result.summary.needs_clarification} 个目标未能分析。`
      : `The question was framed into ${result.summary.frames} aims and ${result.summary.plans} analysis plans: ${result.summary.completed} completed, ${result.summary.blocked} blocked, ${result.summary.failed} failed, and ${result.summary.needs_clarification} aims could not be analysed.` },
    { kind: "list", items: result.plans.map((plan) => `${planTitle(plan, result, language)} — ${STATUS[plan.status][language]}${plan.status === "completed" ? `: ${headline(plan, language, buildLabeler(result.frame_set.frames))}${checkVerdict(plan, language)}` : `: ${plan.blockers[0]?.message[language] ?? ""}`}`) },
  ];
  if (result.multiplicity) {
    // Counted over distinct analyses, like `analyses` (a result reported under two names is one analysis).
    const { significant_before: naive, significant_after: surviving } = result.multiplicity;
    const first = surviving > 0;
    blocks.push({ kind: "heading", level: 2, text: zh ? "多重比较" : "Multiple comparisons" }, { kind: "paragraph", text: zh
      ? `本问题共做了 ${result.multiplicity.analyses} 个带 P 值的分析。校正前 ${naive} 个 P<0.05，用 Holm 法校正后 ${surviving} 个仍 P<0.05${first ? "" : "（没有一个保留显著）"}。凡要写“有显著差异”，请以校正后的 P 值为准；各计划的校正后 P 值见复现信息。`
      : `This question ran ${result.multiplicity.analyses} analyses with a P value. ${naive} had P<0.05 before adjustment and ${surviving} still do after the Holm correction${first ? "" : " (none remains significant)"}. Judge “significant” on the adjusted P values, listed under reproducibility.` });
  }
  for (const plan of result.plans) blocks.push(...planBlocks(plan, result, language));
  if (result.unanswered_frames.length) {
    blocks.push({ kind: "heading", level: 2, text: T.unanswered[language] });
    for (const { frame, reasons } of result.unanswered_frames) blocks.push({ kind: "paragraph", text: `${frame.frame_id}: ${frame.sub_question}` }, { kind: "list", items: reasons.map((reason) => reason[language]) });
  }
  if (limitations.length) blocks.push({ kind: "heading", level: 2, text: T.limitations[language] }, { kind: "list", items: limitations });
  blocks.push({ kind: "heading", level: 2, text: T.reproducibility[language] }, { kind: "list", items: [
    `run_id: ${result.run_id}`, `created_at: ${result.created_at}`,
    ...(result.multiplicity ? result.multiplicity.adjusted.map(({ plan_id, p_value, p_adjusted }) => `${plan_id}: P ${pValue(p_value)} → Holm-adjusted P ${pValue(p_adjusted)}`) : []),
    ...(result.plan_lock ? [`plan_lock: ${result.plan_lock.lock_id} (${result.plan_lock.confirmed_by === "user" ? (zhLang(language) ? "用户确认" : "confirmed by the user") : (zhLang(language) ? "自动确认" : "confirmed automatically")}, ${result.plan_lock.locked_at})`] : []), `data: ${result.data_source.id} ${result.data_source.version}`,
    `model: ${result.versions.model}`, `study_spec_compiler: ${result.versions.study_spec_compiler}`, `method_registry: ${result.versions.method_registry}`,
    ...result.plans.flatMap((plan) => [plan.manifest ? `${plan.plan_id} manifest: ${plan.manifest.manifest_id}` : "", plan.cohort ? `${plan.plan_id} cohort: ${plan.cohort.cohort_integrity_id}` : "", plan.result ? `${plan.plan_id} method: ${plan.chosen_method} (library ${plan.result.method_library_version})` : ""]).filter(Boolean),
  ] });
  return { language, title: T.title[language], blocks };
};
